import { afterEach, describe, expect, it, vi } from "vitest";
import { loadState } from "@/lib/repository";
import { adminSupabase } from "@/lib/supabase-admin";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication } from "@/lib/workflow";
import { personalSearchKey } from "@/lib/personal-search-input";
import type { AppState } from "@/lib/types";
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup(owners: Record<string, Partial<AppState>>) {
  vi.stubEnv("DEMO_MODE", "false");
  const from = vi.fn((table: string) => {
    if (table !== "app_states") throw new Error("Fresh accounts must not read the shared catalog");
    let owner = "";
    const query = { select: () => query, eq: (_key: string, value: string) => { owner = value; return query; }, maybeSingle: async () => ({ data: owners[owner] ? { data: owners[owner] } : null, error: null }) };
    return query;
  });
  vi.mocked(adminSupabase).mockReturnValue({ from } as unknown as ReturnType<typeof adminSupabase>);
  return from;
}
describe("private owner discovery", () => {
  it("starts a newly registered account with no jobs, matches, or demo facts", async () => {
    const from = setup({});
    const state = await loadState("new-student");
    expect(state.jobs).toEqual([]); expect(state.profile.facts).toEqual([]);
    expect(state.profile.name).toBe(""); expect(state.profile.demo).toBe(false);
    expect(from).toHaveBeenCalledExactlyOnceWith("app_states");
  });
  it("does not expose another student's discovered jobs", async () => {
    const state = initialDemoState();
    state.personalSearch = { status: "complete", requestId: "a", profileKey: personalSearchKey(state.profile), resultsKey: personalSearchKey(state.profile), requestedAt: "2026-10-02", jobs: [state.jobs[0]] };
    setup({ "student-a": state });
    expect((await loadState("student-a")).jobs).toHaveLength(1);
    expect((await loadState("student-b")).jobs).toEqual([]);
  });
  it("hides old discovery after a preference change while preserving manual imports and selected applications", async () => {
    const state = initialDemoState(); const selected = selectApplication(state, state.jobs[0].id, state.profile.id);
    state.personalSearch = { status: "complete", requestId: "a", profileKey: personalSearchKey(state.profile), resultsKey: personalSearchKey(state.profile), requestedAt: "2026-10-02", jobs: state.jobs };
    state.importedJobs = [{ ...state.jobs[1], id: "my-import", url: "https://example.com/my-import" }];
    state.profile.preferredTitles = ["A different profession"];
    setup({ "student-a": state });
    const loaded = await loadState("student-a");
    expect(loaded.jobs.map((job) => job.id)).toEqual(expect.arrayContaining([selected.jobId, "my-import"]));
    expect(loaded.jobs.some((job) => job.id === state.jobs[2].id)).toBe(false);
  });
  it("preserves selected posting identity when two personal results share a URL", async () => {
    const state = initialDemoState(); const original = state.jobs[0];
    const selected = selectApplication(state, original.id, state.profile.id);
    state.personalSearch = { status: "complete", requestId: "a", profileKey: personalSearchKey(state.profile), resultsKey: personalSearchKey(state.profile), requestedAt: "2026-10-02", jobs: [{ ...original, id: "alias" }, original] };
    setup({ "student-a": state });
    const loaded = await loadState("student-a");
    expect(loaded.jobs).toHaveLength(1); expect(loaded.jobs[0].id).toBe(selected.jobId);
    expect(loaded.jobs[0].active).toBe(true);
  });
});
