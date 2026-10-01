import { prepareAutonomousFormEssays } from "@/lib/autonomous-essays";
import { withModelUsageContext } from "@/lib/model-usage";
import { assertAutonomous, assertAutonomousDestination, sealAutonomousPacket, unsupportedAutonomousForm } from "@/lib/autonomous-policy";
import { queueAutonomousSubmission, saveAutonomousSubmission } from "@/lib/autonomous-application";
import { hashJson, newId } from "@/lib/crypto";
import { loadState, mutateState } from "@/lib/repository";
import { draftPacket, validatePacket, withGroundedCoverLetter } from "@/lib/drafting";
import { ResumeDraftError } from "@/lib/resume-document";
import { assertJobEligible } from "@/lib/application-policy";
import { cancelBrowser, prepareBrowser } from "@/lib/browser-runner";
import { sendActionNeeded } from "@/lib/email";
import { writeBrowserQuestionEssays } from "@/lib/browser-question-runs";
import { browserQuestions } from "@/lib/browser-questions";
import { recordBrowserUsageEvent, withBrowserUsageContext } from "@/lib/browser-usage";
import { formDigest, setFormSnapshot, setPacket, transition } from "@/lib/workflow";
import { blockerReason, recordApplicationBlocker, resolveResumingApplicationBlockers } from "@/lib/application-blockers";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import type { Application } from "@/lib/types";

export type RunPayload = { userId: string; applicationId: string; runToken?: string; draftMode?: "resume" | "essays" };

