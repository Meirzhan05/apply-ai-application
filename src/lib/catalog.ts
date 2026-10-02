import { adminSupabase } from "@/lib/supabase-admin";
import type { Job } from "@/lib/types";

export interface CatalogRow { id: string; data: Job; discovered_at: string }

let cached: { revision: string; rows: CatalogRow[] } | undefined;
let pending: { revision: string; rows: Promise<CatalogRow[]> } | undefined;

export async function readCatalogRevision(): Promise<string> {
  const { data, error } = await adminSupabase().from("catalog_revision").select("revision").eq("id", true).single();
  if (error) throw error;
  return String(data.revision);
}

// Only the public shared catalog is cached. Owner state stays request-scoped.
// A database trigger updates the revision for writes from any app or worker.
export async function readActiveCatalogRows(options?: { cache: boolean }): Promise<CatalogRow[]> {
  if (!options?.cache) return readRows();
  const revision = await readCatalogRevision();
  if (cached?.revision === revision) return structuredClone(cached.rows);
  if (pending?.revision === revision) return structuredClone(await pending.rows);
  const rows = readRows();
  const loading = { revision, rows };
  pending = loading;
  try {
    const result = await rows;
    // Do not cache a scan that overlapped a catalog write or a newer scan.
    if (await readCatalogRevision() === revision && pending === loading) cached = { revision, rows: result };
    return structuredClone(result);
  } finally {
    if (pending === loading) pending = undefined;
  }
}

async function readRows(): Promise<CatalogRow[]> {
  const client = adminSupabase();
  const rows: CatalogRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    let query = client.from("jobs").select("id,data,discovered_at").eq("active", true).order("id", { ascending: true }).limit(500);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return rows;
    const page = data as CatalogRow[];
    const next = page.at(-1)?.id;
    if (!next || next === cursor) throw new Error("Catalog pagination did not advance.");
    rows.push(...page);
    cursor = next;
    // Continue until empty, even when a configured server row cap is lower
    // than the requested page size. IDs are immutable, so deletions cannot
    // shift subsequent pages the way offsets can.
  }
}
