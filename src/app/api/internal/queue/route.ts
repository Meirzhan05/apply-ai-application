import { dispatchUserQueue } from "@/lib/application-queue";
import { isDemo } from "@/lib/demo-mode";
import { readAllAppStateOwners } from "@/lib/app-state-owners";
import type { AppState } from "@/lib/types";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  if (isDemo()) return Response.json(await dispatchUserQueue("demo-user"));
  let data: Array<{ user_id: string; data?: unknown }>;
  try { data = await readAllAppStateOwners("user_id,data"); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Queue owner scan failed." }, { status: 500 }); }
  let dispatched = 0;
  const errors: string[] = [];
  for (const row of data ?? []) {
    if (!(row.data as AppState).applications.some((app) => app.queuedRun || app.budgetReservation?.status === "release_pending" || (app.runDispatch && !app.runDispatch.confirmedAt && ["drafting", "filling"].includes(app.status)) || (app.submissionDispatch && !app.submissionDispatch.confirmedAt && app.status === "submitting"))) continue;
    try { dispatched += (await dispatchUserQueue(row.user_id)).dispatched; }
    catch (error) { errors.push(error instanceof Error ? error.message : "Queue dispatch failed."); }
  }
  return Response.json({ dispatched, errors }, { status: errors.length ? 207 : 200 });
}
