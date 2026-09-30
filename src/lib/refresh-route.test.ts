import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/refresh/route";
const mocks = vi.hoisted(() => ({ catalog: vi.fn(), admin: vi.fn(), match: vi.fn(), trigger: vi.fn() }));
vi.mock("@/lib/catalog-refresh", () => ({ refreshCatalog: mocks.catalog }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: mocks.admin }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: mocks.match }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "false"); vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic");
  vi.stubEnv("TRIGGER_SECRET_KEY", "synthetic"); vi.stubEnv("OPENAI_API_KEY", "synthetic");
  mocks.catalog.mockResolvedValue({ sources: 3, jobs: 5, closed: 0, errors: [] });
  mocks.trigger.mockResolvedValue({ id: "fixture" }); mocks.match.mockResolvedValue({ id: "fixture" });
  mocks.admin.mockReturnValue({ from: () => ({ select: () => ({ limit: async () => ({ data: [
    { user_id: "owner-import", data: { importedJobs: [{}] } }, { user_id: "owner-catalog", data: {} },
  ], error: null }) }) }) });
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
    expect(mocks.trigger).toHaveBeenCalledExactlyOnceWith("refresh-user-imported-jobs", { userId: "owner-import" }, { concurrencyKey: "owner-import" });
    expect(mocks.match).toHaveBeenCalledExactlyOnceWith("owner-catalog");
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
});
