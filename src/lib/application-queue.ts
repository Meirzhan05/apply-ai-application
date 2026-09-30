import { tasks } from "@trigger.dev/sdk";
import { newId } from "@/lib/crypto";
import { reserveServiceBudget } from "@/lib/budget";
import { isDemo, loadState, mutateState } from "@/lib/repository";
import { transition } from "@/lib/workflow";
import { validatePacket } from "@/lib/drafting";
import { explicitConflict } from "@/lib/matching";
import { runDraft, runFill, type RunPayload } from "@/lib/application-runs";
import type { AppState } from "@/lib/types";

export function hasActiveBrowser(state: AppState, exceptId: string): boolean {
  return state.applications.some((app) => app.id !== exceptId &&
    (["filling", "submitting"].includes(app.status) ||
      (["final_review", "needs_user_action", "approved_to_submit"].includes(app.status) && Boolean(app.browserSessionId))));
}

export async function queueApplicationRun(userId: string, applicationId: string, kind: "draft" | "fill", draftMode?: "resume" | "essays") {
  await mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app) throw new Error("Application not found.");
    if (app.queuedRun?.kind === kind) return;
    if (app.queuedRun) throw new Error("Another run is already queued.");
    if (kind === "draft" && !["selected", "draft_review"].includes(app.status)) throw new Error("This application cannot be drafted now.");
    if (kind === "fill") {
      if (app.status !== "authorized_to_fill" || !app.packet) throw new Error("Approve the current packet first.");
      validatePacket(state.profile, app.packet);
      if (isDemo() && app.jobSnapshot?.source !== "demo") throw new Error("Demo runs are limited to controlled forms.");
    }
    const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
    if (!job?.active) throw new Error("The listing has closed.");
    const conflict = explicitConflict(state.profile, job);
    if (conflict) throw new Error(conflict);
    app.queuedRun = { id: newId(), kind, ...(draftMode ? { draftMode } : {}), requestedAt: new Date().toISOString(), reason: "waiting" };
    app.error = undefined;
  });
  await dispatchUserQueue(userId);
}

export async function dispatchUserQueue(userId: string) {
  const state = await loadState(userId);
  // Retrying the handoff uses the original provider idempotency key. It does
  // not recreate a run or reserve its budget again after an ambiguous timeout.
  let dispatched = 0;
  if (!isDemo()) for (const app of state.applications) {
    if (app.runDispatch && !app.runDispatch.confirmedAt && !app.runWorkerClaimedAt && ["drafting", "filling"].includes(app.status)) {
      if (await handoff(userId, app.id, app.runDispatch.kind, app.runDispatch.token, app.runDispatch.draftMode)) dispatched++;
    }
  }
  const pending = state.applications.filter((app) => app.queuedRun).sort((a, b) => a.queuedRun!.requestedAt.localeCompare(b.queuedRun!.requestedAt));
  for (const pendingApp of pending) {
    const queued = pendingApp.queuedRun!;
    const latest = await loadState(userId);
    if (queued.kind === "fill" && hasActiveBrowser(latest, pendingApp.id)) {
      await mutateState(userId, (current) => { const target = current.applications.find((app) => app.id === pendingApp.id); if (target?.queuedRun?.id === queued.id) target.queuedRun.reason = "active_run"; });
      continue;
    }
    const projected = queued.kind === "fill" ? Number(process.env.PROJECTED_BROWSER_RUN_USD || "1") : Number(process.env.PROJECTED_DRAFT_USD || "0.20");
    if (!(await reserveServiceBudget(userId, `queued:${queued.id}`, projected))) {
      await mutateState(userId, (current) => { const target = current.applications.find((app) => app.id === pendingApp.id); if (target?.queuedRun?.id === queued.id) target.queuedRun.reason = "budget"; });
      continue;
    }
    const claimed = await mutateState(userId, (current) => {
      const target = current.applications.find((app) => app.id === pendingApp.id);
      if (target?.queuedRun?.id !== queued.id) return false;
      if (queued.kind === "fill" && hasActiveBrowser(current, target.id)) { target.queuedRun.reason = "active_run"; return false; }
      const job = current.jobs.find((item) => item.id === target.jobId) ?? target.jobSnapshot;
      if (!job?.active) { target.queuedRun = undefined; target.error = "This queued listing closed before the run started."; return false; }
      const conflict = explicitConflict(current.profile, job);
      if (conflict) { target.queuedRun = undefined; target.error = conflict; return false; }
      if (queued.kind === "fill") {
        try { validatePacket(current.profile, target.packet!); }
        catch (error) {
          target.queuedRun = undefined;
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
    if (!claimed) continue;
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
    await tasks.trigger(kind === "fill" ? "fill-application-form" : "draft-application-packet", { userId, applicationId, runToken: token, ...(draftMode ? { draftMode } : {}) }, { idempotencyKey: token });
    await mutateState(userId, (state) => {
      const app = state.applications.find((item) => item.id === applicationId);
      if (app?.runDispatch?.token === token) { app.runDispatch.confirmedAt = new Date().toISOString(); app.error = undefined; }
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
