import { NextResponse } from "next/server";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo, loadState, mutateState } from "@/lib/repository";
import { sendDigest } from "@/lib/email";
import { digestDay } from "@/lib/digest-time";
import { withAccountOperation } from "@/lib/account-lifecycle";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  if (isDemo())
    return NextResponse.json({
      sent: 0,
      detail: "Demo mode does not send email.",
    });
  const client = adminSupabase();
  const asOf = new Date();
  const { data: rows, error: stateError } = await client.from("app_states").select("user_id").limit(1000);
  if (stateError)
    return NextResponse.json(
      { error: stateError.message },
      { status: 500 },
    );
  let sent = 0;
  const errors: string[] = [];
  for (const row of rows ?? []) {
    try {
      await withAccountOperation(row.user_id, "email", async () => {
        const state = await loadState(row.user_id);
        const previousDigest = new Date(state.lastDigestAt ?? "");
        if (Number.isFinite(previousDigest.getTime()) && digestDay(previousDigest) === digestDay(asOf)) return;
        if (await sendDigest(state, state.jobs, asOf)) {
          sent++;
          await mutateState(row.user_id, (current) => { current.lastDigestAt = asOf.toISOString(); });
        }
      }, "daily-digest");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Email failed.");
    }
  }
  return NextResponse.json(
    { sent, errors },
    { status: errors.length ? 207 : 200 },
  );
}
