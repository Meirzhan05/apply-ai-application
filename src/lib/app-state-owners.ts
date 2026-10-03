import { adminSupabase } from "@/lib/supabase-admin";

const OWNER_PAGE_SIZE = 1000;

export type AppStateOwnerRow = { user_id: string; data?: unknown };

export async function readAllAppStateOwners<T extends AppStateOwnerRow = AppStateOwnerRow>(select: string, pageSize = OWNER_PAGE_SIZE): Promise<T[]> {
  const owners: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    let query = adminSupabase()
      .from("app_states")
      .select(select)
      .order("user_id", { ascending: true });
    if (cursor) query = query.gt("user_id", cursor);
    const { data, error } = await query.range(0, pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as T[];
    owners.push(...page);
    if (page.length < pageSize) break;
    const next = page.at(-1)?.user_id;
    if (!next || next === cursor) throw new Error("Owner pagination did not advance.");
    cursor = next;
  }
  return owners;
}
