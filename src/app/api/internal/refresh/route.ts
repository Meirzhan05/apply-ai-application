import { NextResponse } from "next/server";
import { refreshCatalog } from "@/lib/catalog-refresh";
import { queueMatchAssessment } from "@/lib/match-queue";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import { tasks } from "@trigger.dev/sdk";
import type { refreshUserImports } from "../../../../../trigger/imports";
import { readState, updateState } from "@/lib/store";
import { applyImportedRefresh, refreshImportedJobs } from "@/lib/import-jobs";

export const runtime = "nodejs";
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
      const { data, error } = await adminSupabase()
        .from("app_states")
        .select("user_id,data")
        .limit(100);
      if (error) throw error;
      const queued = await Promise.allSettled((data ?? []).map((row) =>
        row.data?.importedJobs?.length
          ? tasks.trigger<typeof refreshUserImports>("refresh-user-imported-jobs", { userId: row.user_id }, { concurrencyKey: row.user_id })
          : process.env.OPENAI_API_KEY ? queueMatchAssessment(row.user_id) : Promise.resolve()));
      const failed = queued.filter((item) => item.status === "rejected").length;
      if (failed) return NextResponse.json({ ...result, queueErrors: failed }, { status: 503 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : (error as { message?: string })?.message || "Refresh failed." },
      { status: 500 },
    );
  }
}
