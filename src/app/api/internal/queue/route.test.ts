import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: [] as Array<{ user_id: string; data: { applications: Array<{ queuedRun?: object }> } }>,
  cursors: [] as string[],
  failure: undefined as Error | undefined,
  dispatches: [] as string[],
}));

vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/application-queue", () => ({
  dispatchUserQueue: async (userId: string) => { fixture.dispatches.push(userId); return { dispatched: 1 }; },
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

import { POST } from "@/app/api/internal/queue/route";

function request() {
  return new Request("http://localhost/api/internal/queue", { method: "POST", headers: { authorization: "Bearer queue-secret" } });
}

describe("internal queue owner scan", () => {
  beforeEach(() => {
    process.env.INTERNAL_TASK_SECRET = "queue-secret";
    fixture.rows = Array.from({ length: 1001 }, (_, index) => ({
      user_id: `owner-${String(index).padStart(4, "0")}`,
      data: { applications: [{ queuedRun: {} }] },
    }));
    fixture.cursors = [];
    fixture.failure = undefined;
    fixture.dispatches = [];
  });

  it("dispatches the owner after the first thousand rows", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).dispatched).toBe(1001);
    expect(fixture.dispatches).toContain("owner-1000");
    expect(fixture.cursors).toEqual(["owner-0999"]);
  });

  it("fails the whole sweep when a later page cannot be read", async () => {
    fixture.failure = new Error("owner page unavailable");
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "owner page unavailable" });
    expect(fixture.dispatches).toEqual([]);
  });
});
