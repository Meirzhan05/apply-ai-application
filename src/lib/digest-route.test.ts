import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import { POST } from "@/app/api/internal/digest/route";

const mocks = vi.hoisted(() => ({ rows: [] as Array<{ user_id: string; data: AppState }>, stateError: null as unknown, demo: false, catalog: vi.fn(), load: vi.fn(), send: vi.fn(), mutate: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/catalog", () => ({ readActiveCatalogRows: mocks.catalog }));
vi.mock("@/lib/email", () => ({ sendDigest: mocks.send }));
vi.mock("@/lib/repository", () => ({ isDemo: () => mocks.demo, loadState: mocks.load, mutateState: mocks.mutate }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ from: mocks.from }) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T13:00:00Z"));
  vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-task-secret");
  mocks.demo = false;
  mocks.stateError = null;
  const state = initialDemoState();
  state.profile = { ...state.profile, id: "owner", email: "owner@example.com", demo: false };
  state.jobs[0].discoveredAt = "2026-09-30T12:00:00Z";
  mocks.rows = [{ user_id: "owner", data: state }];
  mocks.load.mockImplementation(async (id: string) => mocks.rows.find((row) => row.user_id === id)!.data);
  mocks.catalog.mockResolvedValue([{ id: "job", data: mocks.rows[0].data.jobs[0], discovered_at: "2026-09-30T12:00:00Z" }]);
  mocks.from.mockImplementation(() => ({ select: () => ({ limit: async () => ({ data: mocks.rows, error: mocks.stateError }) }) }));
  mocks.send.mockResolvedValue(true);
  mocks.mutate.mockImplementation(async (id: string, change: (state: AppState) => unknown) => change(mocks.rows.find((row) => row.user_id === id)!.data));
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const request = (authorized = true) => new Request("https://example.com/api/internal/digest", { method: "POST", headers: authorized ? { authorization: "Bearer synthetic-task-secret" } : {} });

describe("daily digest dispatch and checkpoint", () => {
  it("rejects unauthorized dispatch before reading any user data", async () => {
    expect((await POST(request(false))).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not send or read private records in demo mode", async () => {
    mocks.demo = true;
    expect(await (await POST(request())).json()).toEqual({ sent: 0, detail: "Demo mode does not send email." });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("uses the owner’s private jobs and records the watermark only after delivery", async () => {
    mocks.send.mockImplementation(async () => { vi.advanceTimersByTime(5000); return true; });
    const response = await POST(request());
    expect(await response.json()).toEqual({ sent: 1, errors: [] });
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith("owner");
    expect(mocks.send.mock.calls[0][1][0].discoveredAt).toBe("2026-09-30T12:00:00Z");
    expect(mocks.send.mock.calls[0][2].toISOString()).toBe("2026-09-30T13:00:00.000Z");
    expect(mocks.rows[0].data.lastDigestAt).toBe("2026-09-30T13:00:00.000Z");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it("does not advance the watermark when the provider rejects delivery", async () => {
    mocks.rows[0].data.lastDigestAt = "2026-09-28T13:00:00Z";
    mocks.send.mockRejectedValue(new Error("Synthetic provider rejection"));
    const response = await POST(request());
    expect(response.status).toBe(207);
    expect(await response.json()).toEqual({ sent: 0, errors: ["Synthetic provider rejection"] });
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.rows[0].data.lastDigestAt).toBe("2026-09-28T13:00:00Z");
  });
  it("permits one digest per New York day despite UTC calendar boundaries", async () => {
    vi.setSystemTime(new Date("2026-09-30T00:30:00Z"));
    await POST(request());
    vi.setSystemTime(new Date("2026-09-30T13:00:00Z"));
    await POST(request());
    expect(mocks.send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2026-10-01T00:30:00Z"));
    expect(await (await POST(request())).json()).toEqual({ sent: 0, errors: [] });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
  it("stays quiet when there are no matches or pending actions", async () => {
    mocks.send.mockResolvedValue(false);
    expect(await (await POST(request())).json()).toEqual({ sent: 0, errors: [] });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("does not send a partial digest after a database read failure", async () => {
    mocks.stateError = { message: "Synthetic state read failure" };
    expect((await POST(request())).status).toBe(500);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});


it("does not put one student's discoveries into another student's digest", async () => {
  const empty = initialDemoState(); empty.profile.id = "new-student"; empty.profile.demo = false; empty.jobs = [];
  mocks.rows.push({ user_id: "new-student", data: empty });
  await POST(request());
  expect(mocks.send.mock.calls.find(([state]) => state.profile.id === "new-student")?.[1]).toEqual([]);
  expect(mocks.catalog).not.toHaveBeenCalled();
});
