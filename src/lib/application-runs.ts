import { withModelUsageContext } from "@/lib/model-usage";
import { assertAutonomous, sealAutonomousPacket, unsupportedAutonomousForm } from "@/lib/autonomous-policy";
import { queueAutonomousSubmission, saveAutonomousSubmission } from "@/lib/autonomous-application";
import { newId } from "@/lib/crypto";
import { loadState, mutateState } from "@/lib/repository";
import { draftPacket, validatePacket } from "@/lib/drafting";
import { assertJobEligible } from "@/lib/application-policy";
import { cancelBrowser, prepareBrowser } from "@/lib/browser-runner";
import { sendActionNeeded } from "@/lib/email";
import { writeBrowserQuestionEssays } from "@/lib/browser-question-runs";
import { browserQuestions } from "@/lib/browser-questions";
import { recordBrowserUsageEvent, withBrowserUsageContext } from "@/lib/browser-usage";
import { formDigest, setFormSnapshot, setPacket, transition } from "@/lib/workflow";

export type RunPayload = { userId: string; applicationId: string; runToken?: string; draftMode?: "resume" | "essays" };

async function currentAutonomousRun(userId: string, applicationId: string, runToken: string | undefined, phase: "draft" | "fill") {
  await mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app || app.runToken !== runToken || app.status !== (phase === "draft" ? "drafting" : "filling")) throw new Error("The automatic run changed before provider work.");
    assertAutonomous(app, state.profile, state.jobs.find((job) => job.id === app.jobId), phase);
  });
}

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
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "draft");
    const beforeModelCall = app.autonomousAuthorization ? () => currentAutonomousRun(userId, applicationId, runToken, "draft") : undefined;
    if (beforeModelCall) await beforeModelCall();
    const packet = await withModelUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? newId() }, () => draftPacket(state.profile, job, app.packet, { resumeFormat: "latex", deadline: Date.now() + 540_000, beforeModelCall, knownAnswersOnly: Boolean(app.autonomousAuthorization), preserveResume: Boolean(app.packet) && draftMode !== "resume", regenerateEssays: draftMode === "essays" || (Boolean(app.packet) && !draftMode) }));
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "drafting" || target.runToken !== runToken) return;
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "draft");
      validatePacket(current.profile, packet);
      setPacket(current, target, packet);
      if (target.autonomousAuthorization) {
        sealAutonomousPacket(target);
        transition(target, ["draft_review"], "authorized_to_fill");
        target.queuedRun = { id: newId(), kind: "fill", requestedAt: new Date().toISOString(), reason: "waiting" };
      }
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Packet ready", detail: packet.summary });
    });
    if (app.autonomousAuthorization) await (await import("@/lib/application-queue")).queueApplicationRun(userId, applicationId, "fill");
    else if (process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), "An application packet is ready for review").catch(() => undefined);
    return { drafted: true };
  } catch (error) {
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target?.status === "drafting" && target.runToken === runToken) {
        transition(target, ["drafting"], target.autonomousAuthorization ? "needs_user_action" : target.packet ? "draft_review" : "selected");
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
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "fill");
    if (app.autonomousAuthorization) await currentAutonomousRun(userId, applicationId, runToken, "fill");
    session = await withBrowserUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => prepareBrowser(app, job, state.profile, async (opened) => mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
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
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
      target.browserActions = [...(target.browserActions || []), { at: new Date().toISOString(), label }].slice(-60);
      return true;
    })));
    const result = session;
    if (app.autonomousAuthorization && (result.needsCoverLetter || unsupportedAutonomousForm(result.form))) {
      result.needsAction = true;
      result.form.readyToSubmit = false;
      result.form.blockers = [...result.form.blockers || [], "This automatic workflow does not yet support cover letters or open-ended essays."];
    }
    const saved = await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
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
      } else {
        setFormSnapshot(target, result.form);
        if (target.autonomousAuthorization) saveAutonomousSubmission(current, target);
      }
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: result.needsAction ? "Your input needed" : target.autonomousAuthorization ? "Form ready" : "Form ready for review", detail: job.title });
      return true;
    });
    if (!saved) {
      await withBrowserUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => cancelBrowser({ ...app, browserSessionId: result.sessionId, browserProvider: result.provider }));
      return { cancelled: true };
    }
    if (app.autonomousAuthorization) {
      if (!result.needsAction) await queueAutonomousSubmission(userId, applicationId);
      else {
        await cancelBrowser({ ...app, browserSessionId: result.sessionId, browserProvider: result.provider }).catch(() => undefined);
        await mutateState(userId, (current) => { const target = current.applications.find((item) => item.id === applicationId); if (target?.status === "needs_user_action" && target.browserSessionId === result.sessionId) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined; });
      }
    } else if (browserQuestions({ ...result.form, hash: formDigest(result.form) }).some((question) => question.owner === "ai"))
      await writeBrowserQuestionEssays(userId, applicationId, formDigest(result.form)).catch(() => undefined);
    if (!app.autonomousAuthorization && process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), session.needsAction ? "Your browser run needs your help" : "A filled application is ready for review").catch(() => undefined);
    return { needsAction: session.needsAction };
  } catch (error) {
    await withBrowserUsageContext({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId() }, () => recordBrowserUsageEvent({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId(), provider: app.browserProvider ?? (process.env.BROWSER_PROVIDER === "browser-use" ? "browser-use" : "browserbase"), sessionId: session?.sessionId ?? null, event: "failed", report: null, failure: "allocation_failed", orphanedSessionId: null })).catch(() => undefined);
    if (session) await withBrowserUsageContext({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId() }, () => cancelBrowser({ ...app, browserSessionId: session!.sessionId, browserProvider: session!.provider }));
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target && target.runToken === runToken && (target.status === "filling" || (target.autonomousAuthorization && target.status === "final_review"))) {
        transition(target, [target.status], target.autonomousAuthorization ? "needs_user_action" : "authorized_to_fill");
        target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
        target.error = error instanceof Error ? error.message : "Browser run failed.";
      }
    });
    throw error;
  }
}
