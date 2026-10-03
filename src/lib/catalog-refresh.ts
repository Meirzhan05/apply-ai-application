import { adminSupabase } from "@/lib/supabase-admin";
import {
  closeMissingJobs,
  configuredBoards,
  dedupeJobs,
  fetchBoard,
} from "@/lib/sources";
import { isDemo, saveCatalog } from "@/lib/repository";
import { readState, updateState } from "@/lib/store";
import type { Job } from "@/lib/types";
import { readActiveCatalogRows } from "@/lib/catalog";
import { recordDiscoveryRefresh, type DiscoveryRefreshReport } from "@/lib/discovery";

export async function refreshCatalog(): Promise<DiscoveryRefreshReport & { sources: number; jobs: number; closed: number; errors: string[] }> {
  const refreshedAt = new Date().toISOString();
  const boards = configuredBoards();
  const previousIds = new Set<string>();
  let catalogRows: Array<{ id: string; data: Job }> = [];
  if (isDemo()) {
    const state = await readState();
    for (const job of state.jobs.filter((item) => item.active)) previousIds.add(job.id);
  } else {
    catalogRows = await readActiveCatalogRows();
    for (const row of catalogRows) previousIds.add(String(row.id));
  }
  const results = await Promise.allSettled(
    boards.map((board) => fetchBoard(board)),
  );
  const errors: string[] = [];
  const sourceStatus = boards.map((board, index) => {
    const result = results[index];
    return result.status === "fulfilled"
      ? { source: `${board.source}:${board.slug}`, status: "available" as const, checkedAt: refreshedAt }
      : { source: `${board.source}:${board.slug}`, status: "unavailable" as const, checkedAt: refreshedAt, error: String(result.reason) };
  });
  const activeBoards = boards.filter(
    (_, i) => results[i].status === "fulfilled",
  );
  const seen = new Set<string>();
  const fetched =
    results.flatMap((result, i) => {
      if (result.status === "rejected") {
        errors.push(
          `${boards[i].source}:${boards[i].slug}: ${String(result.reason)}`,
        );
        return [];
      }
      return result.value;
    });
  const incoming = [...new Map(fetched.map((job) => [job.id, job])).values()];
  incoming.forEach((job) => seen.add(job.id));
  let closed = 0;
  if (isDemo()) {
    await updateState((state) => {
      const result = closeMissingJobs(state.jobs, activeBoards, seen);
      state.jobs = result.jobs;
      closed = result.closed;
    });
  } else if (activeBoards.length) {
    const client = adminSupabase();
    const data = catalogRows;
    const stale = data.filter(
      (row) =>
        activeBoards.some((board) =>
          String(row.id).startsWith(`${board.source}:${board.slug}:`),
        ) && !seen.has(String(row.id)),
    );
    for (const row of stale) {
      const job = row.data as Job;
      const { error: closeError } = await client
        .from("jobs")
        .update({ active: false, data: { ...job, active: false } })
        .eq("id", row.id);
      if (closeError) throw closeError;
      closed++;
    }
  }
  await saveCatalog(incoming);
  if (isDemo()) await updateState((state) => recordDiscoveryRefresh(state, {
    refreshedAt,
    sourceStatus,
    arrivals: incoming.filter((job) => !previousIds.has(job.id)).map((job) => ({ jobId: job.id, source: job.source, discoveredAt: job.discoveredAt })),
  }));
  return {
    refreshedAt,
    sourceStatus,
    sources: sourceStatus.filter((source) => source.status === "available").length,
    jobs: dedupeJobs(incoming).length,
    closed,
    errors,
    arrivals: incoming.filter((job) => !previousIds.has(job.id)).map((job) => ({ jobId: job.id, source: job.source, discoveredAt: job.discoveredAt })),
  };
}
