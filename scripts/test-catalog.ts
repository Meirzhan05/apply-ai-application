import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readActiveCatalogRows } from "../src/lib/catalog";
import { loadState } from "../src/lib/repository";
import { adminSupabase } from "../src/lib/supabase-admin";
import { configuredBoards, dedupeJobs, fetchBoard, canonicalJobUrl } from "../src/lib/sources";

async function main() {
  process.env.DEMO_MODE = "false";
  const { count, error } = await adminSupabase().from("jobs").select("id", { count: "exact", head: true }).eq("active", true);
  assert.equal(error, null);
  const rows = await readActiveCatalogRows();
  assert.equal(rows.length, count, "Catalog paging must include every active row");
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  const state = await loadState(randomUUID());
  const visibleUrls = new Set(state.jobs.map((job) => canonicalJobUrl(job.url)));
  assert.equal(visibleUrls.size, dedupeJobs(rows.map((row) => row.data)).length);
  assert.equal(state.jobs.length, visibleUrls.size);
  console.log(JSON.stringify({ activeStoredRows: rows.length, visibleUniquePostings: state.jobs.length, completeCatalogRead: true }));
  const results = await Promise.all(configuredBoards().map(async (board) => {
    const jobs = await fetchBoard(board);
    return { source: board.source, board: board.slug, postings: jobs.length, oldTitleLocationGroups: new Set(jobs.map((job) => `${job.company}|${job.title}|${job.location}`)).size, uniquePostingUrls: dedupeJobs(jobs).length };
  }));
  for (const result of results) console.log(JSON.stringify(result));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
