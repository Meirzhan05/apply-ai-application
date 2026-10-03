import { beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { ModelUsageRecord } from "@/lib/model-usage";
import type { BrowserUsageRecord } from "@/lib/browser-usage";

type FixtureState = {
  applications: Array<{
    id: string;
    userId?: string;
    status?: string;
    submittedAt?: string;
    runs?: Array<{ token: string; kind: string; projectedUsd: number }>;
    queuedRun?: { reason: string; requestedAt?: string };
    createdAt?: string;
  }>;
};
const fixtures = vi.hoisted(() => ({
  models: [] as ModelUsageRecord[],
  browsers: [] as BrowserUsageRecord[],
  states: new Map<string, FixtureState>(),
}));
vi.mock("@/lib/model-usage", () => ({ readAllModelUsage: async () => fixtures.models, readModelUsage: async (userId: string) => ({ records: fixtures.models.filter((item) => item.userId === userId), measuredCalls: 0, unknownCalls: 0, estimatedUsd: 0, incompleteCostCalls: 0, reconciledUsd: null }) }));
vi.mock("@/lib/browser-usage", () => ({ readAllBrowserUsage: async () => fixtures.browsers, readBrowserUsage: async (userId: string) => ({ records: fixtures.browsers.filter((item) => item.userId === userId), sessions: [], measuredSessions: 0, activeSessions: 0, unknownTrafficSessions: 0, estimatedUsd: 0, measuredUsd: 0, incompleteCostSessions: 0 }) }));
vi.mock("@/lib/repository", () => ({ isDemo: () => true, loadState: async (userId: string) => fixtures.states.get(userId) ?? { applications: [] } }));

import { costReport, costReportCsv, recordServiceCost, type ServiceCostRecord } from "@/lib/service-costs";

const model = (userId: string, id: string, amount: number | null, applicationId?: string): ModelUsageRecord => ({
  version: 1, id, userId, applicationId, runId: `run-${id}`, provider: "openai", model: "gpt-6-luna", operation: "matching",
  startedAt: "2026-10-01T00:00:00.000Z", completedAt: amount === null ? null : "2026-10-01T00:01:00.000Z", status: amount === null ? "started" : "reported",
  responseId: null, requestId: null, providerStatus: null, serviceTier: "default", tokens: { input: amount === null ? null : 10, cachedInput: 0, cacheWrite: 0, output: 10, reasoningOutput: 0 }, rate: null, estimatedUsd: amount, reconciledUsd: null, failure: null,
});
const browser = (userId: string, sessionId: string | null, amount: number | null, applicationId?: string): BrowserUsageRecord => ({
  version: 1, id: `browser-${sessionId}`, userId, applicationId, runId: `run-${sessionId}`, provider: "browser-use", sessionId, event: "stopped", occurredAt: "2026-10-01T00:02:00.000Z", report: { status: amount === null ? "unknown" : "stopped", browserCostUsd: amount ?? undefined, startedAt: "2026-10-01T00:00:00.000Z", finishedAt: amount === null ? undefined : "2026-10-01T00:01:00.000Z" }, failure: amount === null ? "release_failed" : null, orphanedSessionId: null,
});
const line = (overrides: Partial<ServiceCostRecord> = {}): ServiceCostRecord => ({ version: 1, id: "line-1", provider: "openai", invoiceId: "invoice-1", lineId: "line-1", period: "2026-10", category: "model", amountUsd: 0.25, currency: "USD", allocationMethod: "direct-owner", allocations: [{ userId: "owner-a", amountUsd: 0.25 }], reconciles: ["model-1"], importedAt: "2026-10-02T00:00:00.000Z", ...overrides });

beforeEach(async () => { fixtures.models = []; fixtures.browsers = []; fixtures.states = new Map(); const dir = `/tmp/service-costs-test-${process.pid}`; await rm(dir, { recursive: true, force: true }); vi.stubEnv("SERVICE_COSTS_TEST_DIR", dir); });

describe("service cost ledger", () => {
  it("rejects invalid periods and negative money before persistence", async () => {
    await expect(recordServiceCost(line({ period: "October" }))).rejects.toThrow(/Period/);
    await expect(recordServiceCost(line({ amountUsd: -0.01 }))).rejects.toThrow(/amount/);
    await expect(recordServiceCost(line({ allocations: [{ userId: "owner-a", amountUsd: 0.1 }] }))).rejects.toThrow(/equal/);
    fixtures.models = [model("owner-a", "model-covered", 0.1)];
    await recordServiceCost(line({ id: "coverage-1", reconciles: ["model-covered"], amountUsd: 0.1, allocations: [{ userId: "owner-a", amountUsd: 0.1 }] }));
    await expect(recordServiceCost(line({ id: "coverage-2", invoiceId: "invoice-2", reconciles: ["model-covered"], amountUsd: 0.1, allocations: [{ userId: "owner-a", amountUsd: 0.1 }] }))).rejects.toThrow(/already reconciled/);
  });

  it("reconciles one invoice line once and keeps unknown work unknown", async () => {
    fixtures.models = [model("owner-a", "model-1", 0.2, "cancelled"), model("owner-a", "model-unknown", null, "submitted")];
    fixtures.browsers = [browser("owner-a", "session-1", 0.1, "cancelled"), browser("owner-b", "session-2", 0.3, "other")];
    fixtures.states.set("owner-a", { applications: [
      { id: "submitted", userId: "owner-a", status: "submitted", submittedAt: "2026-10-01", runs: [{ token: "run", kind: "draft", projectedUsd: 0.2 }] },
      { id: "cancelled", userId: "owner-a", status: "cancelled", runs: [] },
    ] });
    fixtures.states.set("owner-b", { applications: [{ id: "other", userId: "owner-b", status: "submitted", submittedAt: "2026-10-01", runs: [] }] });
    await recordServiceCost(line());
    await recordServiceCost(line());
    const owner = await costReport("owner-a");
    expect(owner.reconciledUsd).toBeCloseTo(0.25);
    expect(owner.measuredEstimateUsd).toBeCloseTo(0.3);
    expect(owner.unknownComponents).toBe(2);
    expect(owner.projectedUsd).toBeCloseTo(0.2);
    expect(owner.confirmedSubmissions).toBe(1);
    expect(owner.costPerConfirmedSubmission).toBeCloseTo(0.35);
    expect(owner.evidence.some((item) => item.id === "model-unknown" && item.amountUsd === null && item.unknown)).toBe(true);
    expect(owner.invoiceLines).toHaveLength(1);
    expect(owner.invoiceLines[0].allocationMethod).toBe("direct-owner");
    const service = await costReport("operator", { service: true });
    expect(service.reconciledUsd).toBeCloseTo(0.25);
    expect(service.evidence.some((item) => item.ownerId === "owner-b")).toBe(true);
    expect(service.confirmedSubmissions).toBe(2);
    expect(owner.evidence.every((item) => item.ownerId === "owner-a")).toBe(true);
  });

  it("labels fixed costs by allocation method and never divides by zero", async () => {
    fixtures.states.set("owner-a", { applications: [] });
    await recordServiceCost(line({ id: "fixed-1", provider: "hosting", invoiceId: "fixed-invoice", lineId: "hosting", category: "hosting", amountUsd: 12, allocationMethod: "equal-active-users", allocations: [{ userId: "owner-a", amountUsd: 12 }] , reconciles: [] }));
    const report = await costReport("operator", { service: true });
    expect(report.invoiceLines[0]).toMatchObject({ category: "hosting", allocationMethod: "equal-active-users" });
    expect(report.costPerConfirmedSubmission).toBeNull();
  });

  it("keeps a final browser charge when a later active status is partial", async () => {
    fixtures.browsers = [
      browser("owner-a", "session-replay", 0.4, "application"),
      { ...browser("owner-a", "session-replay", null, "application"), id: "browser-status", event: "status", occurredAt: "2026-10-01T00:03:00.000Z", report: { status: "active" } },
    ];
    fixtures.states.set("owner-a", { applications: [] });
    const report = await costReport("owner-a");
    expect(report.measuredEstimateUsd).toBeCloseTo(0.4);
    expect(report.evidence[0]).toMatchObject({ amountUsd: 0.4, status: "status" });
  });

  it("keeps null-session allocation failures as unknown evidence and reconciles browser components canonically", async () => {
    fixtures.browsers = [
      browser("owner-a", "session-canonical", 0.4, "application"),
      { ...browser("owner-a", "session-canonical", 0.4, "application"), id: "browser-proxy", event: "status", occurredAt: "2026-10-01T00:03:00.000Z", report: { status: "stopped", proxyCostUsd: 0.1, browserCostUsd: 0.4 } },
      { ...browser("owner-a", "allocation", null, "application"), id: "browser-null", sessionId: null, failure: "ambiguous_allocation", event: "ambiguous", report: null },
    ];
    fixtures.states.set("owner-a", { applications: [{ id: "application", userId: "owner-a", status: "selected", createdAt: "2026-10-01" }] });
    await recordServiceCost(line({ id: "browser-line", provider: "browser-use", invoiceId: "browser-invoice", lineId: "browser", category: "browser", amountUsd: 0.4, allocations: [{ userId: "owner-a", amountUsd: 0.4 }], reconciles: ["browser:browser-use:session-canonical:browser"] }));
    const report = await costReport("owner-a");
    expect(report.evidence.find((item) => item.id === "browser:browser-use:session-canonical:browser")).toMatchObject({ reconciledUsd: 0.4 });
    expect(report.evidence.find((item) => item.id === "browser:browser-use:session-canonical:proxy")).toMatchObject({ amountUsd: 0.1 });
    expect(report.evidence.some((item) => item.id === "browser:event:browser-null" && item.unknown)).toBe(true);
    expect(report.unreconciledEstimateUsd).toBeCloseTo(0.1);
    expect(report.activeUsers).toBe(1);
    expect(report.costPerActiveUser).toBeCloseTo(0.5);
    const csv = costReportCsv(report);
    expect(csv).toContain('"invoice"');
    expect(csv).toContain('"browser-invoice"');
    expect(csv).toContain('"summary"');
  });

  it("counts cancelled, failed, and matching-only attempts as active users", async () => {
    fixtures.models = [model("owner-matching", "matching-only", 0.2), model("owner-cancelled", "cancelled-attempt", null), model("owner-failed", "failed-attempt", null)];
    fixtures.states.set("owner-cancelled", { applications: [{ id: "cancelled", userId: "owner-cancelled", status: "cancelled", createdAt: "2026-10-01", runs: [] }] });
    fixtures.states.set("owner-failed", { applications: [{ id: "failed", userId: "owner-failed", status: "failed", createdAt: "2026-10-01", runs: [] }] });
    fixtures.states.set("owner-matching", { applications: [] });
    const report = await costReport("operator", { service: true, period: "2026-10" });
    expect(report.activeUsers).toBe(3);
    expect(report.costPerActiveUser).toBeCloseTo(0.2 / 3);
  });

  it("assigns replayed responses and browser sessions to one canonical month", async () => {
    fixtures.models = [
      { ...model("owner-a", "model-october", 0.2), responseId: "provider-response", startedAt: "2026-10-31T23:59:00.000Z" },
      { ...model("owner-a", "model-november-replay", 0.3), responseId: "provider-response", startedAt: "2026-11-01T00:01:00.000Z" },
    ];
    fixtures.browsers = [
      browser("owner-a", "cross-month", 0.4, "application"),
      { ...browser("owner-a", "cross-month", 0.4, "application"), id: "browser-november", occurredAt: "2026-11-01T00:01:00.000Z", report: { status: "stopped", browserCostUsd: 0.4, startedAt: "2026-10-31T23:59:00.000Z", finishedAt: "2026-11-01T00:02:00.000Z" } },
    ];
    fixtures.states.set("owner-a", { applications: [] });
    await recordServiceCost(line({ id: "cross-month-invoice", amountUsd: 0.2, allocations: [{ userId: "owner-a", amountUsd: 0.2 }], reconciles: ["model-october"] }));
    const october = await costReport("owner-a", { period: "2026-10" });
    const november = await costReport("owner-a", { period: "2026-11" });
    expect(october.measuredEstimateUsd).toBeCloseTo(0.7);
    expect(october.reconciledUsd).toBeCloseTo(0.2);
    expect(october.evidence.find((item) => item.id === "model-october")).toMatchObject({ amountUsd: 0.3, reconciledUsd: 0.2 });
    expect(november.measuredEstimateUsd).toBe(0);
    expect(november.evidence).toHaveLength(0);
  });

  it("replays an existing invoice line without requiring archived usage evidence", async () => {
    fixtures.models = [model("owner-a", "archived-model", 0.2)];
    const saved = await recordServiceCost(line({ reconciles: ["archived-model"], amountUsd: 0.2, allocations: [{ userId: "owner-a", amountUsd: 0.2 }] }));
    fixtures.models = [];
    await expect(recordServiceCost(line({ reconciles: ["archived-model"], amountUsd: 0.2, allocations: [{ userId: "owner-a", amountUsd: 0.2 }] }))).resolves.toEqual(saved);
    const report = await costReport("owner-a");
    expect(report.evidence).toHaveLength(0);
    expect(report.reconciledUsd).toBeCloseTo(0.2);
    expect(report.invoiceLines[0]).toMatchObject({ allocatedUsd: 0.2, amountUsd: 0.2, reconciles: ["archived-model"] });
  });
});
