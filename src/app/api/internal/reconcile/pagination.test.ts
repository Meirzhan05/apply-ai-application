import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createOwnerScanTransport } from "@/lib/owner-scan-test-transport";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  transport: null as ReturnType<typeof createOwnerScanTransport> | null,
  cancelBrowser: vi.fn(async () => undefined),
  triggerCalls: [] as unknown[][],
}));

vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => fixture.transport!.client }));
vi.mock("@/lib/browser-runner", () => ({ cancelBrowser: fixture.cancelBrowser }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: async (...args: unknown[]) => { fixture.triggerCalls.push(args); return { id: "run-dispatch" }; } } }));

import { POST } from "@/app/api/internal/reconcile/route";

function request() {
  return new Request("http://localhost/api/internal/reconcile", { method: "POST", headers: { authorization: "Bearer reconcile-pagination-secret" } });
}

function stateWithHeldPreflight(userId: string): AppState {
  const state = initialDemoState();
  const job = state.jobs[0];
  const app = {
    id: "last-owner-app",
    userId,
    jobId: job.id,
    jobSnapshot: job,
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
      budgetReleasePending: { kind: "unused", reservationId: "browser:last-owner-app:last-owner-token", month: "2026-10", attempts: 1 },
    },
  } as AppState["applications"][number];
  state.applications = [app];
  state.importedJobs = [job];
  return state;
}

describe("internal reconcile owner scan", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    process.env.INTERNAL_TASK_SECRET = "reconcile-pagination-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    process.env.MONTHLY_SPEND_LIMIT_USD = "500";
    delete process.env.RESEND_API_KEY;
    fixture.transport = createOwnerScanTransport();
    fixture.cancelBrowser.mockClear();
    fixture.triggerCalls = [];
    for (let index = 0; index < 1001; index += 1) {
      const userId = `owner-${String(index).padStart(4, "0")}`;
      const state = index === 1000 ? stateWithHeldPreflight(userId) : { applications: [] };
      fixture.transport.rows.set(userId, { user_id: userId, data: state as unknown as Record<string, unknown>, revision: 1 });
    }
  });

  it("persists cleanup and budget compensation for the owner after the first thousand", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(fixture.cancelBrowser).toHaveBeenCalledTimes(1);
    expect(fixture.transport!.rpcCalls.map((call) => call.name)).toContain("release_service_budget");
    const saved = fixture.transport!.rows.get("owner-1000")!;
    const application = (saved.data.applications as AppState["applications"])[0];
    expect(application.browserReleasePending).toBeUndefined();
    expect(application.importedPreflight).toBeUndefined();
    expect(fixture.triggerCalls).toEqual([]);
  });

  it("returns an error without provider calls or partial state changes when a later page fails", async () => {
    fixture.transport!.setPageFailure(new Error("owner page unavailable"));
    const before = structuredClone(fixture.transport!.rows.get("owner-1000")!);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "owner page unavailable" });
    expect(fixture.cancelBrowser).not.toHaveBeenCalled();
    expect(fixture.transport!.rpcCalls).toEqual([]);
    expect(fixture.transport!.rows.get("owner-1000")).toEqual(before);
  });
});
