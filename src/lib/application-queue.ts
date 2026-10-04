import { tasks } from "@trigger.dev/sdk";
import { assertAutonomous } from "@/lib/autonomous-policy";
import { dispatchAutonomousSubmissions } from "@/lib/autonomous-application";
import { newId } from "@/lib/crypto";
import { markQueuedBudgetClaimed, markQueuedBudgetTerminal, releaseQueuedBudget, reserveQueuedBudget, type QueuedBudgetReceipt } from "@/lib/budget";
import { isDemo, loadState, mutateState } from "@/lib/repository";
import { transition } from "@/lib/workflow";
import { validatePacket } from "@/lib/drafting";
import { explicitConflict } from "@/lib/matching";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import { assertSourceJobCurrent } from "@/lib/resume-source-freshness";
import { runDraft, runFill, type RunPayload } from "@/lib/application-runs";
import { blockerReason, recordApplicationBlocker } from "@/lib/application-blockers";
import type { AppState } from "@/lib/types";
import type { PilotMutationContext } from "@/lib/pilot";
import { withAccountOperation } from "@/lib/account-lifecycle";

export function hasActiveBrowser(state: AppState, exceptId: string): boolean {
  return state.applications.some((app) => app.id !== exceptId &&
    (Boolean(app.browserReleasePending) || Boolean(app.importedPreflight) || ["filling", "submitting"].includes(app.status) ||
      (["final_review", "needs_user_action", "approved_to_submit", "awaiting_verification", "uncertain"].includes(app.status) && Boolean(app.browserSessionId))));
}

export async function queueApplicationRun(userId: string, applicationId: string, kind: "draft" | "fill", draftMode?: "resume" | "essays", context?: PilotMutationContext) {
  await mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app) throw new Error("Application not found.");
    if (app.budgetReservation?.status === "release_pending") throw new Error("A previous budget reservation is still being released.");
    if (app.queuedRun?.kind === kind) return;
    if (app.queuedRun) throw new Error("Another run is already queued.");
    if (kind === "draft" && !["selected", "draft_review"].includes(app.status)) throw new Error("This application cannot be drafted now.");
    if (kind === "fill") {
      if (app.status !== "authorized_to_fill" || !app.packet) throw new Error("Approve the current packet first.");
      const currentJob = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
      if (currentJob) assertSourceJobCurrent(app, currentJob);
      validatePacket(state.profile, app.packet);
      if (isDemo() && app.jobSnapshot?.source !== "demo") throw new Error("Demo runs are limited to controlled forms.");
    }
    const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
    if (!job?.active) throw new Error("The listing has closed.");
    const conflict = explicitConflict(state.profile, importedAutonomyJob(app, job));
    if (conflict) throw new Error(conflict);
    app.queuedRun = { id: newId(), kind, ...(draftMode ? { draftMode } : {}), requestedAt: new Date().toISOString(), reason: "waiting" };
    app.error = undefined;
  }, context);
  await dispatchUserQueue(userId);
}

