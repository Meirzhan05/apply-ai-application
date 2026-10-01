import { NextResponse } from "next/server";
import { refreshCatalog } from "@/lib/catalog-refresh";
import { queueMatchAssessment } from "@/lib/match-queue";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import { tasks } from "@trigger.dev/sdk";
import type { refreshUserImports } from "../../../../../trigger/imports";
import { readState, updateState } from "@/lib/store";
import { applyImportedRefresh, refreshImportedJobs } from "@/lib/import-jobs";
import { mutateState } from "@/lib/repository";
import { recordDiscoveryRefresh } from "@/lib/discovery";

export const runtime = "nodejs";

async function readAllOwners() {
  const owners: Array<{ user_id: string; data?: { importedJobs?: unknown[] } }> = [];
  const pageSize = 100;
  let cursor: string | undefined;
  for (;;) {
    let query = adminSupabase()
      .from("app_states")
      .select("user_id,data")
      .order("user_id", { ascending: true });
    if (cursor) query = query.gt("user_id", cursor);
    const { data, error } = await query.range(0, pageSize - 1);
    if (error) throw error;
    owners.push(...((data ?? []) as Array<{ user_id: string; data?: { importedJobs?: unknown[] } }>));
    if (!data || data.length < pageSize) break;
    const next = data.at(-1)?.user_id;
    if (!next || next === cursor) throw new Error("Owner pagination did not advance.");
    cursor = next;
  }
  return owners;
}

export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  try {
    const result = await refreshCatalog();
    if (isDemo()) {
      const before = (await readState()).importedJobs ?? [];
      if (before.length) {
        const refreshed = await refreshImportedJobs(before);
        await updateState((state) => applyImportedRefresh(state, before, refreshed));
      }
    }
    if (
      !isDemo() &&
      process.env.TRIGGER_SECRET_KEY
    ) {
      const owners = await readAllOwners();
      const queued = await Promise.allSettled(owners.map((row) =>
        row.data?.importedJobs?.length
          ? tasks.trigger<typeof refreshUserImports>("refresh-user-imported-jobs", { userId: row.user_id }, { concurrencyKey: row.user_id })
          : process.env.OPENAI_API_KEY ? queueMatchAssessment(row.user_id) : Promise.resolve()));
      const failed = queued.filter((item) => item.status === "rejected").length;
      let telemetryFailures: string[] = [];
      if (result.sourceStatus) {
        // Refresh results are shared, but discovery freshness is owner state.
        // Persist it independently so one owner's queue failure cannot hide
        // which public sources were unavailable for every other owner.
        const persisted = await Promise.allSettled(owners.map((row) => mutateState(row.user_id, (state) => recordDiscoveryRefresh(state, {
          refreshedAt: result.refreshedAt,
          sourceStatus: result.sourceStatus,
          arrivals: result.arrivals,
        }))));
        telemetryFailures = persisted.flatMap((item, index) => item.status === "rejected" ? [owners[index].user_id] : []);
      }
      if (failed || telemetryFailures.length) {
        return NextResponse.json({
          ...result,
          ...(failed ? { queueErrors: failed } : {}),
          ...(telemetryFailures.length ? {
            telemetryErrors: telemetryFailures.length,
            telemetryFailedOwners: telemetryFailures,
            retryable: true,
          } : {}),
        }, { status: 503 });
      }
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : (error as { message?: string })?.message || "Refresh failed." },
      { status: 500 },
    );
  }
}