async function releaseParkedBrowser(userId: string, application: Application, sessionId: string, provider: Application["browserProvider"]): Promise<boolean> {
  try {
    await cancelBrowser({ ...application, browserSessionId: sessionId, browserProvider: provider }, { strict: true });
  } catch (error) {
    await mutateState(userId, (state) => {
      const target = state.applications.find((item) => item.id === application.id && item.userId === userId);
      if (!target || target.browserSessionId !== sessionId) return;
      const timestamp = new Date().toISOString();
      target.browserReleasePending = {
        sessionId,
        requestedAt: target.browserReleasePending?.requestedAt ?? timestamp,
        attempts: (target.browserReleasePending?.attempts ?? 0) + 1,
        lastError: error instanceof Error ? error.message : "The provider did not confirm the browser release.",
      };
      recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The next application will wait until this session is stopped.", { sessionId, packetHash: target.packetHash, targetUrl: target.form?.url });
    });
    return false;
  }
  await mutateState(userId, (state) => {
    const target = state.applications.find((item) => item.id === application.id && item.userId === userId);
    if (target?.browserSessionId === sessionId) {
      target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
      target.browserReleasePending = undefined;
    }
  });
  return true;
}

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
    if (status === "drafting") app.resumeDraftDiagnostics = undefined;
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
    const eligibilityJob = importedAutonomyJob(app, job);
    assertJobEligible(state.profile, eligibilityJob);
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "draft");
    const beforeModelCall = app.autonomousAuthorization ? () => currentAutonomousRun(userId, applicationId, runToken, "draft") : undefined;
    if (beforeModelCall) await beforeModelCall();
    const packet = await withModelUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? newId() }, () => draftPacket(state.profile, eligibilityJob, app.packet, { resumeFormat: "latex", deadline: Date.now() + 540_000, beforeModelCall, knownAnswersOnly: Boolean(app.autonomousAuthorization), preserveResume: Boolean(app.packet) && draftMode !== "resume", regenerateEssays: draftMode === "essays" || (Boolean(app.packet) && !draftMode) }));
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "drafting" || target.runToken !== runToken) return;
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "draft");
      validatePacket(current.profile, packet);
      setPacket(current, target, packet);
      target.resumeDraftDiagnostics = undefined;
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
        if (error instanceof ResumeDraftError) target.resumeDraftDiagnostics = error.diagnostics;
        if (target.autonomousAuthorization) recordApplicationBlocker(target, error instanceof ResumeDraftError && error.diagnostics.outcome === "needs_information" ? "missing_answer" : blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: job?.applyUrl });
      }
    });
    if (app.autonomousAuthorization) await (await import("@/lib/application-queue")).dispatchUserQueue(userId).catch(() => undefined);
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
    const eligibilityJob = importedAutonomyJob(app, job);
    assertJobEligible(state.profile, eligibilityJob);
    validatePacket(state.profile, app.packet);
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "fill");
    if (app.autonomousAuthorization) await currentAutonomousRun(userId, applicationId, runToken, "fill");
    session = await withBrowserUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => prepareBrowser(app, job, state.profile, async (opened) => mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
      validatePacket(current.profile, target.packet!);
      app.browserSessionId = opened.sessionId;
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
      else validatePacket(current.profile, target.packet!);
      target.browserActions = [...(target.browserActions || []), { at: new Date().toISOString(), label }].slice(-60);
      return true;
    }), app.autonomousAuthorization ? async (observed) => {
      if (!observed.fields.some((field) => field.kind === "file" && field.required && /cover\s*letter/i.test(field.label))) throw new Error("The required cover-letter control changed.");
      assertAutonomousDestination(app, observed);
      if (state.profile.automationSettings!.coverLetterMode === "disabled") throw new Error("The employer requires a cover letter, but your cover-letter setting is disabled.");
      const packet = await withGroundedCoverLetter(state.profile, eligibilityJob, app.packet!, () => currentAutonomousRun(userId, applicationId, runToken, "fill"));
      await mutateState(userId, (current) => {
        const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
        if (!target || target.status !== "filling" || target.runToken !== runToken || target.packetHash !== app.packetHash) throw new Error("The application materials changed during letter preparation.");
        assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
        validatePacket(current.profile, packet);
        target.packet = packet; target.packetHash = hashJson(packet); target.form = undefined; target.autonomousAuthorization!.requiredCoverLetter = true; sealAutonomousPacket(target);
        current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Required cover letter prepared", detail: "Grounded in confirmed facts; continuing the same authorized browser session." });
      });
      app.packet = packet; app.packetHash = hashJson(packet); app.autonomousAuthorization!.requiredCoverLetter = true; sealAutonomousPacket(app);
      return packet;
    } : undefined, app.autonomousAuthorization ? async (observed) => {
      assertAutonomousDestination(app, observed);
      const packet = await withModelUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => prepareAutonomousFormEssays(state.profile, eligibilityJob, app, observed, () => currentAutonomousRun(userId, applicationId, runToken, "fill")));
      await mutateState(userId, (current) => {
        const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
        if (!target || target.status !== "filling" || target.runToken !== runToken || target.packetHash !== app.packetHash || target.browserSessionId !== app.browserSessionId) throw new Error("The form or materials changed during automatic essay preparation.");
        assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
        validatePacket(current.profile, packet);
        target.packet = packet; target.packetHash = hashJson(packet); target.form = undefined; sealAutonomousPacket(target);
        current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Essay prepared", detail: "Truthfully grounded; continuing the same authorized form." });
      });
      app.packet = packet; app.packetHash = hashJson(packet); sealAutonomousPacket(app);
      return packet;
    } : undefined));
    const result = session;
    if (app.autonomousAuthorization && (result.needsCoverLetter || unsupportedAutonomousForm(result.form, app))) {
      result.needsAction = true;
      result.form.readyToSubmit = false;
      result.form.blockers = [...result.form.blockers || [], result.needsCoverLetter ? "The employer requires a cover letter, but your saved cover-letter mode does not permit this attachment." : "An essay or required answer could not be grounded under the current authorization."];
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
        const messages = result.form.blockers?.length ? result.form.blockers : ["The employer form needs user action before automatic processing can continue."];
        const observedQuestions = browserQuestions(target.form);
        for (const message of messages) {
          const label = message.match(/(?:field|option for):\s*(.+)$/i)?.[1]?.trim();
          const observedQuestion = label ? observedQuestions.find((question) => question.label === label) : undefined;
          recordApplicationBlocker(target, blockerReason(message), message, {
          formHash: target.form.hash,
          packetHash: target.packetHash,
          targetUrl: target.form.url,
          sessionId: result.sessionId,
          fieldIdentifiers: target.form.fields.filter((field) => field.required && field.valid === false).map((field) => field.identifier || field.label),
            observedQuestion: observedQuestion ? {
              identifier: observedQuestion.identifier,
              label: observedQuestion.label,
              kind: observedQuestion.kind,
              options: observedQuestion.options,
              value: observedQuestion.value,
            } : undefined,
          });
        }
        transition(target, ["filling"], "needs_user_action");
      } else {
        setFormSnapshot(target, result.form);
        if (target.autonomousAuthorization) resolveResumingApplicationBlockers(target);
        if (target.autonomousAuthorization) saveAutonomousSubmission(current, target);
      }
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: result.needsAction ? "Your input needed" : target.autonomousAuthorization ? "Form ready" : "Form ready for review", detail: job.title });
      return true;
    });
    if (!saved) {
      let released = true;
      try {
        await withBrowserUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => cancelBrowser({ ...app, browserSessionId: result.sessionId, browserProvider: result.provider }, { strict: true }));
      } catch {
        released = false;
      }
      if (!released) {
        await mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || (target.browserSessionId && target.browserSessionId !== result.sessionId)) return;
          target.browserSessionId = result.sessionId;
          target.browserProvider = result.provider;
          target.browserReleasePending = { sessionId: result.sessionId, requestedAt: new Date().toISOString(), attempts: 1, lastError: "The provider did not confirm the browser release." };
          if (target.autonomousAuthorization) recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The cancelled run will remain held until this session is stopped.", { sessionId: result.sessionId, packetHash: target.packetHash, targetUrl: result.form.url });
        });
      }
      return { cancelled: true };
    }
    if (app.autonomousAuthorization) {
      if (!result.needsAction) await queueAutonomousSubmission(userId, applicationId);
      else {
        const released = await releaseParkedBrowser(userId, app, result.sessionId, result.provider);
        if (!released) return { needsAction: true, releasePending: true };
        // A parked blocker must not hold the owner's only provider slot. The
        // queue scanner can now start the next queued application.
        await (await import("@/lib/application-queue")).dispatchUserQueue(userId);
      }
    } else if (browserQuestions({ ...result.form, hash: formDigest(result.form) }).some((question) => question.owner === "ai"))
      await writeBrowserQuestionEssays(userId, applicationId, formDigest(result.form)).catch(() => undefined);
    if (!app.autonomousAuthorization && process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), session.needsAction ? "Your browser run needs your help" : "A filled application is ready for review").catch(() => undefined);
    return { needsAction: session.needsAction };
  } catch (error) {
    await withBrowserUsageContext({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId() }, () => recordBrowserUsageEvent({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId(), provider: app.browserProvider ?? (process.env.BROWSER_PROVIDER === "browser-use" ? "browser-use" : "browserbase"), sessionId: session?.sessionId ?? null, event: "failed", report: null, failure: "allocation_failed", orphanedSessionId: null })).catch(() => undefined);
    let released = true;
    const failedSessionId = session?.sessionId ?? app.browserSessionId;
    const failedProvider = session?.provider ?? app.browserProvider;
    if (failedSessionId) {
      try {
        await cancelBrowser({ ...app, browserSessionId: failedSessionId, browserProvider: failedProvider }, { strict: true });
      } catch {
        released = false;
      }
    }
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target && target.runToken === runToken && (target.status === "filling" || (target.autonomousAuthorization && target.status === "final_review"))) {
        transition(target, [target.status], target.autonomousAuthorization ? "needs_user_action" : "authorized_to_fill");
        target.error = error instanceof Error ? error.message : "Browser run failed.";
        if (target.autonomousAuthorization) {
          recordApplicationBlocker(target, blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: job?.applyUrl, sessionId: released ? undefined : failedSessionId });
          if (!released) recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The next application will wait until this session is stopped.", { sessionId: failedSessionId, packetHash: target.packetHash, targetUrl: target.form?.url });
          if (!released && failedSessionId) target.browserReleasePending = { sessionId: failedSessionId, requestedAt: new Date().toISOString(), attempts: 1, lastError: "The provider did not confirm the browser release." };
          if (released) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
        } else if (released) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
      }
    });
    if (app.autonomousAuthorization && !released) return { needsAction: true, releasePending: true };
    if (app.autonomousAuthorization) await (await import("@/lib/application-queue")).dispatchUserQueue(userId).catch(() => undefined);
    throw error;
  }
}