export async function dispatchUserQueue(userId: string) {
  const state = await loadState(userId);
  for (const app of state.applications) {
    const reservation = app.budgetReservation;
    const token = reservation?.reservationId.startsWith("queued:") ? reservation.reservationId.slice("queued:".length) : undefined;
    if (!reservation || reservation.status !== "release_pending" || app.queuedRun || app.runToken === token) continue;
    const receipt: QueuedBudgetReceipt = { queuedId: token!, reservationId: reservation.reservationId, month: reservation.month, ownerId: reservation.ownerId, applicationId: reservation.applicationId, projectedUsd: reservation.projectedUsd };
    await markQueuedBudgetTerminal(receipt);
    if (await releaseQueuedBudget(receipt)) await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === app.id);
      if (target?.budgetReservation?.reservationId === reservation.reservationId) target.budgetReservation.status = "released";
    });
  }
  // Retrying the handoff uses the original provider idempotency key. It does
  // not recreate a run or reserve its budget again after an ambiguous timeout.
  let dispatched = await dispatchAutonomousSubmissions(userId);
  if (!isDemo()) for (const app of state.applications) {
    if (app.runDispatch && !app.runDispatch.confirmedAt && !app.runWorkerClaimedAt && ["drafting", "filling"].includes(app.status)) {
      if (await handoff(userId, app.id, app.runDispatch.kind, app.runDispatch.token, app.runDispatch.draftMode)) dispatched++;
    }
  }
  const pending = state.applications.filter((app) => app.queuedRun).sort((a, b) => a.queuedRun!.requestedAt.localeCompare(b.queuedRun!.requestedAt));
  for (const pendingApp of pending) {
    const queued = pendingApp.queuedRun!;
    const latest = await loadState(userId);
    if (pendingApp.autonomousAuthorization) {
      try { const app = latest.applications.find((item) => item.id === pendingApp.id)!; assertAutonomous(app, latest.profile, latest.jobs.find((item) => item.id === app.jobId), queued.kind); }
      catch (error) { await mutateState(userId, (current) => { const target = current.applications.find((app) => app.id === pendingApp.id); if (target?.queuedRun?.id === queued.id) { target.queuedRun = undefined; transition(target, [target.status], "needs_user_action"); target.error = error instanceof Error ? error.message : "Automation blocked."; recordApplicationBlocker(target, blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: target.jobSnapshot?.applyUrl }); } }); continue; }
    }
    if (queued.kind === "fill" && hasActiveBrowser(latest, pendingApp.id)) {
      await mutateState(userId, (current) => { const target = current.applications.find((app) => app.id === pendingApp.id); if (target?.queuedRun?.id === queued.id) target.queuedRun.reason = "active_run"; });
      continue;
    }
    const projected = queued.kind === "fill" ? Number(process.env.PROJECTED_BROWSER_RUN_USD || "1") : Number(process.env.PROJECTED_DRAFT_USD || "0.20");
    const receipt = await reserveQueuedBudget(userId, pendingApp.id, queued.id, projected);
    if (!receipt) {
      await mutateState(userId, (current) => { const target = current.applications.find((app) => app.id === pendingApp.id); if (target?.queuedRun?.id === queued.id) target.queuedRun.reason = "budget"; });
      continue;
    }
    const claimed = await mutateState(userId, (current) => {
      const target = current.applications.find((app) => app.id === pendingApp.id);
      if (target?.queuedRun?.id !== queued.id) return false;
      if (queued.kind === "fill" && hasActiveBrowser(current, target.id)) { target.queuedRun.reason = "active_run"; return false; }
      const job = current.jobs.find((item) => item.id === target.jobId) ?? target.jobSnapshot;
      if (target.autonomousAuthorization) {
        try { assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), queued.kind); }
        catch (error) { target.queuedRun = undefined; target.budgetReservation = { ...receipt, status: "release_pending" }; transition(target, [target.status], "needs_user_action"); target.error = error instanceof Error ? error.message : "Automation blocked."; recordApplicationBlocker(target, blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: target.jobSnapshot?.applyUrl }); return false; }
      }
      if (!job?.active) { target.queuedRun = undefined; target.budgetReservation = { ...receipt, status: "release_pending" }; target.error = "This queued listing closed before the run started."; return false; }
      const conflict = explicitConflict(current.profile, importedAutonomyJob(target, job));
      if (conflict) { target.queuedRun = undefined; target.budgetReservation = { ...receipt, status: "release_pending" }; target.error = conflict; return false; }
      if (queued.kind === "fill") {
        try { assertSourceJobCurrent(target, job); validatePacket(current.profile, target.packet!); }
        catch (error) {
          target.queuedRun = undefined;
          target.budgetReservation = { ...receipt, status: "release_pending" };
          target.approvals = [];
          transition(target, ["authorized_to_fill"], "draft_review");
          target.error = error instanceof Error ? error.message : "Review a new packet before filling.";
          return false;
        }
      }
      transition(target, queued.kind === "fill" ? ["authorized_to_fill"] : ["selected", "draft_review"], queued.kind === "fill" ? "filling" : "drafting");
      target.runToken = queued.id;
      target.runWorkerClaimedAt = undefined;
      target.runDispatch = { kind: queued.kind, token: queued.id, ...(queued.draftMode ? { draftMode: queued.draftMode } : {}) };
      target.runs ??= [];
      target.runs.push({ token: queued.id, kind: queued.kind, projectedUsd: projected, requestedAt: queued.requestedAt });
      target.queuedRun = undefined;
      if (queued.kind === "draft") { target.approvals = []; target.form = undefined; }
      return true;
    });
    if (!claimed) {
      const after = await loadState(userId);
      const current = after.applications.find((app) => app.id === pendingApp.id);
      if (current?.budgetReservation?.reservationId === `queued:${queued.id}` && current.budgetReservation.status === "release_pending" && !current.queuedRun && current.runToken !== queued.id) {
        const terminalReceipt: QueuedBudgetReceipt = { queuedId: queued.id, reservationId: current.budgetReservation.reservationId, month: current.budgetReservation.month, ownerId: current.budgetReservation.ownerId, applicationId: current.budgetReservation.applicationId, projectedUsd: current.budgetReservation.projectedUsd };
        await markQueuedBudgetTerminal(terminalReceipt);
        if (await releaseQueuedBudget(terminalReceipt)) await mutateState(userId, (state) => {
          const target = state.applications.find((app) => app.id === pendingApp.id);
          if (target?.budgetReservation?.reservationId === `queued:${queued.id}`) target.budgetReservation.status = "released";
        });
      }
      continue;
    }
    await markQueuedBudgetClaimed(receipt);
    const payload: RunPayload = { userId, applicationId: pendingApp.id, runToken: queued.id, ...(queued.draftMode ? { draftMode: queued.draftMode } : {}) };
    try {
      if (isDemo()) await (queued.kind === "fill" ? runFill : runDraft)(payload);
      else { if (!(await handoff(userId, pendingApp.id, queued.kind, queued.id, queued.draftMode))) continue; }
      dispatched++;
    } catch (error) {
      await mutateState(userId, (current) => { const target = current.applications.find((app) => app.id === pendingApp.id); if (target?.runToken === queued.id) target.error = error instanceof Error ? error.message : "Run dispatch failed."; });
      if (isDemo()) throw error;
    }
  }
  return { dispatched };
}

async function handoff(userId: string, applicationId: string, kind: "draft" | "fill", token: string, draftMode?: "resume" | "essays"): Promise<boolean> {
  try {
    await withAccountOperation(userId, "dispatch", () => tasks.trigger(kind === "fill" ? "fill-application-form" : "draft-application-packet", { userId, applicationId, runToken: token, ...(draftMode ? { draftMode } : {}) }, { idempotencyKey: token, tags: [`owner:${userId}`] }), `application:${applicationId}:${token}`);
    await mutateState(userId, (state) => {
      const app = state.applications.find((item) => item.id === applicationId);
      if (app?.runDispatch?.token === token) { app.runDispatch.confirmedAt = new Date().toISOString(); if (!app.autonomousAuthorization || ["drafting", "filling"].includes(app.status)) app.error = undefined; }
    });
    return true;
  } catch {
    await mutateState(userId, (state) => {
      const app = state.applications.find((item) => item.id === applicationId);
      if (app?.runDispatch?.token === token && !app.runWorkerClaimedAt) app.error = "Waiting for the worker handoff. Your saved request will be checked again.";
    });
    return false;
  }
}
