import { beforeEach, describe, expect, it, vi } from "vitest";
import { readActiveCatalogRows, type CatalogRow } from "@/lib/catalog";
import { adminSupabase } from "@/lib/supabase-admin";
import { initialDemoState } from "@/lib/demo-data";

vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function database(count: number, serverCap = 500, onPage?: (page: number, rows: CatalogRow[]) => void) {
  const base = initialDemoState().jobs[0];
  let rows: CatalogRow[] = Array.from({ length: count }, (_, i) => {
    const id = `job:${String(i).padStart(6, "0")}`;
    return { id, data: { ...base, id }, discovered_at: base.discoveredAt };
  });
  let page = 0;
  const cursors: Array<string | undefined> = [];
  const from = vi.fn(() => {
    let cursor: string | undefined;
    let requested = 0;
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: () => query,
      eq: () => query,
      order: (key: string, options: { ascending: boolean }) => { expect(key).toBe("id"); expect(options.ascending).toBe(true); return query; },
      limit: (amount: number) => { requested = amount; return query; },
      gt: (key: string, value: string) => { expect(key).toBe("id"); cursor = value; return query; },
      then: (resolve: (value: { data: CatalogRow[]; error: null }) => unknown) => {
        onPage?.(page++, rows);
        cursors.push(cursor);
        return Promise.resolve({ data: rows.filter((row) => !cursor || row.id > cursor).slice(0, Math.min(requested, serverCap)), error: null }).then(resolve);
      },
    });
    return query;
  });
  vi.mocked(adminSupabase).mockReturnValue({ from } as unknown as ReturnType<typeof adminSupabase>);
  return { from, cursors, deleteFirst: (amount: number) => { rows = rows.slice(amount); } };
}

describe("complete shared catalog reads", () => {
  it("reads beyond both the old 500-row cut and the usual 1000-row server cap", async () => {
    const db = database(1501);
    const rows = await readActiveCatalogRows();
    expect(rows).toHaveLength(1501);
    expect(new Set(rows.map((row) => row.id)).size).toBe(1501);
    expect(db.cursors).toEqual([undefined, "job:000499", "job:000999", "job:001499", "job:001500"]);
  });

  it("continues after short pages imposed by a lower server cap", async () => {
    const db = database(5, 2);
    expect(await readActiveCatalogRows()).toHaveLength(5);
    expect(db.from).toHaveBeenCalledTimes(4);
  });

  it("does not skip later rows when earlier rows disappear between pages", async () => {
    const db = database(1501, 500, (page) => { if (page === 1) db.deleteFirst(250); });
    expect((await readActiveCatalogRows()).at(-1)?.id).toBe("job:001500");
    expect(db.cursors[1]).toBe("job:000499");
  });

  it("fails a partial read instead of returning a truncated catalog", async () => {
    const query: Record<string, unknown> = {};
    Object.assign(query, { select: () => query, eq: () => query, order: () => query, limit: () => query, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "Database unavailable" } }).then(resolve) });
    vi.mocked(adminSupabase).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof adminSupabase>);
    await expect(readActiveCatalogRows()).rejects.toMatchObject({ message: "Database unavailable" });
  });
});
