import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import { preparePilotMutation } from "@/lib/pilot";
import { POST } from "@/app/api/actions/route";
import { loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { draftPacket } from "@/lib/drafting";
import { selectApplication, setPacket } from "@/lib/workflow";

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

  it("saves overseas residence independently of nationwide destinations and optional work answers for the owner", async () => {
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "profile", payload: {
        currentLocation: { city: " Almaty ", region: " Almaty Region ", country: " Kazakhstan " },
        preferredLocations: ["United States"], preferredTitles: [],
        workArrangements: ["remote", "hybrid"], willingToRelocate: false,
        questionnaire: { availability: "June 2027" }, userId: "owner-b",
      } }),
    }));
    expect(response.status).toBe(200);
    const saved = (await loadState("owner-a")).profile;
    expect(saved).toMatchObject({
      currentLocation: { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" },
      preferredLocations: ["United States"], preferredTitles: [],
      workArrangements: ["remote", "hybrid"], willingToRelocate: false,
      onboarding: { questionnaire: { availability: "June 2027" } },
    });
    expect(saved.searchPreferencesConfirmedAt).toBeTruthy();
    expect((await loadState("owner-b")).profile).not.toHaveProperty("currentLocation");
  });

  it("keeps optional location answers clearable and invalidates prior matching and materials after a profile save", async () => {
    const state = mocks.memory.get("owner-a")!;
    const app = selectApplication(state, state.jobs[0].id, "owner-a");
    setPacket(state, app, await draftPacket(state.profile, state.jobs[0]));
    state.profile.willingToRelocate = true;
    state.matchCache = { prior: publicState(state).matches[0].assessment };
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "profile", payload: {
        willingToRelocate: null, workArrangements: [], questionnaire: { availability: "" },
        currentLocation: { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" },
      } }),
    }));
    expect(response.status).toBe(200);
    const saved = await loadState("owner-a");
    expect(saved.profile.willingToRelocate).toBeUndefined();
    expect(saved.profile.onboarding?.questionnaire.availability).toBe("");
    expect(saved.matchCache).toEqual({});
    expect(publicState(saved).applications[0].materialsStale).toBe(true);
  });

  it.each([
    { currentLocation: { city: "Almaty", region: "Almaty Region", country: 42 } },
    { workArrangements: ["flexible"] }, { willingToRelocate: "no" },
  ])("rejects malformed location answers atomically: %j", async (payload) => {
    const before = await loadState("owner-a");
    const response = await POST(new Request("http://localhost/api/actions", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "profile", payload: { name: "Uncommitted edit", ...payload } }),
    }));
    expect(response.status).toBe(400);
    expect(await loadState("owner-a")).toEqual(before);
  });

  it("saves, dismisses, and clears feedback only for the authenticated owner", async () => {
    const post = (kind: string) => new Request("http://localhost/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "feedback", payload: { jobId: "demo-engineering-intern", kind, userId: "owner-b" } }),
    });
    for (const kind of ["saved", "dismissed"] as const) {
      expect((await POST(post(kind))).status).toBe(200);
      expect(mocks.memory.get("owner-a")!.feedback[0].kind).toBe(kind);
    }
    expect((await POST(post("clear"))).status).toBe(200);
    expect(mocks.memory.get("owner-a")!.feedback).toEqual([]);
    expect(mocks.memory.get("owner-b")!.feedback).toEqual([]);
    expect(mocks.memory.get("owner-a")!.activity[0].label).toBe("Role restored");
    expect(JSON.parse(mocks.transport.at(-1)!.context)).toEqual({ actor: { kind: "owner", userId: "owner-a" }, action: "feedback" });
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
