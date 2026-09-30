import { adminSupabase } from "@/lib/supabase-admin";
import {
  closeMissingJobs,
  configuredBoards,
  dedupeJobs,
  fetchBoard,
} from "@/lib/sources";
import { isDemo, saveCatalog } from "@/lib/repository";
import { updateState } from "@/lib/store";
import type { Job } from "@/lib/types";
import { readActiveCatalogRows } from "@/lib/catalog";

export async function refreshCatalog(): Promise<{
  sources: number;
  jobs: number;
  closed: number;
  errors: string[];
}> {
  const boards = configuredBoards();
  const results = await Promise.allSettled(
    boards.map((board) => fetchBoard(board)),
  );
  const errors: string[] = [];
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
    const data = await readActiveCatalogRows();
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
  return {
    sources: activeBoards.length,
    jobs: dedupeJobs(incoming).length,
    closed,
    errors,
  };
}
