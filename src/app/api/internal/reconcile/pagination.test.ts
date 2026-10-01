import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<{ user_id: string }>,
  cursors: [] as string[],
  failure: undefined as Error | undefined,
  states: new Map<string, AppState>(),
  releases: [] as Array<{ userId: string; reservationId: string; month: string }>,
  dispatches: [] as string[],
}));

vi.mock("@/lib/repository", () => ({
  isDemo: () => false,
  loadState: async (userId: string) => structuredClone(fixture.states.get(userId)),
  mutateState: async (userId: string, change: (state: AppState) => unknown) => {
    const state = fixture.states.get(userId)!;
    return change(state);
  },
}));
vi.mock("@/lib/supabase-admin", () => ({
  adminSupabase: () => ({
    from: () => ({
      select: () => {
        let cursor: string | undefined;
        const query = {
          order: () => query,
          gt: (_field: string, value: string) => { cursor = value; fixture.cursors.push(value); return query; },
          range: async () => {
            if (fixture.failure && cursor) return { data: null, error: fixture.failure };
            const start = cursor ? fixture.rows.findIndex((row) => row.user_id > cursor!) : 0;
            return { data: fixture.rows.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 1000), error: null };
          },
        };
        return query;
      },
    }),
  }),
}));
vi.mock("@/lib/run-recovery", () => ({ recoverStaleRuns: () => [] }));
vi.mock("@/lib/browser-runner", () => ({ cancelBrowser: vi.fn() }));
vi.mock("@/lib/application-queue", () => ({ dispatchUserQueue: async (userId: string) => { fixture.dispatches.push(userId); return { dispatched: 0 }; } }));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn() }));
vi.mock("@/lib/application-blockers", () => ({ resolveResourceHold: vi.fn(), recordApplicationBlocker: vi.fn() }));
vi.mock("@/lib/budget", () => ({
  browserBudgetReservationId: (applicationId: string, token: string) => `browser:${applicationId}:${token}`,
  releaseServiceBudget: async (userId: string, reservationId: string, month: string) => { fixture.releases.push({ userId, reservationId, month }); return true; },
}));

import { POST } from "@/app/api/internal/reconcile/route";

function request() {
  return new Request("http://localhost/api/internal/reconcile", { method: "POST", headers: { authorization: "Bearer reconcile-pagination-secret" } });
}

describe("internal reconcile owner scan", () => {
  beforeEach(() => {
    process.env.INTERNAL_TASK_SECRET = "reconcile-pagination-secret";
    fixture.rows = Array.from({ length: 1001 }, (_, index) => ({ user_id: `owner-${String(index).padStart(4, "0")}` }));
    fixture.cursors = [];
    fixture.failure = undefined;
    fixture.states = new Map();
    fixture.releases = [];
    fixture.dispatches = [];
    for (const row of fixture.rows) {
      const state = initialDemoState();
      state.applications = [];
      fixture.states.set(row.user_id, state);
    }
    const lastOwner = fixture.rows.at(-1)!.user_id;
    const state = fixture.states.get(lastOwner)!;
    const app = {
      id: "last-owner-app",
      userId: lastOwner,
      jobId: state.jobs[0].id,
      jobSnapshot: state.jobs[0],
      status: "selected",
      approvals: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      browserReleasePending: { sessionId: "last-owner-session", requestedAt: "2026-10-01T00:00:00.000Z", attempts: 1 },
      importedPreflight: {
        token: "last-owner-token",
        startedAt: "2026-10-01T00:00:00.000Z",
        budgetReservationId: "browser:last-owner-app:last-owner-token",
        budgetMonth: "2026-10",
        budgetReleasePending: {
          kind: "unused",
          reservationId: "browser:last-owner-app:last-owner-token",
          month: "2026-10",
          attempts: 1,
        },
      },
    } as AppState["applications"][number];
    state.applications = [app];
  });

  it("reconciles a held reservation owned by the row after the first thousand", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(fixture.cursors).toEqual(["owner-0999"]);
    expect(fixture.releases).toEqual([{ userId: "owner-1000", reservationId: "browser:last-owner-app:last-owner-token", month: "2026-10" }]);
    expect(fixture.dispatches).toContain("owner-1000");
    expect(fixture.states.get("owner-1000")!.applications[0].importedPreflight).toBeUndefined();
  });

  it("returns an error without processing a partial owner scan", async () => {
    fixture.failure = new Error("owner page unavailable");
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "owner page unavailable" });
    expect(fixture.releases).toEqual([]);
    expect(fixture.dispatches).toEqual([]);
  });
});
