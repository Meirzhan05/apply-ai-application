import { newId } from "@/lib/crypto";
import {
  refreshBrowserSnapshot,
  submitBrowser,
  cancelBrowser,
} from "@/lib/browser-runner";
import { ApplicationEligibilityError, assertJobEligible } from "@/lib/application-policy";
import { sendActionNeeded } from "@/lib/email";
import { loadState, mutateState } from "@/lib/repository";
import { hasSubmissionApproval, setFormSnapshot, transition } from "@/lib/workflow";
import { validatePacket } from "@/lib/drafting";

import { assertAutonomous } from "@/lib/autonomous-policy";

export async function runSubmission({ userId, applicationId, submissionToken }: { userId: string; applicationId: string; submissionToken?: string }) {
    const claimed = await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (!target || target.status !== "submitting" || target.submissionWorkerClaimedAt || target.submissionAttemptedAt || (target.autonomousAuthorization ? !target.submissionDispatch?.token || target.submissionDispatch.token !== submissionToken : !hasSubmissionApproval(target))) return false;
      if (target.autonomousAuthorization) {
        try { assertAutonomous(target, current.profile, current.jobs.find((job) => job.id === target.jobId), "submit"); }
        catch (error) { transition(target, ["submitting"], "needs_user_action"); target.error = error instanceof Error ? error.message : "Automation blocked."; return false; }
      }
      target.submissionWorkerClaimedAt = new Date().toISOString();
      return true;
    });
    if (!claimed) {
      const blocked = (await loadState(userId)).applications.find((item) => item.id === applicationId && item.userId === userId);
      if (blocked?.autonomousAuthorization && blocked.status === "needs_user_action" && blocked.browserSessionId && !blocked.submissionAttemptedAt) {
        await cancelBrowser(blocked).catch(() => undefined);
        await mutateState(userId, (current) => { const app = current.applications.find((item) => item.id === applicationId); if (app?.status === "needs_user_action" && app.browserSessionId === blocked.browserSessionId) app.browserSessionId = app.browserConnectUrl = app.browserLiveUrl = undefined; });
      }
      return { skipped: true };
    }
    const state = await loadState(userId);
    const app = state.applications.find(
      (item) => item.id === applicationId && item.userId === userId,
    );
    if (!app || app.status !== "submitting") return { skipped: true };
    try {
      assertJobEligible(state.profile, state.jobs.find((job) => job.id === app.jobId) ?? app.jobSnapshot);
      if (!app.packet) throw new Error("The approved packet is unavailable.");
      validatePacket(state.profile, app.packet);
      if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((job) => job.id === app.jobId), "submit");
      const result = await submitBrowser(app, {
        ...(app.autonomousAuthorization ? { profile: state.profile, job: state.jobs.find((job) => job.id === app.jobId) } : {}),
        beforeAttempt: (baseline) => mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting" || !target.submissionWorkerClaimedAt || target.submissionAttemptedAt ||
              target.browserSessionId !== baseline.sessionId || target.form?.url !== baseline.targetUrl || target.form.hash !== app.form?.hash) return false;
          if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((job) => job.id === target.jobId), "submit");
          else { assertJobEligible(current.profile, current.jobs.find((job) => job.id === target.jobId) ?? target.jobSnapshot); if (!hasSubmissionApproval(target)) return false; }
          target.submissionAttemptedAt = baseline.attemptedAt;
          target.submissionVerification = baseline;
          return true;
        }),
      });
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
        if (result.confirmed) target.submissionVerification = undefined;
        else if (result.verification) target.submissionVerification = result.verification;
        else {
          target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          target.submissionVerification = undefined;
        }
        target.submissionAttemptedAt ??= app.submissionAttemptedAt;
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
      const latest = (await loadState(userId)).applications.find((item) => item.id === applicationId);
      if (!latest?.submissionAttemptedAt && (app.autonomousAuthorization || error instanceof ApplicationEligibilityError)) {
        await cancelBrowser(app).catch(() => undefined);
        await mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting") return;
          transition(target, ["submitting"], "needs_user_action");
          target.error = `${error instanceof Error ? error.message : "Automation blocked."} No submission was attempted.`;
          target.approvals = target.approvals.filter((approval) => approval.kind !== "submit");
          target.form = undefined;
          target.submissionStartedAt = target.submissionWorkerClaimedAt = undefined;
          target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Submission paused", detail: target.error });
        });
        if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
          await sendActionNeeded(await loadState(userId), "A listing or required rule changed before submission").catch(() => undefined);
        return { blocked: true, reason: error instanceof Error ? error.message : "Automation blocked." };
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
          target.submissionAttemptedAt ??= app.submissionAttemptedAt;
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

}
