import { NextResponse } from "next/server";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo, mutateState } from "@/lib/repository";
import { sendDigest } from "@/lib/email";
import { readActiveCatalogRows } from "@/lib/catalog";
import { digestDay } from "@/lib/digest-time";
import type { AppState } from "@/lib/types";

export const runtime = "nodejs";
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
  const [{ data: rows, error: stateError }, jobs] = await Promise.all([
      client.from("app_states").select("user_id,data").limit(1000),
      readActiveCatalogRows(),
    ]);
  if (stateError)
    return NextResponse.json(
      { error: stateError.message },
      { status: 500 },
    );
  let sent = 0;
  const errors: string[] = [];
  for (const row of rows ?? []) {
    try {
      const state = row.data as AppState;
      const previousDigest = new Date(state.lastDigestAt ?? "");
      if (
        Number.isFinite(previousDigest.getTime()) &&
        digestDay(previousDigest) === digestDay(asOf)
      )
        continue;
      if (
        await sendDigest(
          state,
          jobs.map((item) => ({ ...item.data, discoveredAt: item.discovered_at })),
          asOf,
        )
      ) {
        sent++;
        await mutateState(row.user_id, (current) => {
          current.lastDigestAt = asOf.toISOString();
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Email failed.");
    }
  }
  return NextResponse.json(
    { sent, errors },
    { status: errors.length ? 207 : 200 },
  );
}
