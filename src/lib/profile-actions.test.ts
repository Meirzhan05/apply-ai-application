import { beforeEach, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: null as AppState | null, otherState: null as AppState | null, owner: "demo-user", demo: true }));
vi.mock("@/lib/repository", () => ({
  isDemo: () => fixture.demo,
  currentUserId: async () => fixture.owner,
  loadState: async (owner: string) => structuredClone(owner === "other-owner" ? fixture.otherState : fixture.state),
  mutateState: async (owner: string, change: (state: AppState) => unknown) => {
    const next = structuredClone(owner === "other-owner" ? fixture.otherState! : fixture.state!);
    await change(next);
    if (owner === "other-owner") fixture.otherState = next;
    else fixture.state = next;
    return next;
  },
}));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ auth: { admin: { getUserById: async () => ({ data: { user: { email: "signin@example.com" } } }) } } }) }));
import { initialDemoState } from "@/lib/demo-data";
import { onboardingCompleteness } from "@/lib/onboarding";
import { POST } from "@/app/api/actions/route";
import { GET } from "@/app/api/state/route";

const save = (sensitiveAnswers: Record<string, unknown>) => POST(new Request("https://apply.example/api/actions", {
  method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" },
  body: JSON.stringify({ action: "profile", payload: { name: "Synthetic Student", email: "synthetic@example.com", sensitiveAnswers } }),
}));

beforeEach(() => { fixture.demo = true; fixture.owner = "demo-user"; fixture.state = initialDemoState(); fixture.state.profile.sensitiveAnswers = {}; fixture.otherState = initialDemoState(); fixture.otherState.profile.id = "other-owner"; });

it("saves a new profile with all optional screening answers left blank", async () => {
  const response = await save({});
  expect(response.status).toBe(200);
  expect(fixture.state!.profile.name).toBe("Synthetic Student");
  expect(fixture.state!.profile.sensitiveAnswers).toEqual({});
  expect(onboardingCompleteness(fixture.state!.profile).missing).toEqual(expect.arrayContaining(["workAuthorization", "requiresSponsorship"]));
});

it("saves candidate-corrected contact details and optional normalized links for application use", async () => {
  fixture.demo = false;
  fixture.state!.profile.facts = [];
  const response = await POST(new Request("https://apply.example/api/actions", {
    method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "profile", payload: { email: "contact@example.com", phone: "+44 20 7946 0958", links: ["linkedin.com/in/candidate", " https://portfolio.example.com ", ""] } }),
  }));
  expect(response.status).toBe(200);
  const state = await (await GET(new Request("https://apply.example/api/state"))).json();
  expect(state.profile).toMatchObject({ email: "contact@example.com", phone: "+44 20 7946 0958", links: ["https://linkedin.com/in/candidate", "https://portfolio.example.com/"] });
  expect(fixture.state!.profile).toMatchObject(state.profile);
});

it("keeps contact edits scoped to the authenticated owner even when another profile ID is supplied", async () => {
  const other = structuredClone(fixture.otherState!.profile);
  const response = await POST(new Request("https://apply.example/api/actions", {
    method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "profile", payload: { id: "other-owner", name: "Owner correction", email: "owner@example.com", links: [] } }),
  }));
  expect(response.status).toBe(200);
  expect((await (await GET(new Request("https://apply.example/api/state"))).json()).profile).toMatchObject({ id: "demo-user", name: "Owner correction", email: "owner@example.com" });
  fixture.owner = "other-owner";
  expect((await (await GET(new Request("https://apply.example/api/state"))).json()).profile).toEqual(other);
});

it("saves a partial screening answer without requiring demographic answers", async () => {
  const response = await save({ requiresSponsorship: "No" });
  expect(response.status).toBe(200);
  expect(fixture.state!.profile.sensitiveAnswers).toEqual({ requiresSponsorship: "No" });
});

it("lets the owner clear saved screening answers", async () => {
  fixture.state!.profile.sensitiveAnswers = { requiresSponsorship: "No", gender: "Prefer not to say" };
  expect((await save({})).status).toBe(200);
  expect(fixture.state!.profile.sensitiveAnswers).toEqual({});
});

it.each([{ unsupportedQuestion: "Yes" }, { gender: 1 }, { veteran: "x".repeat(201) }])("rejects invalid saved screening answers without changing the profile: %j", async (answers) => {
  const before = structuredClone(fixture.state!.profile);
  expect((await save(answers)).status).toBe(400);
  expect(fixture.state!.profile).toEqual(before);
});
