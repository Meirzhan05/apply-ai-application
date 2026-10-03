import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/refresh/route";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), admin: vi.fn(), match: vi.fn(), mutate: vi.fn(), trigger: vi.fn(), leases: [] as Array<{ ownerId: string; operation: string; reference?: string }>, owners: [] as Array<{ user_id: string; data: Record<string, unknown> }> }));
vi.mock("@/lib/catalog-refresh", () => ({ refreshCatalog: mocks.catalog }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: mocks.admin }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: mocks.match }));
vi.mock("@/lib/repository", () => ({ mutateState: mocks.mutate }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
vi.mock("@/lib/account-lifecycle", () => ({ withAccountOperation: async (ownerId: string, operation: string, callback: () => Promise<unknown>, reference?: string) => {
  mocks.leases.push({ ownerId, operation, reference });
  return callback();
} }));
beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "false"); vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic");
  vi.stubEnv("TRIGGER_SECRET_KEY", "synthetic"); vi.stubEnv("OPENAI_API_KEY", "synthetic");
  mocks.catalog.mockResolvedValue({ sources: 3, jobs: 5, closed: 0, errors: [] });
  mocks.mutate.mockResolvedValue(undefined);
  mocks.trigger.mockResolvedValue({ id: "fixture" }); mocks.match.mockResolvedValue({ id: "fixture" });
  mocks.leases = [];
  mocks.owners = [
    { user_id: "owner-import", data: { importedJobs: [{}] } }, { user_id: "owner-catalog", data: {} },
  ];
  mocks.admin.mockImplementation(() => ({ from: () => ({ select: () => ({ order: () => {
    let cursor = "";
    const page = { gt: (_key: string, value: string) => { cursor = value; return page; }, range: async (start: number, end: number) => ({ data: mocks.owners.filter((owner) => owner.user_id > cursor).slice(start, end + 1), error: null }) };
    return page;
  } }) }) }));
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const request = () => new Request("https://example.com/api/internal/refresh", { method: "POST", headers: { authorization: "Bearer synthetic" } });
describe("scheduled discovery refresh", () => {
  it("requires the task secret before reading data", async () => {
    expect((await POST(new Request("https://example.com/", { method: "POST" }))).status).toBe(401);
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("queues private import refresh first and matches other owners directly", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.trigger).toHaveBeenCalledExactlyOnceWith("refresh-user-imported-jobs", { userId: "owner-import" }, { concurrencyKey: "owner-import", tags: ["owner:owner-import"] });
    expect(mocks.match).toHaveBeenCalledExactlyOnceWith("owner-catalog");
    expect(mocks.leases).toContainEqual({ ownerId: "owner-import", operation: "maintenance", reference: "internal/refresh" });
    expect(mocks.leases).toContainEqual({ ownerId: "owner-import", operation: "dispatch", reference: "refresh-imports" });
    expect(mocks.leases).toContainEqual({ ownerId: "owner-catalog", operation: "maintenance", reference: "internal/refresh" });
  });
  it("monitors imports even when matching is unavailable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.trigger).toHaveBeenCalledOnce(); expect(mocks.match).not.toHaveBeenCalled();
  });
  it("surfaces dispatch failures so a cron does not falsely report success", async () => {
    mocks.trigger.mockRejectedValue(new Error("Queue unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ queueErrors: 1 });
  });
  it("surfaces owner telemetry failures as retryable and records them on a later refresh", async () => {
    const report = {
      sources: 3,
      jobs: 5,
      closed: 0,
      errors: [],
      refreshedAt: "2026-10-01T08:00:00.000Z",
      sourceStatus: [{ source: "greenhouse", status: "available", checkedAt: "2026-10-01T08:00:00.000Z" }],
      arrivals: [],
    };
    mocks.catalog.mockResolvedValue(report);
    mocks.mutate.mockRejectedValueOnce(new Error("temporary CAS failure"));

    const failed = await POST(request());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      telemetryErrors: 1,
      telemetryFailedOwners: ["owner-import"],
      retryable: true,
    });

    const persisted = new Map<string, Record<string, unknown>>();
    mocks.mutate.mockImplementation(async (...args: unknown[]) => {
      const userId = args[0] as string;
      const updater = args[1] as (state: Record<string, unknown>) => void;
      const state: Record<string, unknown> = {};
      updater(state);
      persisted.set(userId, state);
    });
    const recovered = await POST(request());
    expect(recovered.status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledTimes(4);
    expect((persisted.get("owner-import")?.discovery as { lastRefreshAt?: string }).lastRefreshAt).toBe(report.refreshedAt);
  });
  it("pages past the first hundred owners in stable order", async () => {
    mocks.owners = Array.from({ length: 101 }, (_, index) => ({ user_id: `owner-${String(index).padStart(3, "0")}`, data: {} }));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.match).toHaveBeenCalledTimes(101);
    expect(mocks.match.mock.calls.at(-1)).toEqual(["owner-100"]);
  });
});
