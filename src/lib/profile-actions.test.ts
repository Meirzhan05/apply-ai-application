import { beforeEach, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: null as AppState | null }));
vi.mock("@/lib/repository", () => ({
  isDemo: () => true,
  currentUserId: async () => "demo-user",
  loadState: async () => structuredClone(fixture.state),
  mutateState: async (_user: string, change: (state: AppState) => unknown) => {
    const next = structuredClone(fixture.state!);
    await change(next);
    fixture.state = next;
    return next;
  },
}));
import { initialDemoState } from "@/lib/demo-data";
import { onboardingCompleteness } from "@/lib/onboarding";
import { POST } from "@/app/api/actions/route";

const save = (sensitiveAnswers: Record<string, unknown>) => POST(new Request("https://apply.example/api/actions", {
  method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" },
  body: JSON.stringify({ action: "profile", payload: { name: "Synthetic Student", email: "synthetic@example.com", sensitiveAnswers } }),
}));

beforeEach(() => { fixture.state = initialDemoState(); fixture.state.profile.sensitiveAnswers = {}; });

it("saves a new profile with all optional screening answers left blank", async () => {
  const response = await save({});
  expect(response.status).toBe(200);
  expect(fixture.state!.profile.name).toBe("Synthetic Student");
  expect(fixture.state!.profile.sensitiveAnswers).toEqual({});
  expect(onboardingCompleteness(fixture.state!.profile).missing).toEqual(expect.arrayContaining(["workAuthorization", "requiresSponsorship"]));
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
