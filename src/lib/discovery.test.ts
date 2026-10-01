import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import type { DiscoveryRefreshReport } from "@/lib/discovery";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  dispatch: vi.fn(),
  assertAutomation: vi.fn(),
}));

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

vi.mock("@/lib/repository", () => ({ mutateState: mocks.mutate }));
vi.mock("@/lib/application-queue", () => ({ dispatchUserQueue: mocks.dispatch }));
vi.mock("@/lib/autonomous-policy", () => ({
  assertAutomationEnabled: mocks.assertAutomation,
  assertAutonomous: vi.fn(),
  authorizeKnownAnswerApplication: (application: { autonomousAuthorization?: unknown }, profile: { id: string; automationVersion: number }, job: { applyUrl: string; url: string }) => {
    application.autonomousAuthorization = { version: 1, userId: profile.id, profileVersion: profile.automationVersion, targetUrl: job.applyUrl, expectedFormUrl: job.applyUrl, expectedSubmitAction: job.applyUrl, authorizedAt: "2026-10-01T12:00:00.000Z", profileHash: "profile", jobHash: "job", postingIdentity: job.url };
  },
}));

import { appendDiscoveryEvent, autonomousMatchBlockReason, enqueueStrongMatch, recordDiscoveryRefresh } from "@/lib/discovery";
import { issueControlledTestGrant } from "@/lib/controlled-tests";
import { selectApplication } from "@/lib/workflow";

function report(): DiscoveryRefreshReport {
  return {
    refreshedAt: "2026-10-01T12:00:00.000Z",
    sourceStatus: [{ source: "greenhouse", status: "available", checkedAt: "2026-10-01T12:00:00.000Z" }, { source: "lever", status: "unavailable", checkedAt: "2026-10-01T12:00:00.000Z", error: "429" }],
    arrivals: [{ jobId: "new-job", source: "greenhouse", discoveredAt: "2026-10-01T08:00:00.000Z" }],
  };
}

