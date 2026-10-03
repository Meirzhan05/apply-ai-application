import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/refresh/route";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), admin: vi.fn(), search: vi.fn(), trigger: vi.fn(), leases: [] as Array<{ ownerId: string; operation: string; reference?: string }>, owners: [] as Array<{ user_id: string; data: Record<string, unknown> }> }));
vi.mock("@/lib/catalog-refresh", () => ({ refreshCatalog: mocks.catalog }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: mocks.admin }));
vi.mock("@/lib/personal-search", () => ({ queuePersonalSearch: mocks.search }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
vi.mock("@/lib/account-lifecycle", () => ({ withAccountOperation: async (ownerId: string, operation: string, callback: () => Promise<unknown>, reference?: string) => {
  mocks.leases.push({ ownerId, operation, reference }); return callback();
} }));
beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "false"); vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic"); vi.stubEnv("TRIGGER_SECRET_KEY", "synthetic");
  mocks.search.mockResolvedValue(true); mocks.trigger.mockResolvedValue({ id: "fixture" }); mocks.leases = [];
  mocks.owners = [{ user_id: "owner-import", data: { importedJobs: [{}] } }, { user_id: "owner-empty", data: {} }];
  mocks.admin.mockImplementation(() => ({ from: () => ({ select: () => ({ order: () => {
    let cursor = "";
    const page = { gt: (_key: string, value: string) => { cursor = value; return page; }, range: async (start: number, end: number) => ({ data: mocks.owners.filter((owner) => owner.user_id > cursor).slice(start, end + 1), error: null }) };
    return page;
  } }) }) }));
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
const request = () => new Request("https://example.com/api/internal/refresh", { method: "POST", headers: { authorization: "Bearer synthetic" } });
describe("scheduled private student discovery", () => {
  it("requires the task secret before reading data", async () => {
    expect((await POST(new Request("https://example.com/", { method: "POST" }))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("dispatches personal searches and independent import refresh without loading or broadcasting a common feed", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith("owner-import", true);
    expect(mocks.search).toHaveBeenCalledWith("owner-empty", true);
    expect(mocks.trigger).toHaveBeenCalledExactlyOnceWith("refresh-user-imported-jobs", { userId: "owner-import" }, { concurrencyKey: "owner-import", tags: ["owner:owner-import"] });
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.leases).toContainEqual({ ownerId: "owner-import", operation: "maintenance", reference: "internal/refresh" });
  });
  it("reports personal search dispatch failures to the schedule", async () => {
    mocks.search.mockRejectedValueOnce(new Error("unavailable"));
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ queueErrors: 1 });
    expect(mocks.trigger).toHaveBeenCalledOnce();
  });
  it("still dispatches personal search if an imported link refresh fails", async () => {
    mocks.trigger.mockRejectedValue(new Error("Queue unavailable"));
    const response = await POST(request()); expect(response.status).toBe(503);
    expect(mocks.search).toHaveBeenCalledTimes(2);
  });
  it("pages past the first hundred owners", async () => {
    mocks.owners = Array.from({ length: 101 }, (_, index) => ({ user_id: `owner-${String(index).padStart(3, "0")}`, data: {} }));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.search).toHaveBeenCalledTimes(101);
    expect(mocks.search.mock.calls.at(-1)).toEqual(["owner-100", true]);
  });
  it("fails visibly when the task queue is not configured", async () => {
    vi.stubEnv("TRIGGER_SECRET_KEY", ""); expect((await POST(request())).status).toBe(503);
  });
});
