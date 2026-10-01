import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import { assessUserMatches } from "../../trigger/matches";
import { matchKey } from "@/lib/match-cache";
import { issueControlledTestGrant } from "@/lib/controlled-tests";
import { selectApplication } from "@/lib/workflow";

const mocks = vi.hoisted(() => ({ load: vi.fn(), mutate: vi.fn(), assess: vi.fn(), reserve: vi.fn(), autoQueue: vi.fn(), append: vi.fn(), continueQueue: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ task: (config: unknown) => config }));
vi.mock("@/lib/repository", () => ({ loadState: mocks.load, mutateState: mocks.mutate }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: mocks.reserve }));
vi.mock("@/lib/matching", async (original) => ({ ...await original<typeof import("@/lib/matching")>(), assessMatch: mocks.assess }));
vi.mock("@/lib/discovery", () => ({ enqueueStrongMatch: mocks.autoQueue, appendDiscoveryEvent: mocks.append }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: mocks.continueQueue }));

const run = (assessUserMatches as unknown as { run: (payload: { userId: string; continuationToken?: string }) => Promise<Record<string, unknown>> }).run;
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
  mocks.autoQueue.mockResolvedValue({ queued: false, reason: "automation_blocked" });
  mocks.continueQueue.mockResolvedValue({ id: "continuation" });
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
  it("hands a current strong assessment to the serialized autonomous queue", async () => {
    state.jobs = state.jobs.slice(0, 1);
    mocks.assess.mockResolvedValue({ version: 1, category: "strong", score: 90, evidence: ["Synthetic confirmed evidence"], gaps: [], uncertainty: [], model: "fixture", evaluatedAt: "2026-10-01T12:00:00.000Z" });
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 1 });
    expect(mocks.autoQueue).toHaveBeenCalledExactlyOnceWith(state.profile.id, state.jobs[0].id, state.profile.updatedAt);
  });
  it("skips real catalog jobs before reserving or calling the model for a controlled owner", async () => {
    vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-controlled-secret");
    state.profile.id = "11111111-1111-4111-8111-111111111111";
    state.profile.workAuthorization = "Authorized to work in the US";
    const fixtureJob = { ...state.jobs[0], id: "controlled-fixture-job", url: "https://controlled.example.test/fixture", applyUrl: "https://controlled.example.test/fixture" };
    const realJob = { ...state.jobs[1], id: "real-catalog-job", sourceId: "real-catalog-job", url: "https://employer.example/jobs/real", applyUrl: "https://employer.example/jobs/real" };
    state.jobs = [fixtureJob, realJob];
    const application = selectApplication(state, fixtureJob.id, state.profile.id);
    const issued = issueControlledTestGrant(state.profile.id, application.id);
    fixtureJob.url = fixtureJob.applyUrl = `https://controlled.example.test/fixture?token=${issued.token}`;
    application.jobSnapshot = structuredClone(fixtureJob);
    application.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0 };
    mocks.assess.mockImplementation(async (_profile: unknown, job: { id: string }) => ({ version: 1, category: "uncertain", score: 0, evidence: [], gaps: [], uncertainty: [job.id], model: "fixture", evaluatedAt: "2026-10-01T12:00:00.000Z" }));
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 1 });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.assess).toHaveBeenCalledExactlyOnceWith(state.profile, expect.objectContaining({ id: fixtureJob.id }));
  });
  it("persists and resumes a current-profile continuation after twelve jobs", async () => {
    state.jobs = Array.from({ length: 13 }, (_, index) => ({ ...state.jobs[0], id: `job-${index}`, sourceId: `job-${index}`, url: `https://jobs.example/${index}`, applyUrl: `https://jobs.example/${index}` }));
    mocks.assess.mockImplementation(async (_profile: unknown, job: { id: string }) => ({ version: 1, category: "uncertain", score: 0, evidence: [], gaps: [], uncertainty: [job.id], model: "fixture", evaluatedAt: "2026-10-01T12:00:00.000Z" }));
    expect(await run({ userId: state.profile.id })).toMatchObject({ assessed: 12, continued: true, pending: 1 });
    const token = state.discovery?.matchContinuation?.token;
    expect(token).toBeTruthy();
    expect(mocks.continueQueue).toHaveBeenCalledExactlyOnceWith(state.profile.id, token);
    expect(await run({ userId: state.profile.id, continuationToken: token })).toEqual({ assessed: 1 });
    expect(state.discovery?.pendingMatches).toBe(0);
    expect(state.discovery?.matchContinuation).toBeUndefined();
  });
  it("does not call the model after the service budget is exhausted", async () => {
    mocks.reserve.mockResolvedValue(false);
    expect(await run({ userId: state.profile.id })).toEqual({ assessed: 0 });
    expect(mocks.assess).not.toHaveBeenCalled();
  });
});
