import { NextResponse } from "next/server";
import { refreshCatalog } from "@/lib/catalog-refresh";
import { queuePersonalSearch } from "@/lib/personal-search";
import { isDemo } from "@/lib/demo-mode";
import { tasks } from "@trigger.dev/sdk";
import type { refreshUserImports } from "../../../../../trigger/imports";
import { readState, updateState } from "@/lib/store";
import { applyImportedRefresh, refreshImportedJobs } from "@/lib/import-jobs";
import { readAllAppStateOwners, type AppStateOwnerRow } from "@/lib/app-state-owners";
import { withAccountOperation } from "@/lib/account-lifecycle";

export const runtime = "nodejs";
export const maxDuration = 300;

type RefreshOwnerRow = AppStateOwnerRow & { data?: { importedJobs?: unknown[] } };

export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return new Response("Unauthorized", { status: 401 });
  try {
    if (isDemo()) {
      const result = await refreshCatalog();
      const before = (await readState()).importedJobs ?? [];
      if (before.length) {
        const refreshed = await refreshImportedJobs(before);
        await updateState((state) => applyImportedRefresh(state, before, refreshed));
      }
      return NextResponse.json(result);
    }
    if (!process.env.TRIGGER_SECRET_KEY) return NextResponse.json({ error: "Search queue unavailable." }, { status: 503 });
    const owners = await readAllAppStateOwners<RefreshOwnerRow>("user_id,data", 100);
    const queued = await Promise.allSettled(owners.map((row) => withAccountOperation(row.user_id, "maintenance", async () => {
      // Personal discovery and manually imported links are independent owner tasks.
      const results = await Promise.allSettled([
        queuePersonalSearch(row.user_id, true),
        row.data?.importedJobs?.length
          ? withAccountOperation(row.user_id, "dispatch", () => tasks.trigger<typeof refreshUserImports>("refresh-user-imported-jobs", { userId: row.user_id }, { concurrencyKey: row.user_id, tags: [`owner:${row.user_id}`] }), "refresh-imports")
          : Promise.resolve(),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Owner refresh dispatch failed.");
    }, "internal/refresh")));
    const queueErrors = queued.filter((item) => item.status === "rejected").length;
    return NextResponse.json({ owners: owners.length, queueErrors }, { status: queueErrors ? 503 : 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : (error as { message?: string })?.message || "Refresh failed." },
      { status: 500 },
    );
  }
}
