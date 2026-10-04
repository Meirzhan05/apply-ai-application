import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
const mocks = vi.hoisted(() => ({ states: new Map<string, AppState>(), provider: vi.fn(), trigger: vi.fn(), reserve: vi.fn(), match: vi.fn() }));
vi.mock("@/lib/repository", () => ({ isDemo: () => false, loadState: async (owner: string) => structuredClone(mocks.states.get(owner)),
  mutateState: async (owner: string, change: (state: AppState) => unknown) => change(mocks.states.get(owner)!) }));
vi.mock("@/lib/account-lifecycle", () => ({ withAccountOperation: async (_owner: string, _op: string, work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/personal-search-provider", () => ({ discoverPersonalJobs: mocks.provider }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: mocks.reserve }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: mocks.match }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
import { queuePersonalSearch, runPersonalSearch } from "@/lib/personal-search";
import { personalSearchReadiness } from "@/lib/personal-search-policy";
import { personalSearchInput } from "@/lib/personal-search-input";

beforeEach(() => {
  vi.clearAllMocks(); mocks.states.clear();
  vi.stubEnv("OPENAI_API_KEY", "fixture"); vi.stubEnv("TRIGGER_SECRET_KEY", "fixture");
  for (const id of ["student-a", "student-b"]) {
    const state = initialDemoState(); state.profile.id = id; state.jobs = []; mocks.states.set(id, state);
  }
  mocks.reserve.mockResolvedValue(true); mocks.trigger.mockResolvedValue({ id: "run" }); mocks.match.mockResolvedValue({ id: "match" });
  mocks.provider.mockImplementation(async (_profile, guard) => { await guard(); return [initialDemoState().jobs[0]]; });
});

describe("personal student discovery", () => {
  it("waits for confirmed profile and an explicit save of blank preferences", async () => {
    const state = mocks.states.get("student-a")!;
    state.profile.preferredTitles = []; state.profile.preferredLocations = []; state.profile.remoteOnly = false;
    expect(personalSearchReadiness(state.profile).ready).toBe(false);
    expect(await queuePersonalSearch("student-a")).toBe(false);
    state.profile.searchPreferencesConfirmedAt = new Date().toISOString();
    expect(await queuePersonalSearch("student-a")).toBe(true);
    state.profile.facts.forEach((fact) => fact.verified = false);
    expect(personalSearchReadiness(state.profile).ready).toBe(false);
  });
  it("dispatches once, publishes only to the owner, and matches their verified results", async () => {
    expect(await queuePersonalSearch("student-a")).toBe(true);
    expect(await queuePersonalSearch("student-a")).toBe(false);
    const requestId = mocks.states.get("student-a")!.personalSearch!.requestId;
    expect(mocks.trigger).toHaveBeenCalledWith("discover-user-jobs", { userId: "student-a", requestId }, expect.objectContaining({ concurrencyKey: "student-a", tags: ["owner:student-a"] }));
    expect(await runPersonalSearch("student-a", requestId)).toMatchObject({ discovered: 1 });
    expect(mocks.states.get("student-a")!.personalSearch!.jobs).toHaveLength(1);
    expect(mocks.states.get("student-b")!.personalSearch).toBeUndefined();
    await runPersonalSearch("student-a", requestId);
    expect(mocks.provider).toHaveBeenCalledOnce();
    expect(mocks.match).toHaveBeenCalledExactlyOnceWith("student-a");
    expect(await queuePersonalSearch("student-a", true)).toBe(false);
  });
  it("discards results when search preferences change while the provider is running", async () => {
    await queuePersonalSearch("student-a");
    const requestId = mocks.states.get("student-a")!.personalSearch!.requestId;
    mocks.provider.mockImplementationOnce(async () => {
      mocks.states.get("student-a")!.profile.preferredTitles = ["Nursing internship"];
      return [initialDemoState().jobs[0]];
    });
    expect(await runPersonalSearch("student-a", requestId)).toMatchObject({ discovered: 0, stale: true });
    expect(mocks.states.get("student-a")!.personalSearch!.jobs).toEqual([]);
    expect(mocks.match).not.toHaveBeenCalled();
    expect(await queuePersonalSearch("student-a")).toBe(true);
  });
  it("does not call the paid provider after budget denial", async () => {
    await queuePersonalSearch("student-a"); mocks.reserve.mockResolvedValue(false);
    await runPersonalSearch("student-a", mocks.states.get("student-a")!.personalSearch!.requestId);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.states.get("student-a")!.personalSearch!.status).toBe("budget_limited");
  });
  it("records a dispatch failure and makes scheduled dispatch failures visible", async () => {
    mocks.trigger.mockRejectedValue(new Error("unavailable"));
    expect(await queuePersonalSearch("student-a")).toBe(false);
    expect(mocks.states.get("student-a")!.personalSearch!.status).toBe("failed");
    await expect(queuePersonalSearch("student-b", true)).rejects.toThrow("dispatch failed");
  });
  it("does not fall back to a shared feed if personal search fails", async () => {
    await queuePersonalSearch("student-a"); mocks.provider.mockRejectedValue(new Error("timeout"));
    await runPersonalSearch("student-a", mocks.states.get("student-a")!.personalSearch!.requestId);
    expect(mocks.states.get("student-a")!.personalSearch).toMatchObject({ status: "failed", jobs: [] });
    expect(mocks.match).not.toHaveBeenCalled();
  });
  it("sends only redacted career facts and preferences to web search", () => {
    const profile = mocks.states.get("student-a")!.profile;
    profile.name = "Private Student"; profile.email = "private@example.com"; profile.phone = "555-222-4444";
    profile.facts = [{ id: "a", source: "user", verified: true, text: "Private Student built a Python project; private@example.com" }, { id: "b", source: "user", verified: false, text: "Unconfirmed secret" }];
    profile.sensitiveAnswers = { gender: "protected answer" }; profile.resumeText = "raw private resume";
    const input = JSON.stringify(personalSearchInput(profile));
    for (const value of [profile.name, profile.email, profile.phone, "protected answer", "Unconfirmed secret", "raw private resume", "resumeSourceDocument"]) expect(input).not.toContain(value);
    expect(input).toContain("Python project");
  });
});

it("manual search bypasses the refresh interval but still prevents duplicate active runs", async () => {
  await queuePersonalSearch("student-a");
  const before = mocks.states.get("student-a")!.personalSearch!.requestId;
  await runPersonalSearch("student-a", before);
  expect(await queuePersonalSearch("student-a")).toBe(false);
  expect(await queuePersonalSearch("student-a", false, { force: true })).toBe(true);
  const after = mocks.states.get("student-a")!.personalSearch!.requestId;
  expect(after).not.toBe(before);
  expect(await queuePersonalSearch("student-a", false, { force: true })).toBe(false);
  expect(mocks.trigger).toHaveBeenCalledTimes(2);
});
it("manual search still respects profile readiness and the shared service budget", async () => {
  mocks.states.get("student-a")!.profile.facts = [];
  expect(await queuePersonalSearch("student-a", false, { force: true })).toBe(false);
  await queuePersonalSearch("student-b", false, { force: true });
  mocks.reserve.mockResolvedValue(false);
  await runPersonalSearch("student-b", mocks.states.get("student-b")!.personalSearch!.requestId);
  expect(mocks.states.get("student-b")!.personalSearch!.status).toBe("budget_limited");
  expect(mocks.provider).not.toHaveBeenCalled();
});
