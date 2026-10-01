import { runFill } from "../src/lib/application-runs";
import { task } from "@trigger.dev/sdk";
import { newId } from "../src/lib/crypto";
import {
  refreshBrowserSnapshot,
  submitBrowser,
  cancelBrowser,
} from "../src/lib/browser-runner";
import { ApplicationEligibilityError, assertJobEligible } from "../src/lib/application-policy";
import { sendActionNeeded } from "../src/lib/email";
import { loadState, mutateState } from "../src/lib/repository";
import { hasSubmissionApproval, setFormSnapshot, transition } from "../src/lib/workflow";
import { validatePacket } from "../src/lib/drafting";

type Payload = { userId: string; applicationId: string };

export const fillApplicationForm = task({
  id: "fill-application-form",
  retry: { maxAttempts: 1 },
  maxDuration: 300,
  run: runFill,
});

export const submitApplicationForm = task({
  id: "submit-application-form",
  retry: { maxAttempts: 1 },
  maxDuration: 300,
  run: async ({ userId, applicationId }: Payload) => {
    const claimed = await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (!target || target.status !== "submitting" || target.submissionWorkerClaimedAt || !hasSubmissionApproval(target)) return false;
      target.submissionWorkerClaimedAt = new Date().toISOString();
      return true;
    });
    if (!claimed) return { skipped: true };
    const state = await loadState(userId);
    const app = state.applications.find(
      (item) => item.id === applicationId && item.userId === userId,
    );
    if (!app || app.status !== "submitting") return { skipped: true };
    try {
      assertJobEligible(state.profile, state.jobs.find((job) => job.id === app.jobId) ?? app.jobSnapshot);
      if (!app.packet) throw new Error("The approved packet is unavailable.");
      validatePacket(state.profile, app.packet);
      const result = await submitBrowser(app);
      await mutateState(userId, (current) => {
        const target = current.applications.find(
          (item) => item.id === applicationId && item.userId === userId,
        );
        if (!target || target.status !== "submitting")
          throw new Error("Application state changed during submission.");
        transition(
          target,
          ["submitting"],
          result.confirmed ? "submitted" : result.verification ? "awaiting_verification" : "uncertain",
        );
        target.confirmation = result.evidence;
        target.submissionReceipt = result.receipt;
        target.submissionVerification = result.verification;
        target.submissionAttemptedAt = app.submissionAttemptedAt;
        if (result.confirmed) target.submittedAt = new Date().toISOString();
        current.activity.unshift({
          id: newId(),
          at: new Date().toISOString(),
          label: result.confirmed
            ? "Submission confirmed"
            : result.verification ? "Complete employer verification" : "Submission uncertain",
          detail: result.evidence,
        });
      });
      if (result.verification && process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
        await sendActionNeeded(await loadState(userId), "Complete employer verification in your saved browser").catch(() => undefined);
      return { confirmed: result.confirmed, awaitingVerification: Boolean(result.verification) };
    } catch (error) {
      if (error instanceof ApplicationEligibilityError && !app.submissionAttemptedAt) {
        await cancelBrowser(app).catch(() => undefined);
        await mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting") return;
          transition(target, ["submitting"], "needs_user_action");
          target.error = `${error.message} No submission was attempted.`;
          target.approvals = target.approvals.filter((approval) => approval.kind !== "submit");
          target.form = undefined;
          target.submissionStartedAt = target.submissionWorkerClaimedAt = undefined;
          target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Submission paused", detail: target.error });
        });
        if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
          await sendActionNeeded(await loadState(userId), "A listing or required rule changed before submission").catch(() => undefined);
        return { blocked: true, reason: error.message };
      }
      if (error instanceof Error && error.message === "FORM_CHANGED") {
        const form = await refreshBrowserSnapshot(app);
        await mutateState(userId, (current) => {
          const target = current.applications.find(
            (item) => item.id === applicationId && item.userId === userId,
          );
          if (!target || target.status !== "submitting") return;
          target.submissionStartedAt = undefined;
          target.submissionWorkerClaimedAt = undefined;
          setFormSnapshot(target, form);
          current.activity.unshift({
            id: newId(),
            at: new Date().toISOString(),
            label: "Form changed",
            detail: "Review and approve the current form again.",
          });
        });
        return { formChanged: true };
      }
      await mutateState(userId, (current) => {
        const target = current.applications.find(
          (item) => item.id === applicationId && item.userId === userId,
        );
        if (target?.status === "submitting") {
          transition(target, ["submitting"], "uncertain");
          target.error =
            error instanceof Error
              ? error.message
              : "Submission result unknown.";
          target.submissionAttemptedAt = app.submissionAttemptedAt;
          current.activity.unshift({
            id: newId(),
            at: new Date().toISOString(),
            label: "Submission needs review",
            detail: "No automatic retry will occur.",
          });
        }
      });
      if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
        await sendActionNeeded(
          await loadState(userId),
          "Check an uncertain application result",
        ).catch(() => undefined);
      throw error;
    }
  },
});
