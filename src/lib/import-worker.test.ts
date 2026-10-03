import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { newImportedJob } from "@/lib/import-jobs";
import type { AppState } from "@/lib/types";
import { refreshUserImports } from "../../trigger/imports";

const mocks = vi.hoisted(() => ({ load: vi.fn(), mutate: vi.fn(), refresh: vi.fn(), queue: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ task: (config: unknown) => config }));
vi.mock("@/lib/repository", () => ({ loadState: mocks.load, mutateState: mocks.mutate }));
vi.mock("@/lib/import-jobs", async (original) => ({ ...await original<typeof import("@/lib/import-jobs")>(), refreshImportedJobs: mocks.refresh }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: mocks.queue }));
const taskRun = (refreshUserImports as unknown as { run: (payload: { userId: string }, options: { ctx: { run: { id: string } } }) => Promise<Record<string, unknown>> }).run;
const run = (payload: { userId: string }) => taskRun(payload, { ctx: { run: { id: "synthetic-import-run" } } });
let state: AppState;
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic");
  state = initialDemoState();
  state.importedJobs = [newImportedJob({ url: "https://boards.greenhouse.io/acme/jobs/42" })];
  state.jobs = [...state.importedJobs];
  mocks.load.mockImplementation(async () => structuredClone(state));
  mocks.refresh.mockImplementation(async (jobs) => jobs.map((job: AppState["jobs"][number]) => ({ ...job, title: "Refreshed", importCheck: { status: "verified", checkedAt: "2026-09-30" } })));
  mocks.mutate.mockImplementation(async (_owner, change) => change(state));
  mocks.queue.mockResolvedValue({ id: "fixture-run" });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
describe("owner import refresh worker", () => {
  it("persists imports before queuing matching with the same owner", async () => {
    expect(await run({ userId: "owner-a" })).toEqual({ checked: 1, verified: 1, closed: 0, unavailable: 0 });
    expect(mocks.load).toHaveBeenCalledWith("owner-a");
    expect(mocks.mutate).toHaveBeenCalledWith("owner-a", expect.any(Function));
    expect(state.importedJobs![0].title).toBe("Refreshed");
    expect(mocks.queue).toHaveBeenCalledWith("owner-a");
    expect(mocks.mutate.mock.invocationCallOrder[0]).toBeLessThan(mocks.queue.mock.invocationCallOrder[0]);
  });
  it("does nothing when the owner has no imports", async () => {
    state.importedJobs = [];
    expect(await run({ userId: "owner-a" })).toEqual({ checked: 0 });
    expect(mocks.refresh).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("refreshes without model credentials", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await run({ userId: "owner-a" })).toMatchObject({ checked: 1 });
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("stops on an owner deleted during the network lookup", async () => {
    mocks.mutate.mockRejectedValue({ code: "23503", message: 'violates foreign key constraint "app_states_user_id_fkey"' });
    expect(await run({ userId: "owner-a" })).toEqual({ checked: 0, stopped: "owner_removed" });
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("surfaces unrelated database failures", async () => {
    mocks.mutate.mockRejectedValue({ code: "08006", message: "Database unavailable" });
    await expect(run({ userId: "owner-a" })).rejects.toMatchObject({ code: "08006" });
  });
});
