import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";
import { withPacketFiles } from "@/lib/packet-files";
import { approveFill, selectApplication, setPacket } from "@/lib/workflow";
import { dispatchUserQueue, queueApplicationRun } from "@/lib/application-queue";

const mocks = vi.hoisted(() => ({ state: undefined as unknown as AppState, budget: true, release: vi.fn(), claim: vi.fn(), terminal: vi.fn(), trigger: vi.fn(), draft: vi.fn(), fill: vi.fn(), queue: Promise.resolve() }));
vi.mock("@/lib/repository", () => ({
  isDemo: () => false,
  loadState: async () => structuredClone(mocks.state),
  mutateState: async (_id: string, change: (state: AppState) => unknown) => {
    const pending = mocks.queue.then(() => change(mocks.state));
    mocks.queue = pending.then(() => undefined, () => undefined);
    return pending;
  },
}));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: async () => mocks.budget, reserveQueuedBudget: async (_user: string, app: string, queued: string, projected: number) => mocks.budget ? { queuedId: queued, reservationId: `queued:${queued}`, month: "2026-10", ownerId: "demo-user", applicationId: app, projectedUsd: projected } : null, releaseQueuedBudget: mocks.release, markQueuedBudgetClaimed: mocks.claim, markQueuedBudgetTerminal: mocks.terminal }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: mocks.trigger } }));
vi.mock("@/lib/application-runs", () => ({ runDraft: mocks.draft, runFill: mocks.fill }));

beforeEach(() => { mocks.state = initialDemoState(); mocks.budget = true; mocks.release.mockResolvedValue(true); mocks.claim.mockResolvedValue(true); mocks.terminal.mockResolvedValue(true); mocks.queue = Promise.resolve(); vi.clearAllMocks(); });
describe("durable application queue", () => {
  it("keeps a request across budget rejection, then dispatches it when spending permits", async () => {
    const app = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
    mocks.budget = false;
    await queueApplicationRun(app.userId, app.id, "draft");
    expect(app.queuedRun?.reason).toBe("budget");
    expect(app.status).toBe("selected");
    expect(mocks.trigger).not.toHaveBeenCalled();
    mocks.budget = true;
    await dispatchUserQueue(app.userId);
    expect(app.queuedRun).toBeUndefined();
    expect(app.status).toBe("drafting");
    expect(mocks.trigger).toHaveBeenCalledOnce();
    await dispatchUserQueue(app.userId);
    expect(mocks.trigger).toHaveBeenCalledOnce();
  });
  it("allows only one dispatch when queue scanners race", async () => {
    const app = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
    mocks.budget = false;
    await queueApplicationRun(app.userId, app.id, "draft");
    mocks.budget = true;
    await Promise.all([dispatchUserQueue(app.userId), dispatchUserQueue(app.userId)]);
    expect(mocks.trigger).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it("does not dispatch a listing that closes while queued", async () => {
    const app = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
    mocks.budget = false;
    await queueApplicationRun(app.userId, app.id, "draft");
    mocks.state.jobs[0].active = false;
    mocks.budget = true;
    await dispatchUserQueue(app.userId);
    expect(app.error).toMatch(/closed/);
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("retries an ambiguous worker handoff with the same idempotency key", async () => {
    const app = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
    mocks.trigger.mockRejectedValueOnce(new Error("network timeout"));
    await queueApplicationRun(app.userId, app.id, "draft");
    const token = app.runToken;
    expect(app.runDispatch?.confirmedAt).toBeUndefined();
    await dispatchUserQueue(app.userId);
    expect(mocks.trigger).toHaveBeenCalledTimes(2);
    expect(mocks.trigger.mock.calls[1][2].idempotencyKey).toBe(token);
    expect(app.runDispatch?.confirmedAt).toBeTruthy();
  });
  it("keeps a second fill queued until the active browser ends", async () => {
    const active = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
    active.status = "final_review"; active.browserSessionId = "test-session";
    const waiting = selectApplication(mocks.state, mocks.state.jobs[1].id, mocks.state.profile.id);
    const fact = mocks.state.profile.facts.find((item) => item.verified)!;
    setPacket(mocks.state, waiting, await withPacketFiles(mocks.state.profile, { schemaVersion: 1, version: 1, summary: "Test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], model: "test", createdAt: new Date().toISOString() }));
    approveFill(waiting, waiting.userId, waiting.packetHash!, waiting.jobSnapshot!.applyUrl);
    await queueApplicationRun(waiting.userId, waiting.id, "fill");
    expect(waiting.queuedRun?.reason).toBe("active_run");
    expect(mocks.trigger).not.toHaveBeenCalled();
    active.status = "cancelled";
    await dispatchUserQueue(waiting.userId);
    expect(waiting.status).toBe("filling");
    expect(mocks.trigger).toHaveBeenCalledOnce();
  });
  it("retries a terminal release tombstone without releasing an adopted run", async () => {
    const app = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
    app.budgetReservation = { reservationId: "queued:terminal", projectedUsd: 0.2, month: "2026-10", ownerId: app.userId, applicationId: app.id, status: "release_pending" };
    await dispatchUserQueue(app.userId);
    expect(mocks.terminal).toHaveBeenCalledWith(expect.objectContaining({ queuedId: "terminal", month: "2026-10" }));
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ queuedId: "terminal", month: "2026-10" }));
    expect(app.budgetReservation?.status).toBe("released");
    expect(mocks.trigger).not.toHaveBeenCalled();
  });
});
