import { classifyImport, fetchBoard, canonicalJobUrl, type BoardConfig } from "@/lib/sources";
import { newId } from "@/lib/crypto";
import type { AppState, Job } from "@/lib/types";

export function importedPosting(raw: string): { board: BoardConfig; sourceId: string } | null {
  const parsed = classifyImport(raw);
  const url = new URL(parsed.url);
  if (parsed.source === "imported" || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const [slug] = parts;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(slug || "")) return null;
  const sourceId = parsed.source === "greenhouse" ? parts[2] : parts[1];
  if (parsed.source === "greenhouse") {
    if (parts.length !== 3 || parts[1] !== "jobs" || !/^\d+$/.test(sourceId || "")) return null;
  } else if (!(parts.length === 2 || (parts.length === 3 &&
    parts[2] === (parsed.source === "lever" ? "apply" : "application"))) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(sourceId || "")) return null;
  return { board: { source: parsed.source as BoardConfig["source"], slug, ...(url.hostname === "jobs.eu.lever.co" ? { region: "eu" as const } : {}) }, sourceId };
}

export function newImportedJob(input: { url: string; company?: string; title?: string; location?: string; description?: string }): Job {
  const parsed = classifyImport(input.url);
  return {
    id: `imported:${newId()}`, source: "imported", sourceId: newId(), sourceLabel: "Imported link",
    company: input.company || new URL(parsed.url).hostname,
    title: input.title || "Imported opportunity", location: input.location || "Location not listed",
    remote: null, employmentType: "Not listed",
    description: input.description || "Details must be checked on the original posting.", requirements: [],
    url: parsed.url, applyUrl: parsed.url, importUrl: parsed.url, active: true, discoveredAt: new Date().toISOString(),
  };
}

// The caller's URL is only parsed. Requests go to fixed public provider API
// hosts via fetchBoard, never to an arbitrary imported employer/board URL.
export async function refreshImportedJobs(jobs: Job[], now = new Date().toISOString()): Promise<Job[]> {
  const boards = new Map<string, BoardConfig>();
  for (const job of jobs) {
    const posting = importedPosting(job.importUrl ?? job.url);
    if (posting) boards.set(`${posting.board.source}:${posting.board.slug}:${posting.board.region ?? "global"}`, posting.board);
  }
  const results = new Map<string, Job[] | null>();
  const pending = [...boards.entries()];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (cursor < pending.length) {
      const [key, board] = pending[cursor++];
      try { results.set(key, await fetchBoard(board, { includeUnlisted: true, strictCatalog: true })); }
      catch { results.set(key, null); }
    }
  }));
  return jobs.map((job) => {
    const posting = importedPosting(job.importUrl ?? job.url);
    if (!posting) return { ...job, importCheck: { status: "manual", checkedAt: now,
      message: "This link needs manual verification on the employer site; automatic monitoring is unavailable." } };
    const fetched = results.get(`${posting.board.source}:${posting.board.slug}:${posting.board.region ?? "global"}`);
    if (!fetched) return { ...job, importCheck: { status: "unavailable", checkedAt: now,
      message: "The provider could not be checked. Availability and previously saved details are unconfirmed." } };
    const found = fetched.find((item) => item.sourceId === posting.sourceId ||
      canonicalJobUrl(item.url) === canonicalJobUrl(job.url));
    if (!found) {
      // Ashby supports direct-link unlisted jobs. Absence alone cannot prove
      // that an imported direct link is closed.
      if (posting.board.source === "ashby") return { ...job, importCheck: { status: "unavailable", checkedAt: now,
        message: "This role is absent from the public board. Check its direct link to confirm availability." } };
      return { ...job, active: false, lastCheckedAt: now,
        importCheck: { status: "closed", checkedAt: now, message: "This role is no longer published on its provider board." } };
    }
    return { ...found, id: job.id, importUrl: job.importUrl ?? job.url, discoveredAt: job.discoveredAt, lastCheckedAt: now,
      importCheck: { status: "verified", checkedAt: now } };
  });
}

export function applyImportedRefresh(state: AppState, before: Job[], refreshed: Job[]): number {
  const originals = new Map(before.map((job) => [job.id, job]));
  const updates = new Map(refreshed.map((job) => [job.id, job]));
  let changed = 0;
  state.importedJobs = (state.importedJobs ?? []).map((current) => {
    const original = originals.get(current.id);
    const updated = updates.get(current.id);
    if (!original || !updated || current.url !== original.url || current.importUrl !== original.importUrl ||
      (current.importCheck?.checkedAt || "") > (updated.importCheck?.checkedAt || "")) return current;
    changed++;
    for (const key of Object.keys(state.matchCache ?? {}))
      if (key.startsWith(`${current.id}:`)) delete state.matchCache![key];
    return updated;
  });
  const current = new Map(state.importedJobs.map((job) => [job.id, job]));
  state.jobs = state.jobs.map((job) => current.get(job.id) ?? job);
  return changed;
}
