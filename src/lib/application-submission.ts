import { hashJson, newId } from "@/lib/crypto";
import {
  refreshBrowserSnapshot,
  submitBrowser,
  cancelBrowser,
} from "@/lib/browser-runner";
import { ApplicationEligibilityError, assertJobEligible } from "@/lib/application-policy";
import { assertSourceJobCurrent } from "@/lib/resume-source-freshness";
import { sendActionNeeded } from "@/lib/email";
import { loadState, mutateState } from "@/lib/repository";
import { formDigest, hasSubmissionApproval, setFormSnapshot, transition } from "@/lib/workflow";
import { validatePacket } from "@/lib/drafting";
import { ApiPreparationError, submitApiApplication } from "@/lib/ats-application";

import { assertAutonomous, autonomyJobHash } from "@/lib/autonomous-policy";
import { blockerReason, recordApplicationBlocker } from "@/lib/application-blockers";
import type { Application } from "@/lib/types";

async function releaseSubmissionBrowser(userId: string, application: Application): Promise<boolean> {
  const sessionId = application.browserSessionId ?? application.browserReleasePending?.sessionId;
  if (!sessionId) return true;
  try {
    await cancelBrowser({ ...application, browserSessionId: sessionId }, { strict: true });
    return true;
  } catch (error) {
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === application.id && item.userId === userId);
      if (!target) return;
      target.browserSessionId = sessionId;
      target.browserProvider = application.browserProvider;
      target.browserReleasePending = {
        sessionId,
        requestedAt: target.browserReleasePending?.requestedAt ?? new Date().toISOString(),
        attempts: (target.browserReleasePending?.attempts ?? 0) + 1,
        lastError: error instanceof Error ? error.message : "The provider did not confirm the browser release.",
      };
      recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. This application remains held until the session is stopped.", { sessionId, packetHash: target.packetHash, targetUrl: target.form?.url });
    });
    return false;
  }
}

