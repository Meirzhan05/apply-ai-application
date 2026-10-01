import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshCatalog } from "@/lib/catalog-refresh";
import { configuredBoards, fetchBoard } from "@/lib/sources";
import { readActiveCatalogRows } from "@/lib/catalog";
import { saveCatalog } from "@/lib/repository";
import { adminSupabase } from "@/lib/supabase-admin";
import { initialDemoState } from "@/lib/demo-data";

vi.mock("@/lib/repository", () => ({ isDemo: () => false, saveCatalog: vi.fn() }));
vi.mock("@/lib/catalog", () => ({ readActiveCatalogRows: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));
vi.mock("@/lib/sources", async (original) => ({ ...await original<typeof import("@/lib/sources")>(), configuredBoards: vi.fn(), fetchBoard: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("catalog closure and posting aliases", () => {
  it("retains both source identities and closes only missing jobs on a successful board", async () => {
    const base = initialDemoState().jobs[0];
    const first = { ...base, id: "greenhouse:acme:1" };
    const alias = { ...base, id: "greenhouse:acme:2" };
    const stale = { ...base, id: "greenhouse:acme:gone" };
    const unavailable = { ...base, id: "lever:other:old" };
    vi.mocked(configuredBoards).mockReturnValue([{ source: "greenhouse", slug: "acme" }, { source: "lever", slug: "other" }]);
    vi.mocked(fetchBoard).mockImplementation(async (board) => { if (board.source === "lever") throw new Error("429"); return [first, alias]; });
    vi.mocked(readActiveCatalogRows).mockResolvedValue([first, alias, stale, unavailable].map((job) => ({ id: job.id, data: job, discovered_at: job.discoveredAt })));
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn(() => ({ eq }));
    vi.mocked(adminSupabase).mockReturnValue({ from: () => ({ update }) } as unknown as ReturnType<typeof adminSupabase>);
    const result = await refreshCatalog();
    expect(result).toMatchObject({ sources: 1, jobs: 1, closed: 1, sourceStatus: [expect.objectContaining({ source: "greenhouse:acme", status: "available" }), expect.objectContaining({ source: "lever:other", status: "unavailable" })] });
    expect(result.errors[0]).toContain("429");
    expect(result.arrivals).toHaveLength(0);
    expect(saveCatalog).toHaveBeenCalledWith([first, alias]);
    expect(eq).toHaveBeenCalledExactlyOnceWith("id", stale.id);
  });
});
