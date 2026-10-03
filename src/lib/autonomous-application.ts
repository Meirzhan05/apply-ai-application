import { tasks } from "@trigger.dev/sdk";
import { newId } from "@/lib/crypto";
import { loadState, mutateState, isDemo } from "@/lib/repository";
import { selectApplication, transition } from "@/lib/workflow";
import { canonicalJobUrl } from "@/lib/sources";
import { assertAutomationEnabled, assertAutonomous, authorizeKnownAnswerApplication } from "@/lib/autonomous-policy";
import type { AppState, Application } from "@/lib/types";
import type { PilotMutationContext } from "@/lib/pilot";
import { withAccountOperation } from "@/lib/account-lifecycle";

/** Save the continuation in the same transaction as the ready snapshot. */
export function saveAutonomousSubmission(state: AppState, app: Application): void {
  if (!app.autonomousAuthorization || app.status !== "final_review") return;
  app.autonomousAuthorization.formHash = app.form?.hash;
  assertAutonomous(app, state.profile, state.jobs.find((job) => job.id === app.jobId), "submit");
  transition(app, ["final_review"], "submitting");
  app.submissionStartedAt = new Date().toISOString();
  app.submissionDispatch = { token: newId() };
}

export async function startAutonomousApplication(userId: string, jobId: string, context?: PilotMutationContext) {
  const id = await mutateState(userId, (state) => {
    assertAutomationEnabled(state.profile);
    const job = state.jobs.find((item) => item.id === jobId && item.active);
    if (!job) throw new Error("The listing is no longer available.");
    const existing = state.applications.find((app) => app.userId === userId && (app.jobId === job.id || canonicalJobUrl(app.jobSnapshot?.url || "") === canonicalJobUrl(job.url)));
    if (existing) {
      if (!existing.autonomousAuthorization) {
        if (existing.importedCompatibility?.status !== "reachable") throw new Error("Verify this imported employer posting before starting its automatic application.");
        authorizeKnownAnswerApplication(existing, state.profile, job);
      }
      if (existing.status === "selected" && !existing.runToken && !existing.queuedRun) {
        assertAutonomous(existing, state.profile, state.jobs.find((item) => item.id === existing.jobId), "draft");
        existing.queuedRun = { id: newId(), kind: "draft", requestedAt: new Date().toISOString(), reason: "waiting" };
      }
      return existing.id;
    }
    const app = selectApplication(state, jobId, userId);
    authorizeKnownAnswerApplication(app, state.profile, job);
    app.queuedRun = { id: newId(), kind: "draft", requestedAt: new Date().toISOString(), reason: "waiting" };
    return app.id;
  }, context);
  await (await import("@/lib/application-queue")).dispatchUserQueue(userId);
  return { applicationId: id };
}

export async function queueAutonomousSubmission(userId: string, applicationId: string) {
  await mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app || app.status !== "final_review") return;
    saveAutonomousSubmission(state, app);
  });
  return dispatchAutonomousSubmissions(userId);
}

export async function dispatchAutonomousSubmissions(userId: string): Promise<number> {
  let count = 0;
  for (const app of (await loadState(userId)).applications) {
    if (app.status !== "submitting" || !app.submissionDispatch || app.submissionDispatch.confirmedAt || app.submissionWorkerClaimedAt || app.submissionAttemptedAt) continue;
    const token = app.submissionDispatch.token;
    try {
      if (isDemo()) await (await import("@/lib/application-submission")).runSubmission({ userId, applicationId: app.id, submissionToken: token });
      else await withAccountOperation(userId, "dispatch", () => tasks.trigger("submit-application-form", { userId, applicationId: app.id, submissionToken: token }, { idempotencyKey: token, tags: [`owner:${userId}`] }), `submission:${app.id}:${token}`);
      await mutateState(userId, (state) => { const target = state.applications.find((item) => item.id === app.id); if (target?.submissionDispatch?.token === token) { target.submissionDispatch.confirmedAt = new Date().toISOString(); if (target.status === "submitting" && !target.submissionWorkerClaimedAt) target.error = undefined; } });
      count++;
    } catch {
      await mutateState(userId, (state) => { const target = state.applications.find((item) => item.id === app.id); if (target?.submissionDispatch?.token === token && !target.submissionWorkerClaimedAt) target.error = "Waiting for the submission worker handoff. The saved attempt will not be duplicated."; });
    }
  }
  return count;
}
