import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createOwnerScanTransport } from "@/lib/owner-scan-test-transport";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  transport: null as ReturnType<typeof createOwnerScanTransport> | null,
  triggerCalls: [] as unknown[][],
}));

vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => fixture.transport!.client }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: async (...args: unknown[]) => { fixture.triggerCalls.push(args); return { id: "run-dispatch" }; } } }));

import { POST } from "@/app/api/internal/queue/route";

function request() {
  return new Request("http://localhost/api/internal/queue", { method: "POST", headers: { authorization: "Bearer queue-secret" } });
}

function stateWithQueuedRun(userId: string): AppState {
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
    queuedRun: { id: "queued-last-owner", kind: "draft", requestedAt: "2026-10-01T00:00:00.000Z", reason: "waiting" },
  } as AppState["applications"][number];
  state.applications = [app];
  state.importedJobs = [job];
  return state;
}

describe("internal queue owner scan", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "false";
    process.env.INTERNAL_TASK_SECRET = "queue-secret";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    process.env.MONTHLY_SPEND_LIMIT_USD = "500";
    fixture.transport = createOwnerScanTransport();
    fixture.triggerCalls = [];
    for (let index = 0; index < 1001; index += 1) {
      const userId = `owner-${String(index).padStart(4, "0")}`;
      const state = index === 1000 ? stateWithQueuedRun(userId) : { applications: [] };
      fixture.transport.rows.set(userId, { user_id: userId, data: state as unknown as Record<string, unknown>, revision: 1 });
    }
  });

  it("dispatches the last owner through persisted state after the first thousand rows", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).dispatched).toBe(1);
    expect(fixture.triggerCalls).toHaveLength(1);
    expect(fixture.triggerCalls[0]?.[0]).toBe("draft-application-packet");
    const saved = fixture.transport!.rows.get("owner-1000")!;
    const application = (saved.data.applications as AppState["applications"])[0];
    expect(application.queuedRun).toBeUndefined();
    expect(application.status).toBe("drafting");
    expect(application.runDispatch?.confirmedAt).toBeTruthy();
    expect(fixture.transport!.rpcCalls.map((call) => call.name)).toEqual([
      "acquire_account_operation",
      "reserve_queued_service_budget",
      "save_account_state",
      "claim_queued_service_budget",
      "acquire_account_operation",
      "release_account_operation",
      "save_account_state",
      "release_account_operation",
    ]);
  });

  it("returns an error without dispatching or mutating state when a later page fails", async () => {
    fixture.transport!.setPageFailure(new Error("owner page unavailable"));
    const before = structuredClone(fixture.transport!.rows.get("owner-1000")!);
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "owner page unavailable" });
    expect(fixture.triggerCalls).toEqual([]);
    expect(fixture.transport!.rpcCalls).toEqual([]);
    expect(fixture.transport!.rows.get("owner-1000")).toEqual(before);
  });
});
