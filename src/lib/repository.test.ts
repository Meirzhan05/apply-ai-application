import { afterEach, describe, expect, it, vi } from "vitest";
import { loadState } from "@/lib/repository";
import { readActiveCatalogRows } from "@/lib/catalog";
import { adminSupabase } from "@/lib/supabase-admin";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication } from "@/lib/workflow";

vi.mock("@/lib/catalog", () => ({ readActiveCatalogRows: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("catalog identities in owner state", () => {
  it("keeps a selected source alias active while deduplicating discovery", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const state = initialDemoState();
    state.profile.demo = false;
    const original = state.jobs[0];
    const selected = selectApplication(state, original.id, state.profile.id);
    const alias = { ...original, id: "other-source:alias" };
    vi.mocked(readActiveCatalogRows).mockResolvedValue([alias, original].map((job) => ({ id: job.id, data: job, discovered_at: job.discoveredAt })));
    const query: Record<string, unknown> = {};
    Object.assign(query, { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { data: state }, error: null }) });
    vi.mocked(adminSupabase).mockReturnValue({ from: () => query } as unknown as ReturnType<typeof adminSupabase>);
    const loaded = await loadState(state.profile.id);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0].id).toBe(selected.jobId);
    expect(loaded.jobs[0].active).toBe(true);
  });
});
