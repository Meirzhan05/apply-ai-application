import { newId } from "@/lib/crypto";
import { loadState, mutateState } from "@/lib/repository";
import { draftPacket, validatePacket } from "@/lib/drafting";
import { assertJobEligible } from "@/lib/application-policy";
import { cancelBrowser, prepareBrowser } from "@/lib/browser-runner";
import { sendActionNeeded } from "@/lib/email";
import { writeBrowserQuestionEssays } from "@/lib/browser-question-runs";
import { browserQuestions } from "@/lib/browser-questions";
import { formDigest, setFormSnapshot, setPacket, transition } from "@/lib/workflow";

export type RunPayload = { userId: string; applicationId: string; runToken?: string; draftMode?: "resume" | "essays" };

async function claimRun(userId: string, applicationId: string, runToken: string | undefined, status: "drafting" | "filling") {
  return mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app || app.status !== status || app.runToken !== runToken || app.runWorkerClaimedAt) return false;
    app.runWorkerClaimedAt = new Date().toISOString();
    app.updatedAt = app.runWorkerClaimedAt;
    return true;
  });
}

export async function runDraft({ userId, applicationId, runToken, draftMode }: RunPayload) {
  if (!(await claimRun(userId, applicationId, runToken, "drafting"))) return { skipped: true };
  const state = await loadState(userId);
  const app = state.applications.find((item) => item.id === applicationId);
  if (!app || app.userId !== userId || app.status !== "drafting" || app.runToken !== runToken) return { skipped: true };
  const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
  try {
    if (!job?.active) throw new Error("The job is closed or unavailable.");
    assertJobEligible(state.profile, job);
    const packet = await draftPacket(state.profile, job, app.packet, { resumeFormat: "latex", deadline: Date.now() + 540_000, preserveResume: Boolean(app.packet) && draftMode !== "resume", regenerateEssays: draftMode === "essays" || (Boolean(app.packet) && !draftMode) });
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "drafting" || target.runToken !== runToken) return;
      validatePacket(current.profile, packet);
      setPacket(current, target, packet);
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Packet ready", detail: packet.summary });
    });
    if (process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), "An application packet is ready for review").catch(() => undefined);
    return { drafted: true };
  } catch (error) {
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target?.status === "drafting" && target.runToken === runToken) {
        transition(target, ["drafting"], target.packet ? "draft_review" : "selected");
        target.error = error instanceof Error ? error.message : "Drafting failed.";
      }
    });
    throw error;
  }
}

export async function runFill({ userId, applicationId, runToken }: RunPayload) {
  if (!(await claimRun(userId, applicationId, runToken, "filling"))) return { skipped: true };
  const state = await loadState(userId);
  const app = state.applications.find((item) => item.id === applicationId);
  if (!app || app.userId !== userId || app.status !== "filling" || app.runToken !== runToken) return { skipped: true };
  const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
  let session: Awaited<ReturnType<typeof prepareBrowser>> | undefined;
  try {
    if (!job?.active || !app.packet) throw new Error("The job or approved packet is unavailable.");
    assertJobEligible(state.profile, job);
    validatePacket(state.profile, app.packet);
    session = await prepareBrowser(app, job, state.profile, async (opened) => mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      validatePacket(current.profile, target.packet!);
      target.browserSessionId = opened.sessionId;
      target.browserProvider = opened.provider;
      target.browserSessionExpiresAt = opened.expiresAt;
      target.browserCaptchaSolving = opened.captchaSolving;
      target.browserActions = [];
      target.browserConnectUrl = opened.connectUrl;
      target.browserLiveUrl = opened.liveUrl;
      target.browserSessionCreatedAt = new Date().toISOString();
      return true;
    }), async (label) => mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      target.browserActions = [...(target.browserActions || []), { at: new Date().toISOString(), label }].slice(-60);
      return true;
    }));
    const result = session;
    const saved = await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      validatePacket(current.profile, target.packet!);
      target.browserSessionId = result.sessionId;
      target.browserProvider = result.provider;
      target.browserSessionExpiresAt = result.expiresAt;
      target.browserCaptchaSolving = result.captchaSolving;
      target.browserSessionCreatedAt = app.runWorkerClaimedAt || app.updatedAt;
      target.browserConnectUrl = result.connectUrl;
      target.browserLiveUrl = result.liveUrl;
      target.needsCoverLetter = result.needsCoverLetter;
      if (result.needsAction) {
        target.form = { ...result.form, hash: formDigest(result.form) };
        transition(target, ["filling"], "needs_user_action");
      } else setFormSnapshot(target, result.form);
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: result.needsAction ? "Your input needed" : "Form ready for review", detail: job.title });
      return true;
    });
    if (!saved) {
      await cancelBrowser({ ...app, browserSessionId: result.sessionId, browserProvider: result.provider });
      return { cancelled: true };
    }
    if (browserQuestions({ ...result.form, hash: formDigest(result.form) }).some((question) => question.owner === "ai"))
      await writeBrowserQuestionEssays(userId, applicationId, formDigest(result.form)).catch(() => undefined);
    if (process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), session.needsAction ? "Your browser run needs your help" : "A filled application is ready for review").catch(() => undefined);
    return { needsAction: session.needsAction };
  } catch (error) {
    if (session) await cancelBrowser({ ...app, browserSessionId: session.sessionId, browserProvider: session.provider });
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target?.status === "filling" && target.runToken === runToken) {
        transition(target, ["filling"], "authorized_to_fill");
        target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
        target.error = error instanceof Error ? error.message : "Browser run failed.";
      }
    });
    throw error;
  }
}
