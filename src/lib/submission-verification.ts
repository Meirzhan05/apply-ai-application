import { newId } from "@/lib/crypto";
import { cancelBrowser, checkBrowserSubmission } from "@/lib/browser-runner";
import { remoteBrowserStatus } from "@/lib/browser-provider";
import { mutateState } from "@/lib/repository";
import { transition } from "@/lib/workflow";
import { withBrowserUsageContext } from "@/lib/browser-usage";
import type { Application } from "@/lib/types";
import { recordReviewOnlyBlocker } from "@/lib/application-blockers";

function awaiting(app: Application | undefined, userId: string): asserts app is Application {
  if (!app || app.userId !== userId || !["awaiting_verification", "uncertain"].includes(app.status) || !app.submissionVerification ||
    app.browserSessionId !== app.submissionVerification.sessionId || app.submissionAttemptedAt !== app.submissionVerification.attemptedAt)
    throw new Error("No active verification belongs to this application.");
}

export async function checkSubmissionResult(userId: string, applicationId: string, stop = false): Promise<void> {
  const token = newId();
  const app = await mutateState(userId, (state) => {
    const target = state.applications.find(item => item.id === applicationId && item.userId === userId);
    awaiting(target, userId);
    if (target.submissionVerificationCheck && Date.now() - Date.parse(target.submissionVerificationCheck.startedAt) < 5 * 60_000)
      throw new Error("The result is already being checked. Please wait.");
    target.submissionVerificationCheck = { token, startedAt: new Date().toISOString() };
    return structuredClone(target);
  });
  try {
    const expired = Boolean(app.browserSessionExpiresAt && Date.parse(app.browserSessionExpiresAt) <= Date.now());
    const result = stop || expired ? undefined : await checkBrowserSubmission(app);
    let released = true;
    if (!result || !result.verification) {
      try { await cancelBrowser(app, { strict: true }); }
      catch { released = false; }
    }
    await mutateState(userId, (state) => {
      const target = state.applications.find(item => item.id === applicationId && item.userId === userId);
      awaiting(target, userId);
      if (target.submissionVerificationCheck?.token !== token || target.browserSessionId !== app.browserSessionId || target.submissionAttemptedAt !== app.submissionAttemptedAt)
        throw new Error("The verification changed while checking its result.");
      target.submissionVerificationCheck = undefined;
      target.error = undefined;
      if (result?.receipt) target.submissionReceipt = result.receipt;
      if (result?.confirmed) {
        transition(target, ["awaiting_verification", "uncertain"], "submitted");
        target.submittedAt = new Date().toISOString();
        target.confirmation = result.evidence;
        target.submissionVerification = undefined;
      } else if (result?.verification) {
        target.confirmation = result.evidence;
        target.updatedAt = new Date().toISOString();
        return;
      } else {
        transition(target, ["awaiting_verification", "uncertain"], "uncertain");
        target.confirmation = result?.evidence || (expired ? "The verification browser expired before confirmation. Check the employer receipt before taking further action." : "Verification was stopped before confirmation. Check the employer receipt before taking further action.");
        target.submissionVerification = undefined;
      }
      if (released) target.browserSessionId = target.browserLiveUrl = target.browserConnectUrl = undefined;
      else {
        target.browserReleasePending = { sessionId: app.browserSessionId!, requestedAt: new Date().toISOString(), attempts: 1, lastError: "The provider did not confirm the verification browser release." };
        recordReviewOnlyBlocker(target, "resource_hold", "The verification browser release is still pending. Review the saved receipt; no submission retry will occur.", { sessionId: app.browserSessionId, targetUrl: app.form?.url });
      }
      state.activity.unshift({ id: newId(), at: new Date().toISOString(), label: result?.confirmed ? "Submission confirmed" : "Verification ended", detail: target.confirmation! });
    });
  } catch {
    // A transient read failure does not authorize another Submit click or
    // destroy an otherwise active browser. Only a known stopped session ends it.
    const stopped = app.browserSessionId?.startsWith("local-") ? false : await withBrowserUsageContext({ userId, applicationId, jobId: app.jobId, runId: app.runToken ?? app.browserQuestionRun?.token ?? token }, () => remoteBrowserStatus(app)).then(status => status === "stopped").catch(() => false);
    await mutateState(userId, (state) => {
      const target = state.applications.find(item => item.id === applicationId && item.userId === userId);
      if (target?.submissionVerificationCheck?.token !== token) return;
      target.submissionVerificationCheck = undefined;
      target.error = "The result could not be checked. No additional Submit click was made.";
      if (stopped) {
        transition(target, ["awaiting_verification", "uncertain"], "uncertain");
        target.confirmation = "The verification browser ended before confirmation. Check the employer receipt before taking further action.";
        target.submissionVerification = undefined;
        target.browserSessionId = target.browserLiveUrl = target.browserConnectUrl = undefined;
      }
    });
    throw new Error(stopped ? "The browser ended before confirmation. The application will not be retried." : "Could not read the employer result. You can check again without resubmitting.");
  }
}