export async function runSubmission({ userId, applicationId, submissionToken }: { userId: string; applicationId: string; submissionToken?: string }) {
    const claimed = await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (!target || target.status !== "submitting" || target.submissionWorkerClaimedAt || target.submissionAttemptedAt || (target.autonomousAuthorization ? !target.submissionDispatch?.token || target.submissionDispatch.token !== submissionToken : !hasSubmissionApproval(target))) return false;
      if (target.autonomousAuthorization) {
        try { assertAutonomous(target, current.profile, current.jobs.find((job) => job.id === target.jobId), "submit"); }
        catch (error) {
          transition(target, ["submitting"], "needs_user_action");
          target.error = error instanceof Error ? error.message : "Automation blocked.";
          recordApplicationBlocker(target, blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: target.form?.url });
          return false;
        }
      }
      target.submissionWorkerClaimedAt = new Date().toISOString();
      return true;
    });
    if (!claimed) {
      const blocked = (await loadState(userId)).applications.find((item) => item.id === applicationId && item.userId === userId);
      if (blocked?.autonomousAuthorization && blocked.status === "needs_user_action" && blocked.browserSessionId && !blocked.submissionAttemptedAt) {
        const released = await releaseSubmissionBrowser(userId, blocked);
        if (released) await mutateState(userId, (current) => { const app = current.applications.find((item) => item.id === applicationId); if (app?.status === "needs_user_action" && app.browserSessionId === blocked.browserSessionId) app.browserSessionId = app.browserConnectUrl = app.browserLiveUrl = undefined; });
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
      assertSourceJobCurrent(app, state.jobs.find((job) => job.id === app.jobId) ?? app.jobSnapshot!);
      if (!app.packet) throw new Error("The approved packet is unavailable.");
      validatePacket(state.profile, app.packet);
      if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((job) => job.id === app.jobId), "submit");
      const result = app.form?.apiSubmission ? await submitApiApplication(app,
        state.jobs.find((job) => job.id === app.jobId) ?? app.jobSnapshot!, state.profile,
        (attemptedAt) => mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting" || !target.submissionWorkerClaimedAt || target.submissionAttemptedAt ||
            target.form?.hash !== app.form?.hash || target.packetHash !== app.packetHash || !target.form?.apiSubmission ||
            formDigest(target.form) !== app.form!.hash || hashJson(current.profile) !== hashJson(state.profile)) return false;
          const currentJob = current.jobs.find((job) => job.id === target.jobId) ?? target.jobSnapshot;
          assertJobEligible(current.profile, currentJob);
          assertSourceJobCurrent(target, currentJob!);
          const initialJob = state.jobs.find((job) => job.id === app.jobId) ?? app.jobSnapshot;
          if (!currentJob?.active || !initialJob || autonomyJobHash(currentJob) !== autonomyJobHash(initialJob)) return false;
          validatePacket(current.profile, target.packet!);
          if (target.autonomousAuthorization) assertAutonomous(target, current.profile, currentJob, "submit");
          else if (!hasSubmissionApproval(target)) return false;
          target.submissionMaterials = { resumeMode: target.packet!.resumeMode ?? "tailored", coverLetterMode: current.profile.automationSettings?.coverLetterMode,
            files: structuredClone(target.packet!.files ?? []), capturedAt: attemptedAt };
          target.submissionAttemptedAt = attemptedAt;
          if (target.jobSnapshot?.source === "imported") target.importedOutcome = { version: 1, kind: "attempted", at: attemptedAt,
            evidence: "The durable API submission attempt was saved.", synthetic: Boolean(target.controlledTest) };
          return true;
        })) : await submitBrowser(app, {
        ...(app.autonomousAuthorization ? { profile: state.profile, job: state.jobs.find((job) => job.id === app.jobId) } : {}),
        beforeAttempt: (baseline) => mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting" || !target.submissionWorkerClaimedAt || target.submissionAttemptedAt ||
              target.browserSessionId !== baseline.sessionId || target.form?.url !== baseline.targetUrl || target.form.hash !== app.form?.hash) return false;
          if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((job) => job.id === target.jobId), "submit");
          else { const currentJob = assertJobEligible(current.profile, current.jobs.find((job) => job.id === target.jobId) ?? target.jobSnapshot); assertSourceJobCurrent(target, currentJob); if (!hasSubmissionApproval(target)) return false; }
          target.submissionMaterials = { resumeMode: target.packet!.resumeMode ?? "tailored", coverLetterMode: current.profile.automationSettings?.coverLetterMode,
            files: structuredClone(target.packet!.files?.filter((file) => target.form?.fields.some((field) => field.fileHashes?.includes(`${file.filename}:${file.size}:${file.sha256}`))) ?? []), capturedAt: baseline.attemptedAt };
          target.submissionAttemptedAt = baseline.attemptedAt;
          target.submissionVerification = baseline;
          if (target.jobSnapshot?.source === "imported") target.importedOutcome = { version: 1, kind: "attempted", at: baseline.attemptedAt, evidence: "The durable pre-click attempt marker was saved.", synthetic: Boolean(target.controlledTest) };
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
        if (target.jobSnapshot?.source === "imported") target.importedOutcome = { version: 1, kind: result.confirmed ? "confirmed" : result.verification ? "attempted" : "uncertain", at: new Date().toISOString(), evidence: result.evidence, synthetic: Boolean(target.controlledTest) };
        if (result.confirmed) target.submissionVerification = undefined;
        else if (result.verification) target.submissionVerification = result.verification;
        else {
          if (app.browserReleasePending) {
            target.browserSessionId = app.browserSessionId;
            target.browserReleasePending = app.browserReleasePending;
          } else target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          target.submissionVerification = undefined;
        }
        if (app.browserReleasePending) {
          target.browserSessionId = app.browserSessionId;
          target.browserReleasePending = app.browserReleasePending;
          recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The submission result is preserved while this session remains held.", { sessionId: app.browserReleasePending.sessionId, packetHash: target.packetHash, targetUrl: target.form?.url });
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
      if (result.verification && !app.autonomousAuthorization && process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
        await sendActionNeeded(await loadState(userId), "Complete employer verification in your saved browser").catch(() => undefined);
      return { confirmed: result.confirmed, awaitingVerification: Boolean(result.verification) };
    } catch (error) {
      const latest = (await loadState(userId)).applications.find((item) => item.id === applicationId);
      if (error instanceof ApiPreparationError && !latest?.submissionAttemptedAt) {
        await mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting" || target.submissionAttemptedAt) return;
          transition(target, ["submitting"], target.autonomousAuthorization ? "needs_user_action" : "authorized_to_fill");
          target.form = undefined;
          target.approvals = target.approvals.filter((approval) => approval.kind !== "submit");
          target.submissionStartedAt = target.submissionWorkerClaimedAt = undefined;
          target.submissionDispatch = undefined;
          target.error = `${error.message} No application was sent.`;
          if (target.autonomousAuthorization) recordApplicationBlocker(target, "other", target.error, { packetHash: target.packetHash, targetUrl: target.jobSnapshot?.applyUrl });
        });
        return { formChanged: true };
      }
      if (error instanceof Error && error.message === "FORM_CHANGED") {
        const form = await refreshBrowserSnapshot(app);
        const released = await releaseSubmissionBrowser(userId, app);
        await mutateState(userId, (current) => {
          const target = current.applications.find(
            (item) => item.id === applicationId && item.userId === userId,
          );
          if (!target || target.status !== "submitting") return;
          transition(target, ["submitting"], "needs_user_action");
          target.submissionStartedAt = undefined;
          target.submissionWorkerClaimedAt = undefined;
          target.submissionDispatch = undefined;
          setFormSnapshot(target, form);
          target.error = "The employer form changed before Submit. Review the refreshed form; no click was attempted.";
          if (target.autonomousAuthorization) recordApplicationBlocker(target, "other", target.error, { formHash: target.form?.hash, packetHash: target.packetHash, targetUrl: target.form?.url, sessionId: released ? undefined : app.browserSessionId });
          if (released) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          current.activity.unshift({
            id: newId(),
            at: new Date().toISOString(),
            label: "Form changed",
            detail: "Review and approve the current form again.",
          });
        });
        return { formChanged: true };
      }
      if (!latest?.submissionAttemptedAt && (app.autonomousAuthorization || error instanceof ApplicationEligibilityError)) {
        const released = await releaseSubmissionBrowser(userId, app);
        await mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || target.status !== "submitting") return;
          transition(target, ["submitting"], "needs_user_action");
          target.error = `${error instanceof Error ? error.message : "Automation blocked."} No submission was attempted.`;
          if (target.autonomousAuthorization) recordApplicationBlocker(target, blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: target.form?.url });
          target.approvals = target.approvals.filter((approval) => approval.kind !== "submit");
          target.form = undefined;
          target.submissionStartedAt = target.submissionWorkerClaimedAt = undefined;
          target.submissionDispatch = undefined;
          if (released) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Submission paused", detail: target.error });
        });
        if (!app.autonomousAuthorization && process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
          await sendActionNeeded(await loadState(userId), "A listing or required rule changed before submission").catch(() => undefined);
        return { blocked: true, reason: error instanceof Error ? error.message : "Automation blocked." };
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
          if (target.jobSnapshot?.source === "imported") target.importedOutcome = { version: 1, kind: "uncertain", at: new Date().toISOString(), evidence: target.error, synthetic: Boolean(target.controlledTest) };
          target.submissionAttemptedAt ??= app.submissionAttemptedAt;
          current.activity.unshift({
            id: newId(),
            at: new Date().toISOString(),
            label: "Submission needs review",
            detail: "No automatic retry will occur.",
          });
        }
      });
      if (!app.autonomousAuthorization && process.env.RESEND_API_KEY && process.env.EMAIL_FROM)
        await sendActionNeeded(
          await loadState(userId),
          "Check an uncertain application result",
        ).catch(() => undefined);
      throw error;
    }

}
