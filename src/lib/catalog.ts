import { adminSupabase } from "@/lib/supabase-admin";
import type { Job } from "@/lib/types";

export interface CatalogRow { id: string; data: Job; discovered_at: string }

export async function readActiveCatalogRows(): Promise<CatalogRow[]> {
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
