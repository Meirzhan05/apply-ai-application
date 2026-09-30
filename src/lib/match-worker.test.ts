import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import { assessUserMatches } from "../../trigger/matches";
import { matchKey } from "@/lib/match-cache";

const mocks = vi.hoisted(() => ({ load: vi.fn(), mutate: vi.fn(), assess: vi.fn(), reserve: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ task: (config: unknown) => config }));
vi.mock("@/lib/repository", () => ({ loadState: mocks.load, mutateState: mocks.mutate }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: mocks.reserve }));
vi.mock("@/lib/matching", async (original) => ({ ...await original<typeof import("@/lib/matching")>(), assessMatch: mocks.assess }));

const run = (assessUserMatches as unknown as { run: (payload: { userId: string }) => Promise<Record<string, unknown>> }).run;
let state: AppState;
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
  state = initialDemoState();
  state.jobs = state.jobs.slice(0, 2);
  state.matchCache = {};
  mocks.load.mockImplementation(async () => structuredClone(state));
  mocks.mutate.mockImplementation(async (_id: string, change: (current: AppState) => unknown) => change(state));
  mocks.reserve.mockResolvedValue(true);
  mocks.assess.mockResolvedValue({ version: 1, category: "uncertain", score: 0, evidence: [], gaps: [], uncertainty: ["Synthetic worker fixture"], model: "fixture", evaluatedAt: "2026-09-29" });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("matching worker account and profile lifecycle", () => {
  it("avoids paid assessments when there are no confirmed facts", async () => {
    state.profile.facts.forEach((fact) => { fact.verified = false; });
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 0 });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.assess).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("stops when the profile changes before the model call", async () => {
    mocks.load.mockResolvedValueOnce(structuredClone(state));
    state.profile.updatedAt = "changed-profile";
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 0, stopped: "profile_changed" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.assess).not.toHaveBeenCalled();
  });
  it("discards an assessment if its confirmed profile changes in flight", async () => {
    mocks.assess.mockImplementation(async () => { state.profile.updatedAt = "changed-profile"; return { category: "strong" }; });
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 0, stopped: "profile_changed" });
    expect(state.matchCache).toEqual({});
    expect(mocks.assess).toHaveBeenCalledOnce();
  });
  it("stops cleanly when Auth deletion removes the state during a model call", async () => {
    mocks.mutate.mockRejectedValue({ code: "23503", message: 'insert or update on table "app_states" violates foreign key constraint "app_states_user_id_fkey"' });
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 0, stopped: "owner_removed" });
    expect(mocks.assess).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });
  it.each([
    { code: "23503", message: 'violates foreign key constraint "another_user_id_fkey"' },
    { code: "08006", message: "Database unavailable" },
  ])("preserves unrelated database failures: $code", async (error) => {
    mocks.mutate.mockRejectedValue(error);
    await expect(run({ userId: state.profile.id })).rejects.toEqual(error);
  });
  it("counts and caches only completed current-profile assessments", async () => {
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 2 });
    for (const job of state.jobs) expect(state.matchCache![matchKey(state.profile, job)]?.model).toBe("fixture");
    expect(mocks.assess).toHaveBeenCalledTimes(2);
  });
  it("does not call the model after the service budget is exhausted", async () => {
    mocks.reserve.mockResolvedValue(false);
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 0 });
    expect(mocks.assess).not.toHaveBeenCalled();
  });
});
