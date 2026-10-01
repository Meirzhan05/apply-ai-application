import type { AppState, Application } from "@/lib/types";
import { transition } from "@/lib/workflow";
import { expireApplicationBlocker, recordApplicationBlocker, recordReviewOnlyBlocker } from "@/lib/application-blockers";

export function recoverStaleRuns(state: AppState, now = Date.now()): Application[] {
  const closed: Application[] = [];
  for (const app of state.applications) {
    if (app.browserReleasePending) continue;
    const idle = now - new Date(app.updatedAt).getTime();
    const expired = app.browserSessionId && (app.browserSessionExpiresAt
      ? now >= new Date(app.browserSessionExpiresAt).getTime()
      : now - new Date(app.browserSessionCreatedAt || app.updatedAt).getTime() > 30 * 60 * 1000);
    if (!expired && app.browserQuestionRun && now - Date.parse(app.browserQuestionRun.startedAt) > 5 * 60 * 1000 && ["filling", "needs_user_action"].includes(app.status)) {
      app.browserQuestionRun = undefined;
      transition(app, ["filling", "needs_user_action"], "needs_user_action");
      app.approvals = app.approvals.filter((approval) => approval.kind !== "submit");
      app.error = "The agent paused while handling your answers. Your browser is saved; refresh the form before continuing.";
      continue;
    }
    if (expired && app.status === "awaiting_verification") {
      closed.push(structuredClone(app));
      const verification = app.submissionVerification;
      transition(app, ["awaiting_verification"], "uncertain");
      app.submissionVerification = app.submissionVerificationCheck = undefined;
      app.confirmation = "The verification browser expired before confirmation. Check the employer receipt; no automatic retry will occur.";
      if (app.autonomousAuthorization) recordReviewOnlyBlocker(app, "verification", app.confirmation, { sessionId: verification?.sessionId, targetUrl: app.form?.url });
    } else if (app.status === "submitting" && idle > 10 * 60 * 1000) {
      if (app.submissionAttemptedAt && app.submissionVerification && app.browserSessionId && !expired) {
        transition(app, ["submitting"], "awaiting_verification");
        app.error = "The worker stopped after claiming the existing attempt. Check its saved result; no additional Submit click is allowed.";
        continue;
      }
      closed.push(structuredClone(app));
      transition(app, ["submitting"], "uncertain");
      app.error = "The submit worker stopped before confirmation. Check the employer site; no automatic retry will occur.";
      if (app.autonomousAuthorization) recordReviewOnlyBlocker(app, "verification", app.error, { sessionId: app.submissionVerification?.sessionId, targetUrl: app.form?.url });
    } else if (expired && app.status === "uncertain" && app.submissionVerification) {
      closed.push(structuredClone(app));
      app.submissionVerification = app.submissionVerificationCheck = undefined;
      if (app.autonomousAuthorization) recordReviewOnlyBlocker(app, "verification", "The post-submit observation window expired. Review the saved employer receipt; no automatic retry will occur.", { sessionId: app.browserSessionId, targetUrl: app.form?.url });
    } else if (["drafting", "filling"].includes(app.status) && idle > (app.status === "drafting" ? 12 : 10) * 60 * 1000) {
      closed.push(structuredClone(app));
      const previous = app.status;
      transition(app, ["drafting", "filling"], app.autonomousAuthorization ? "needs_user_action" : previous === "drafting" ? (app.packet ? "draft_review" : "selected") : "authorized_to_fill");
      app.runDispatch = undefined;
      app.error = app.autonomousAuthorization ? "Automatic processing stopped. This request is blocked; no submission will be retried." : "The worker stopped before review. You can request a new run.";
      if (app.autonomousAuthorization) recordApplicationBlocker(app, "other", app.error, { packetHash: app.packetHash, targetUrl: app.jobSnapshot?.applyUrl });
    } else if (expired && ["final_review", "approved_to_submit", "needs_user_action"].includes(app.status)) {
      closed.push(structuredClone(app));
      transition(app, ["final_review", "approved_to_submit", "needs_user_action"], "needs_user_action");
      app.error = "The browser session expired. Start a fresh session and review its form again.";
      if (app.autonomousAuthorization) expireApplicationBlocker(app, app.error);
      app.approvals = app.approvals.filter((approval) => approval.kind !== "submit");
    } else continue;
    app.browserSessionId = app.browserConnectUrl = app.browserLiveUrl = undefined;
    app.browserQuestionRun = app.browserQuestionDrafts = undefined;
  }
  return closed;
}
