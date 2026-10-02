import { mutateState, loadState, isDemo } from "@/lib/repository";
import { readAllAppStateOwners } from "@/lib/app-state-owners";
import { newId } from "@/lib/crypto";
import { sendActionNeeded } from "@/lib/email";
import { recoverStaleRuns } from "@/lib/run-recovery";
import { cancelBrowser } from "@/lib/browser-runner";
import { dispatchUserQueue } from "@/lib/application-queue";
import { resolveResourceHold, recordApplicationBlocker } from "@/lib/application-blockers";
import { browserBudgetReservationId, releaseServiceBudget } from "@/lib/budget";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  let data: Array<{ user_id: string }>;
  try { data = isDemo() ? [{ user_id: "demo-user" }] : await readAllAppStateOwners("user_id"); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Reconcile owner scan failed." }, { status: 500 }); }
  let marked = 0;
  for (const row of data ?? []) {
    const closed = await mutateState(row.user_id, (current) => {
      const recovered = recoverStaleRuns(current);
      for (const app of recovered) current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Run needs review", detail: current.applications.find((item) => item.id === app.id)!.error! });
      return recovered;
    });
    marked += closed.length;
    for (const app of closed) {
      try {
        await cancelBrowser({ ...app, browserSessionId: app.browserSessionId ?? app.browserReleasePending?.sessionId }, { strict: true });
        await mutateState(row.user_id, (current) => {
          const target = current.applications.find((item) => item.id === app.id && item.userId === row.user_id);
          if (!target || (target.browserSessionId ?? target.browserReleasePending?.sessionId) !== (app.browserSessionId ?? app.browserReleasePending?.sessionId)) return;
          target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          target.browserReleasePending = undefined;
          resolveResourceHold(target);
        });
      } catch (error) {
        await mutateState(row.user_id, (current) => {
          const target = current.applications.find((item) => item.id === app.id && item.userId === row.user_id);
          const sessionId = app.browserSessionId ?? app.browserReleasePending?.sessionId;
          if (!target || !sessionId) return;
          target.browserSessionId = sessionId;
          target.browserProvider = app.browserProvider;
          target.browserReleasePending = { sessionId, requestedAt: new Date().toISOString(), attempts: 1, lastError: error instanceof Error ? error.message : "The provider did not confirm the browser release." };
          recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The application will remain held until this session is stopped.", { sessionId });
        });
      }
    }
    const pendingReleases = (await loadState(row.user_id)).applications.filter((item) => item.browserReleasePending);
    for (const app of pendingReleases) {
      try {
        await cancelBrowser({ ...app, browserSessionId: app.browserSessionId ?? app.browserReleasePending!.sessionId }, { strict: true });
        await mutateState(row.user_id, (current) => {
          const target = current.applications.find((item) => item.id === app.id && item.userId === row.user_id);
          if (!target || !target.browserReleasePending) return;
          target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
          target.browserReleasePending = undefined;
          resolveResourceHold(target);
        });
      } catch (error) {
        await mutateState(row.user_id, (current) => {
          const target = current.applications.find((item) => item.id === app.id && item.userId === row.user_id);
          if (!target?.browserReleasePending) return;
          target.browserReleasePending.attempts += 1;
          target.browserReleasePending.lastError = error instanceof Error ? error.message : "The provider did not confirm the browser release.";
        });
      }
    }
    const budgetCompensations = (await loadState(row.user_id)).applications.filter((item) => item.importedPreflight?.budgetReleasePending);
    for (const app of budgetCompensations) {
      const preflight = app.importedPreflight;
      const marker = preflight?.budgetReleasePending;
      const expectedReservationId = preflight ? browserBudgetReservationId(app.id, preflight.token) : undefined;
      if (!preflight || !marker || marker.kind !== "unused" || marker.reservationId !== expectedReservationId || preflight.budgetReservationId !== marker.reservationId || marker.month !== preflight.budgetMonth || app.userId !== row.user_id) continue;
      try {
        const released = await releaseServiceBudget(row.user_id, marker.reservationId, marker.month);
        if (!released) throw new Error("The unused browser budget reservation could not be released.");
        await mutateState(row.user_id, (current) => {
          const target = current.applications.find((item) => item.id === app.id && item.userId === row.user_id);
          const targetMarker = target?.importedPreflight?.budgetReleasePending;
          if (!target || !targetMarker || target.importedPreflight?.token !== preflight.token || targetMarker.reservationId !== marker.reservationId || targetMarker.month !== marker.month) return;
          target.importedPreflight = undefined;
          resolveResourceHold(target);
        });
      } catch (error) {
        await mutateState(row.user_id, (current) => {
          const target = current.applications.find((item) => item.id === app.id && item.userId === row.user_id);
          const targetMarker = target?.importedPreflight?.budgetReleasePending;
          if (!target || !targetMarker || target.importedPreflight?.token !== preflight.token || targetMarker.reservationId !== marker.reservationId || targetMarker.month !== marker.month) return;
          targetMarker.attempts += 1;
          targetMarker.lastError = error instanceof Error ? error.message : "The unused browser budget could not be released.";
        });
      }
    }
    if (closed.length) {
      const latest = await loadState(row.user_id);
      if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM && latest.applications.some((item) => item.status === "needs_user_action" && !item.autonomousAuthorization)) await sendActionNeeded(latest, "An application run needs your review").catch(() => undefined);
      if (!latest.applications.some((item) => item.browserReleasePending)) await dispatchUserQueue(row.user_id);
    }
    if (pendingReleases.length && !(await loadState(row.user_id)).applications.some((item) => item.browserReleasePending)) await dispatchUserQueue(row.user_id);
  }
  return Response.json({ marked });
}
