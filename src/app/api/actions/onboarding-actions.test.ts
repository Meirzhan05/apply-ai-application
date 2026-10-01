import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import { preparePilotMutation } from "@/lib/pilot";
import { POST } from "@/app/api/actions/route";

const mocks = vi.hoisted(() => ({
  memory: new Map<string, AppState>(),
  revisions: new Map<string, number>(),
  transport: [] as Array<{ userId: string; revision: number; context: string; data: string }>,
  user: vi.fn(),
}));

vi.mock("@/lib/repository", () => ({
  currentUserId: mocks.user,
  isDemo: () => true,
  loadState: async (userId: string) => structuredClone(mocks.memory.get(userId) ?? initialDemoState()),
  mutateState: async (userId: string, change: (state: AppState) => unknown, context?: unknown) => {
    const state = structuredClone(mocks.memory.get(userId) ?? initialDemoState());
    const previous = structuredClone(state);
    const result = await change(state);
    preparePilotMutation(previous, state, context as Parameters<typeof preparePilotMutation>[2]);
    const revision = (mocks.revisions.get(userId) ?? 0) + 1;
    mocks.revisions.set(userId, revision);
    mocks.transport.push({ userId, revision, context: JSON.stringify(context ?? null), data: JSON.stringify(state) });
    mocks.memory.set(userId, state);
    return result;
  },
}));

vi.mock("@/lib/catalog", () => ({ readActiveCatalogRows: async () => [] }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));

describe("onboarding action boundary", () => {
  beforeEach(() => {
    mocks.memory.clear();
    mocks.revisions.clear();
    mocks.transport.length = 0;
    mocks.user.mockResolvedValue("owner-a");
    for (const userId of ["owner-a", "owner-b"]) {
      const state = initialDemoState();
      state.profile.id = userId;
      mocks.memory.set(userId, state);
    }
  });

  it("persists onboarding, activation, settings, and pause for one owner", async () => {
    const facts = initialDemoState().profile.facts;
    const post = (action: string, payload: Record<string, unknown> = {}) => new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action, payload }),
    });

    expect((await POST(post("onboarding", {
      questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" },
      facts,
    }))).status).toBe(200);
    expect((await POST(post("automationSettings", {
      settings: { resumeTailoring: false, coverLetterMode: "disabled" },
    }))).status).toBe(200);
    expect((await POST(post("activateAutomation", { reason: "I authorize Apply" }))).status).toBe(200);
    let state = mocks.memory.get("owner-a")!;
    expect(state.profile.automationAuthorization?.status).toBe("enabled");
    expect(state.profile.automationSettings?.resumeTailoring).toBe(false);

    expect((await POST(post("pauseAutomation"))).status).toBe(200);
    state = mocks.memory.get("owner-a")!;
    expect(state.profile.automationAuthorization?.status).toBe("paused");
    expect(mocks.memory.get("owner-b")!.profile.automationAuthorization).toBeUndefined();
  });

  it("keeps a missing declaration distinct from an explicit negative answer", async () => {
    const post = (action: string, payload: Record<string, unknown> = {}) => new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action, payload }),
    });
    expect(await POST(post("onboarding", {
      questionnaire: { workAuthorization: "no" },
    }))).toHaveProperty("status", 200);

    const state = mocks.memory.get("owner-a")!;
    expect(state.profile.onboarding?.questionnaire.workAuthorization).toBe("no");
    expect(state.profile.onboarding?.questionnaire.requiresSponsorship).toBeUndefined();
  });

  it("uses the authenticated owner instead of a user id supplied in the payload", async () => {
    const post = (action: string, payload: Record<string, unknown> = {}) => new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action, payload }),
    });
    mocks.user.mockResolvedValue("owner-b");
    const response = await POST(post("activateAutomation", { userId: "owner-a" }));
    expect(response.status).toBe(400);
    expect(mocks.memory.get("owner-a")!.profile.automationAuthorization).toBeUndefined();
    expect(mocks.memory.get("owner-b")!.profile.automationAuthorization).toBeUndefined();
  });

  it("enrolls only the authenticated completed owner and captures later selections", async () => {
    const post = (action: string, payload: Record<string, unknown> = {}) => new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action, payload }),
    });
    const facts = initialDemoState().profile.facts;
    await POST(post("onboarding", { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" }, facts }));
    const before = mocks.memory.get("owner-a")!.profile.automationVersion;
    expect((await POST(post("enrollPilot", { confirmed: true, consentVersion: "pilot-consent-v1", userId: "owner-b" }))).status).toBe(200);
    expect(mocks.memory.get("owner-a")!.profile.automationVersion).toBe(before);
    expect((await POST(post("select", { jobId: "demo-engineering-intern", userId: "owner-b" }))).status).toBe(200);
    expect(mocks.memory.get("owner-a")!.applications[0].pilotAttempt?.ownerId).toBe("owner-a");
    expect(mocks.memory.get("owner-b")!.pilot).toBeUndefined();
    expect((await POST(post("withdrawPilot"))).status).toBe(200);
    expect(mocks.memory.get("owner-a")!.pilot?.activeEpisodeId).toBeUndefined();
  });

  it("records owner actions at the public CAS boundary without inventing an intervention for enrollment", async () => {
    const post = (action: string, payload: Record<string, unknown> = {}) => new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action, payload }),
    });
    const facts = initialDemoState().profile.facts;
    await POST(post("onboarding", { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" }, facts }));
    await POST(post("enrollPilot", { confirmed: true, consentVersion: "pilot-consent-v1" }));
    await POST(post("select", { jobId: "demo-engineering-intern" }));
    const before = mocks.memory.get("owner-a")!.applications[0].pilotAttempt!;
    expect(before.events.some((event) => event.kind === "intervention-requested")).toBe(false);
    await POST(post("profile", { headline: "Updated by owner" }));
    const after = mocks.memory.get("owner-a")!.applications[0].pilotAttempt!;
    expect(after.events.at(-1)).toEqual(expect.objectContaining({ kind: "owner-action", actor: { kind: "owner", userId: "owner-a" } }));
    const lastTransport = mocks.transport.at(-1)!;
    expect(JSON.parse(lastTransport.context)).toEqual({ actor: { kind: "owner", userId: "owner-a" }, action: "profile" });
    expect(JSON.parse(lastTransport.data).profile.headline).toBe("Updated by owner");
  });
});