describe("discovery policy and telemetry", () => {
  it("keeps missing legal facts and uncertain postings out of autonomous matching", () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    const assessment = { version: 1 as const, category: "strong" as const, score: 90, evidence: ["confirmed"], gaps: [], uncertainty: [], evaluatedAt: "2026-10-01T12:00:00.000Z", model: "fixture" };
    expect(autonomousMatchBlockReason(state.profile, job, assessment)).toMatch(/work authorization/i);
    state.profile.workAuthorization = "Authorized to work in the US";
    expect(autonomousMatchBlockReason(state.profile, job, { ...assessment, evidence: [] })).toMatch(/evidence/i);
    expect(autonomousMatchBlockReason(state.profile, { ...job, active: false }, assessment)).toMatch(/closed/i);
  });

  it("records arrivals, unavailable sources, and bounded operational history", () => {
    const state = initialDemoState();
    recordDiscoveryRefresh(state, report());
    expect(state.discovery?.lastRefreshAt).toBe(report().refreshedAt);
    expect(state.discovery?.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "lever", status: "unavailable", error: "429" })]));
    expect(state.discovery?.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "arrived", jobId: "new-job", delayMs: 4 * 60 * 60 * 1000 }), expect.objectContaining({ kind: "unavailable", source: "lever" })]));
    for (let index = 0; index < 130; index++) appendDiscoveryEvent(state, { kind: "matched", at: `2026-10-01T12:${String(index % 60).padStart(2, "0")}:00.000Z`, detail: "fixture" });
    expect(state.discovery?.events).toHaveLength(132);
  });

  it("queues one current strong match and replays it without a duplicate", async () => {
    const state = initialDemoState();
    state.profile.workAuthorization = "Authorized to work in the US";
    const job = state.jobs[0];
    state.matchCache = { [`${job.id}:fixture`]: { version: 1, category: "strong", score: 90, evidence: ["SQL"], gaps: [], uncertainty: [], evaluatedAt: "2026-10-01T12:00:00.000Z", model: "fixture" } };
    mocks.assertAutomation.mockImplementation(() => undefined);
    mocks.mutate.mockImplementation(async (_user: string, change: (current: AppState) => unknown) => change(state));
    mocks.dispatch.mockResolvedValue(undefined);
    const first = await enqueueStrongMatch(state.profile.id, job.id, state.profile.updatedAt, { cacheKey: `${job.id}:fixture` });
    const second = await enqueueStrongMatch(state.profile.id, job.id, state.profile.updatedAt, { cacheKey: `${job.id}:fixture` });
    expect(first.queued).toBe(true);
    expect(second.reason).toBe("duplicate");
    expect(state.applications).toHaveLength(1);
    expect(state.applications[0].queuedRun?.kind).toBe("draft");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    state.applications[0].queuedRun = undefined;
    const alias = { ...job, id: "alias-job", sourceId: "alias", url: `${job.url}?utm_source=refresh` };
    state.jobs.push(alias);
    state.matchCache["alias-job:fixture"] = state.matchCache[`${job.id}:fixture`];
    const aliasReplay = await enqueueStrongMatch(state.profile.id, alias.id, state.profile.updatedAt, { cacheKey: "alias-job:fixture" });
    expect(aliasReplay.queued).toBe(true);
    expect(state.applications).toHaveLength(1);
  });

  it("does not enqueue after profile drift or when automation is paused", async () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    state.profile.workAuthorization = "Authorized to work in the US";
    state.matchCache = { [`${job.id}:fixture`]: { version: 1, category: "strong", score: 90, evidence: ["SQL"], gaps: [], uncertainty: [], evaluatedAt: "2026-10-01T12:00:00.000Z", model: "fixture" } };
    mocks.mutate.mockImplementation(async (_user: string, change: (current: AppState) => unknown) => change(state));
    const drift = await enqueueStrongMatch(state.profile.id, job.id, "old-profile", { cacheKey: `${job.id}:fixture` });
    expect(drift).toEqual({ queued: false, reason: "profile_changed" });
    mocks.assertAutomation.mockImplementation(() => { throw new Error("Complete onboarding and enable your current automation settings before applying automatically."); });
    const paused = await enqueueStrongMatch(state.profile.id, job.id, state.profile.updatedAt, { cacheKey: `${job.id}:fixture` });
    expect(paused).toMatchObject({ queued: false, reason: "automation_blocked" });
  });

  it("does not recreate a cancelled canonical application on refresh replay", async () => {
    const state = initialDemoState();
    state.profile.workAuthorization = "Authorized to work in the US";
    const job = state.jobs[0];
    const cancelled = selectApplication(state, job.id, state.profile.id);
    cancelled.status = "cancelled";
    state.matchCache = { [`${job.id}:fixture`]: { version: 1, category: "strong", score: 90, evidence: ["confirmed"], gaps: [], uncertainty: [], evaluatedAt: "2026-10-01T12:00:00.000Z", model: "fixture" } };
    mocks.assertAutomation.mockImplementation(() => undefined);
    mocks.mutate.mockImplementation(async (_user: string, change: (current: AppState) => unknown) => change(state));
    const result = await enqueueStrongMatch(state.profile.id, job.id, state.profile.updatedAt, { cacheKey: `${job.id}:fixture` });
    expect(result).toEqual({ queued: false, reason: "duplicate" });
    expect(state.applications).toHaveLength(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("keeps controlled fixture owners from matching or queueing real catalog jobs", async () => {
    vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-controlled-secret");
    const state = initialDemoState();
    state.profile.id = "11111111-1111-4111-8111-111111111111";
    state.profile.workAuthorization = "Authorized to work in the US";
    const fixtureJob = { ...state.jobs[0], id: "controlled-fixture-job", url: "https://controlled.example.test/fixture", applyUrl: "https://controlled.example.test/fixture" };
    state.jobs = [fixtureJob, { ...state.jobs[0], id: "real-catalog-job", sourceId: "real-catalog-job", url: "https://employer.example/jobs/real", applyUrl: "https://employer.example/jobs/real" }];
    const fixtureApplication = selectApplication(state, fixtureJob.id, state.profile.id);
    const issued = issueControlledTestGrant(state.profile.id, fixtureApplication.id);
    fixtureJob.url = fixtureJob.applyUrl = `https://controlled.example.test/fixture?token=${issued.token}`;
    fixtureApplication.jobSnapshot = structuredClone(fixtureJob);
    fixtureApplication.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0 };
    state.matchCache = { [`real-catalog-job:fixture`]: { version: 1, category: "strong", score: 99, evidence: ["confirmed"], gaps: [], uncertainty: [], evaluatedAt: "2026-10-01T12:00:00.000Z", model: "fixture" } };
    mocks.assertAutomation.mockImplementation(() => undefined);
    mocks.mutate.mockImplementation(async (_user: string, change: (current: AppState) => unknown) => change(state));
    const result = await enqueueStrongMatch(state.profile.id, "real-catalog-job", state.profile.updatedAt, { cacheKey: "real-catalog-job:fixture" });
    expect(result).toEqual({ queued: false, reason: "ineligible" });
    expect(state.applications).toHaveLength(1);
    fixtureApplication.controlledTest.expiresAt = Date.now() - 1;
    const expired = await enqueueStrongMatch(state.profile.id, "real-catalog-job", state.profile.updatedAt, { cacheKey: "real-catalog-job:fixture" });
    expect(expired).toEqual({ queued: false, reason: "ineligible" });
  });

  it("carries a synthetic public arrival through match and queue within the freshness window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
    const state = initialDemoState();
    const job = state.jobs[0];
    state.profile.workAuthorization = "Authorized to work in the US";
    state.discovery = { sources: [], events: [] };
    recordDiscoveryRefresh(state, {
      refreshedAt: "2026-10-01T12:00:00.000Z",
      sourceStatus: [{ source: "synthetic:controlled", status: "available", checkedAt: "2026-10-01T12:00:00.000Z" }],
      arrivals: [{ jobId: job.id, source: "synthetic", discoveredAt: "2026-10-01T08:00:00.000Z" }],
    });
    appendDiscoveryEvent(state, { id: "matched-fixture", kind: "matched", jobId: job.id, source: "synthetic", at: "2026-10-01T11:00:00.000Z", arrivalAt: "2026-10-01T08:00:00.000Z", delayMs: 3 * 60 * 60 * 1000, detail: "Synthetic confirmed match." });
    state.matchCache = { [`${job.id}:fixture`]: { version: 1, category: "strong", score: 90, evidence: ["confirmed"], gaps: [], uncertainty: [], evaluatedAt: "2026-10-01T11:00:00.000Z", model: "fixture" } };
    mocks.assertAutomation.mockImplementation(() => undefined);
    mocks.mutate.mockImplementation(async (_user: string, change: (current: AppState) => unknown) => change(state));
    mocks.dispatch.mockResolvedValue(undefined);
    const result = await enqueueStrongMatch(state.profile.id, job.id, state.profile.updatedAt, { cacheKey: `${job.id}:fixture` });
    const queued = state.discovery.events.find((event) => event.kind === "queued");
    expect(result.queued).toBe(true);
    expect(queued?.delayMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
    expect(state.discovery.events.map((event) => event.kind)).toEqual(["arrived", "matched", "queued"]);
    vi.useRealTimers();
  });
});
