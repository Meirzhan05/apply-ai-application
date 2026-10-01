import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { readBrowserUsage, recordBrowserUsageEvent, withBrowserUsageContext, type BrowserProviderReport } from "./browser-usage";

const directory = "/tmp/apply-browser-usage-test";
const owner = { userId: "owner", applicationId: "application", jobId: "job", runId: "run" };
const report: BrowserProviderReport = { status: "active", startedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T01:00:00.000Z" };
beforeEach(async () => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("BROWSER_USAGE_TEST_DIR", directory); await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true }); });
afterEach(() => vi.unstubAllEnvs());

describe("browser usage ledger", () => {
  it("records lifecycle events idempotently and keeps a disconnected session active", async () => {
    await withBrowserUsageContext(owner, async () => {
      await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-1", event: "created", report, failure: null, orphanedSessionId: null });
      await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-1", event: "connected", report, failure: null, orphanedSessionId: null });
      await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-1", event: "disconnected", report, failure: null, orphanedSessionId: null });
      await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-1", event: "disconnected", report, failure: null, orphanedSessionId: null });
    });
    const usage = await readBrowserUsage(owner.userId);
    expect(usage.records).toHaveLength(3);
    expect(usage.sessions[0]).toMatchObject({ status: "active", durationMinutes: expect.any(Number), estimatedBrowserCostUsd: expect.any(Number), provisional: true, rate: { version: "browser-use-2026-10-01", unit: "USD per browser minute" } });
  });

  it("keeps missing traffic unknown and preserves an orphan after failed release", async () => {
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-2", event: "created", report: { ...report, proxyUsedMb: 0, browserCostUsd: 0, status: "stopped", finishedAt: "2026-10-01T00:01:01.000Z" }, failure: null, orphanedSessionId: null });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-2", event: "release_failed", report: null, failure: "release_failed", orphanedSessionId: "session-2" });
    const usage = await readBrowserUsage(owner.userId);
    expect(usage.sessions[0]).toMatchObject({ proxyUsedMb: 0, browserCostUsd: 0, proxyCostUsd: null, trafficStatus: "measured", orphaned: true, estimatedUsd: 0 });
    expect(usage.incompleteCostSessions).toBe(1);
  });

  it("keeps a confirmed final report ahead of a later active replay", async () => {
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-final", event: "created", occurredAt: "2026-10-01T00:00:00.000Z", report, failure: null, orphanedSessionId: null });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-final", event: "stopped", occurredAt: "2026-10-01T00:02:00.000Z", report: { ...report, status: "stopped", finishedAt: "2026-10-01T00:02:00.000Z", browserCostUsd: 0 }, failure: null, orphanedSessionId: null });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-final", event: "status", occurredAt: "2026-10-01T00:03:00.000Z", report: { ...report, status: "active", browserCostUsd: 99 }, failure: null, orphanedSessionId: null });
    const session = (await readBrowserUsage(owner.userId)).sessions.find((item) => item.sessionId === "session-final");
    expect(session).toMatchObject({ status: "stopped", browserCostUsd: 0, lastEvent: "stopped", provisional: false });
  });

  it("clears an orphan marker after a later authoritative stop", async () => {
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-reconciled", event: "release_failed", occurredAt: "2026-10-01T00:01:00.000Z", report: null, failure: "release_failed", orphanedSessionId: "session-reconciled" });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-reconciled", event: "stopped", occurredAt: "2026-10-01T00:02:00.000Z", report: { status: "stopped", finishedAt: "2026-10-01T00:02:00.000Z", browserCostUsd: 0 }, failure: null, orphanedSessionId: null });
    expect((await readBrowserUsage(owner.userId)).sessions.find((item) => item.sessionId === "session-reconciled")?.orphaned).toBe(false);
  });

  it("rejects an owner changing a stable event identity", async () => {
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-3", event: "created", report, failure: null, orphanedSessionId: null });
    await expect(recordBrowserUsageEvent({ ...owner, userId: "other", provider: "browser-use", sessionId: "session-3", event: "created", report, failure: null, orphanedSessionId: null })).rejects.toThrow("another owner");
  });

  it("does not overwrite a complete same-event final report with a partial replay", async () => {
    const full = { status: "stopped" as const, finishedAt: "2026-10-01T00:03:00.000Z", proxyUsedMb: 12.5, proxyCostUsd: 0.06, browserCostUsd: 0.01 };
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-replay", event: "stopped", report: full, failure: null, orphanedSessionId: null });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-replay", event: "stopped", report: { status: "stopped" }, failure: null, orphanedSessionId: null });
    const saved = (await readBrowserUsage(owner.userId)).records.find((item) => item.sessionId === "session-replay");
    expect(saved?.report).toMatchObject(full);
  });

  it("keeps newer final costs while filling missing components from an older delivery", async () => {
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-order", event: "stopped", occurredAt: "2026-10-01T00:05:00.000Z", report: { status: "stopped", finishedAt: "2026-10-01T00:05:00.000Z", browserCostUsd: 0.04 }, failure: null, orphanedSessionId: null });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-order", event: "stopped", occurredAt: "2026-10-01T00:03:00.000Z", report: { status: "stopped", finishedAt: "2026-10-01T00:03:00.000Z", proxyCostUsd: 0.05, browserCostUsd: 0.99 }, failure: null, orphanedSessionId: null });
    const usage = await readBrowserUsage(owner.userId);
    expect(usage.measuredUsd).toBeCloseTo(0.09);
    expect(usage.sessions.find((item) => item.sessionId === "session-order")).toMatchObject({ browserCostUsd: 0.04, proxyCostUsd: 0.05, estimatedUsd: 0.04 });
  });

  it("fills a newer partial browser report whose omitted keys are explicit undefined", async () => {
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-undefined", event: "stopped", occurredAt: "2026-10-01T00:01:00.000Z", report: { status: "stopped", finishedAt: "2026-10-01T00:01:00.000Z", proxyUsedMb: 8, proxyCostUsd: 0.04, browserCostUsd: 0.02 }, failure: null, orphanedSessionId: null });
    await recordBrowserUsageEvent({ ...owner, provider: "browser-use", sessionId: "session-undefined", event: "stopped", occurredAt: "2026-10-01T00:02:00.000Z", report: { status: "stopped", finishedAt: "2026-10-01T00:02:00.000Z", proxyUsedMb: undefined, proxyCostUsd: undefined, browserCostUsd: 0.03 }, failure: null, orphanedSessionId: null });
    const session = (await readBrowserUsage(owner.userId)).sessions.find((item) => item.sessionId === "session-undefined");
    expect(session).toMatchObject({ proxyUsedMb: 8, proxyCostUsd: 0.04, browserCostUsd: 0.03 });
  });
});
