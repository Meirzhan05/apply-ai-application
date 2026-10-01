import { dispatchUserQueue } from "@/lib/application-queue";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import type { AppState } from "@/lib/types";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  if (isDemo()) return Response.json(await dispatchUserQueue("demo-user"));
  const { data, error } = await adminSupabase().from("app_states").select("user_id,data").limit(1000);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  let dispatched = 0;
  const errors: string[] = [];
  for (const row of data ?? []) {
    if (!(row.data as AppState).applications.some((app) => app.queuedRun || (app.runDispatch && !app.runDispatch.confirmedAt && ["drafting", "filling"].includes(app.status)) || (app.submissionDispatch && !app.submissionDispatch.confirmedAt && app.status === "submitting"))) continue;
    try { dispatched += (await dispatchUserQueue(row.user_id)).dispatched; }
    catch (error) { errors.push(error instanceof Error ? error.message : "Queue dispatch failed."); }
  }
  return Response.json({ dispatched, errors }, { status: errors.length ? 207 : 200 });
}
