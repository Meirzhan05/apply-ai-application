import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: null as AppState | null, releaseCalls: [] as Array<{ userId: string; reservationId: string; month: string }>, releaseError: undefined as Error | undefined }));

vi.mock("@/lib/repository", () => ({
  isDemo: () => true,
  loadState: async () => structuredClone(fixture.state),
  mutateState: async (_userId: string, change: (state: AppState) => unknown) => change(fixture.state!),
}));
vi.mock("@/lib/budget", () => ({
  browserBudgetReservationId: (applicationId: string, token: string) => `browser:${applicationId}:${token}`,
  releaseServiceBudget: async (userId: string, reservationId: string, month: string) => {
    fixture.releaseCalls.push({ userId, reservationId, month });
    if (fixture.releaseError) throw fixture.releaseError;
    return true;
  },
}));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({}) }));
vi.mock("@/lib/run-recovery", () => ({ recoverStaleRuns: () => [] }));
vi.mock("@/lib/browser-runner", () => ({ cancelBrowser: vi.fn() }));
vi.mock("@/lib/application-queue", () => ({ dispatchUserQueue: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn() }));

import { POST } from "@/app/api/internal/reconcile/route";

function reconcileRequest() {
  return new Request("http://localhost/api/internal/reconcile", { method: "POST", headers: { authorization: "Bearer reconcile-secret" } });
}

describe("internal reconcile budget compensation", () => {
  beforeEach(() => {
    process.env.INTERNAL_TASK_SECRET = "reconcile-secret";
    fixture.releaseCalls = [];
    fixture.releaseError = undefined;
    const state = initialDemoState();
    const app: AppState["applications"][number] = {
      id: "unused-app",
      userId: "demo-user",
      jobId: state.jobs[0].id,
      jobSnapshot: state.jobs[0],
      status: "selected",
      approvals: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    app.importedPreflight = {
      token: "preflight-token",
      startedAt: "2026-10-01T00:00:00.000Z",
      budgetReservationId: "browser:unused-app:preflight-token",
      budgetMonth: "2026-10",
      budgetReleasePending: {
        kind: "unused",
        reservationId: "browser:unused-app:preflight-token",
        month: "2026-10",
        attempts: 1,
      },
    };
    state.budgetReservations = { "browser:unused-app:preflight-token": 0.15 };
    state.estimatedSpendUsd = 0.15;
    const unknown = structuredClone(app);
    unknown.id = "unknown-app";
    unknown.importedPreflight = { token: "unknown-token", startedAt: "2026-10-01T00:00:00.000Z", budgetReservationId: "browser:unknown-app:unknown-token", budgetMonth: "2026-10", allocationUncertain: true };
    state.applications = [app, unknown];
    fixture.state = state;
  });

  it("retries only an unused marker, preserves it after failure, and is replay safe", async () => {
    fixture.releaseError = new Error("release transport failed");
    expect((await POST(reconcileRequest())).status).toBe(200);
    expect(fixture.releaseCalls).toEqual([{ userId: "demo-user", reservationId: "browser:unused-app:preflight-token", month: "2026-10" }]);
    expect(fixture.state!.applications[0].importedPreflight?.budgetReleasePending).toMatchObject({ kind: "unused", attempts: 2, lastError: "release transport failed" });
    expect(fixture.state!.applications[1].importedPreflight?.allocationUncertain).toBe(true);

    fixture.releaseError = undefined;
    expect((await POST(reconcileRequest())).status).toBe(200);
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
    expect(fixture.state!.applications[1].importedPreflight?.allocationUncertain).toBe(true);
    expect(fixture.releaseCalls).toHaveLength(2);

    expect((await POST(reconcileRequest())).status).toBe(200);
    expect(fixture.releaseCalls).toHaveLength(2);
  });
});
