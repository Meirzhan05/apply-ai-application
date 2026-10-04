import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";
import { POST } from "@/app/api/actions/route";
import { POST as importResume } from "@/app/api/resume/route";
import { loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";

const mocks = vi.hoisted(() => ({ memory: new Map<string, AppState>(), user: vi.fn(), failSave: false }));
vi.mock("@/lib/repository", () => ({
  currentUserId: mocks.user, isDemo: () => true,
  loadState: async (owner: string) => structuredClone(mocks.memory.get(owner)!),
  mutateState: async (owner: string, change: (state: AppState) => unknown) => {
    const state = structuredClone(mocks.memory.get(owner)!);
    const result = await change(state);
    if (mocks.failSave) throw new Error("Saved state unavailable. Retry.");
    mocks.memory.set(owner, state);
    return result;
  },
}));
vi.mock("@/lib/catalog", () => ({ readActiveCatalogRows: async () => [] }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));

const act = (action: string, payload: Record<string, unknown> = {}) => POST(new Request("http://localhost/api/actions", {
  method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
  body: JSON.stringify({ action, payload }),
}));
const answers = {
  name: "Riley Example", email: "riley@example.com", phone: "+7 701 123 4567", links: [],
  currentLocation: { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" },
  preferredLocations: ["United States"], workArrangements: ["remote", "hybrid"],
  questionnaire: { immigrationStatus: "visa-holder", visaType: "F-1 OPT", workAuthorization: "yes", sponsorshipNow: "no", sponsorshipFuture: "no" },
};
async function upload() {
  const bytes = await createDocxSourceFixture();
  const body = new FormData();
  body.append("file", new File([new Uint8Array(bytes)], "resume.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  expect((await importResume(new Request("http://localhost/api/resume", { method: "POST", headers: { origin: "http://localhost" }, body }))).status).toBe(200);
}
async function view() { return publicState(await loadState("owner-a")); }

describe("resume onboarding completion through authenticated actions", () => {
  beforeEach(() => {
    mocks.memory.clear(); mocks.user.mockResolvedValue("owner-a"); mocks.failSave = false;
    for (const owner of ["owner-a", "owner-b"]) {
      const state = initialDemoState(); state.profile.id = owner;
      state.profile.facts = [
        { id: "unrelated", text: "User supplied professional information", source: "user", verified: false },
        { id: "old-resume", text: "Information from an older resume", source: "resume", verified: false },
      ];
      mocks.memory.set(owner, state);
    }
  });

  it("imports, resumes draft answers, and confirms only displayed current imported facts in one final save", async () => {
    await upload();
    expect((await act("onboardingDraft", { ...answers, stage: "review", userId: "owner-b" })).status).toBe(200);
    const draft = await view();
    const { questionnaire, ...profileAnswers } = answers;
    expect(draft.profile).toMatchObject({ ...profileAnswers, onboarding: { draftStage: "review", questionnaire } });
    expect(draft.onboarding.complete).toBe(false);
    expect(draft.profile.facts.filter(fact => fact.source === "resume").every(fact => !fact.verified)).toBe(true);
    expect((await loadState("owner-b")).profile).not.toHaveProperty("currentLocation");
    expect((await act("finishOnboarding", { reviewHash: draft.onboarding.reviewHash })).status).toBe(200);
    const finished = await view();
    expect(finished.onboarding.complete).toBe(true);
    expect(finished.profile.onboarding).toMatchObject({ completedVersion: 2, completedResumeHash: finished.profile.resumeSource!.sha256 });
    expect(finished.profile.searchPreferencesConfirmedAt).toBeTruthy();
    expect(finished.profile.facts.filter(fact => fact.source === "resume" && fact.sourceAnchorId).every(fact => fact.verified)).toBe(true);
    expect(finished.profile.facts.find(fact => fact.id === "unrelated")?.verified).toBe(false);
    expect(finished.profile.facts.find(fact => fact.id === "old-resume")?.verified).toBe(false);
    expect(finished.profile.automationAuthorization).toBeUndefined();
    expect(publicState(await loadState("owner-a")).onboarding.complete).toBe(true);
  });

  it("reports every required field even when legacy onboarding was completed and rejects final save atomically", async () => {
    const state = mocks.memory.get("owner-a")!;
    state.profile.name = ""; state.profile.email = "not-an-email"; state.profile.phone = "";
    state.profile.preferredLocations = []; state.profile.onboarding = { completedAt: "2025-01-01T00:00:00.000Z", questionnaire: {} };
    const before = await loadState("owner-a");
    const review = await view();
    expect(review.onboarding.complete).toBe(false);
    const response = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ missing: ["resume", "name", "email", "phone", "currentLocation.city", "currentLocation.region", "currentLocation.country", "preferredLocations", "workArrangements", "immigrationStatus", "workAuthorization", "sponsorshipNow", "sponsorshipFuture"] });
    expect(await loadState("owner-a")).toEqual(before);
  });

  it("requires visa or other-status details and explicit answers while allowing negative declarations and optional blanks", async () => {
    await upload();
    await act("onboardingDraft", { ...answers, questionnaire: { ...answers.questionnaire, visaType: "", workAuthorization: "unknown", sponsorshipNow: "unknown", sponsorshipFuture: "unknown" } });
    let review = await view();
    let response = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(await response.json()).toMatchObject({ missing: ["visaType", "workAuthorization", "sponsorshipNow", "sponsorshipFuture"] });
    await act("onboardingDraft", { questionnaire: { immigrationStatus: "other", immigrationStatusDetails: "", workAuthorization: "no", sponsorshipNow: "no", sponsorshipFuture: "no" } });
    review = await view();
    response = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(await response.json()).toMatchObject({ missing: ["immigrationStatusDetails"] });
    await act("onboardingDraft", { questionnaire: { immigrationStatus: "us-citizen" }, willingToRelocate: null });
    review = await view();
    expect((await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash })).status).toBe(200);
    expect((await view()).onboarding.complete).toBe(true);
  });

  it("rejects pending imports, changed sources and obsolete review state without confirming anything", async () => {
    await upload(); await act("onboardingDraft", answers);
    const oldReview = await view();
    await act("onboardingDraft", { email: "corrected@example.com" });
    expect((await act("finishOnboarding", { reviewHash: oldReview.onboarding.reviewHash })).status).toBe(400);
    let state = mocks.memory.get("owner-a")!;
    state.profile.resumeImport = { token: "new-import", startedAt: "2026-10-04T00:00:00.000Z" };
    let review = await view();
    let response = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(await response.json()).toMatchObject({ missing: ["resumeImport"] });
    state = mocks.memory.get("owner-a")!;
    delete state.profile.resumeImport; state.profile.resumeSource!.sha256 = "new-source";
    review = await view();
    response = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(await response.json()).toMatchObject({ missing: ["resume"] });
    expect((await loadState("owner-a")).profile.onboarding?.completedVersion).toBeUndefined();
    expect((await loadState("owner-a")).profile.facts.every(fact => !fact.verified)).toBe(true);
  });

  it("preserves corrected source provenance and resumed answers when reusing a saved resume", async () => {
    await upload(); await act("onboardingDraft", answers);
    const review = await view();
    const expected = review.onboarding.importedFacts;
    const updated = expected.map((fact, index) => ({ ...fact, text: index === 0 ? "Built and evaluated a recommendation prototype." : fact.text }));
    expect((await act("onboardingDraft", { email: "edited@example.com", expectedReviewHash: review.onboarding.reviewHash, factPatch: { expected, updated } })).status).toBe(200);
    const body = new FormData(); body.append("reuse", "true");
    const reused = await importResume(new Request("http://localhost/api/resume", { method: "POST", headers: { origin: "http://localhost" }, body }));
    expect(reused.status).toBe(200);
    const resumed = await view();
    expect(resumed.profile.email).toBe("edited@example.com");
    expect(resumed.profile.currentLocation).toEqual(answers.currentLocation);
    expect(resumed.profile.onboarding?.questionnaire).toMatchObject(answers.questionnaire);
    expect(resumed.onboarding.importedFacts).toEqual(expect.arrayContaining(updated));
    expect((await act("finishOnboarding", { reviewHash: resumed.onboarding.reviewHash })).status).toBe(200);
    expect((await loadState("owner-a")).profile.facts.find(fact => fact.id === updated[0].id)).toMatchObject({ ...updated[0], verified: true });
  });

  it("leaves the final review recoverable when owner persistence fails", async () => {
    await upload(); await act("onboardingDraft", answers);
    const review = await view(); const before = await loadState("owner-a");
    mocks.failSave = true;
    const failed = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ error: "Saved state unavailable. Retry." });
    expect(await loadState("owner-a")).toEqual(before);
    expect((await view()).onboarding.complete).toBe(false);
    mocks.failSave = false;
    expect((await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash })).status).toBe(200);
  });

  it("requires the completed resume and required saved answers to remain current when opening the dashboard", async () => {
    await upload(); await act("onboardingDraft", answers);
    const ready = await view(); await act("finishOnboarding", { reviewHash: ready.onboarding.reviewHash });
    const finished = await loadState("owner-a");
    expect((await view()).onboarding.complete).toBe(true);
    mocks.memory.get("owner-a")!.profile.resumeImport = { token: "pending", startedAt: "2026-10-04T00:00:00.000Z" };
    expect((await view()).onboarding.complete).toBe(false);
    mocks.memory.set("owner-a", structuredClone(finished));
    await act("onboardingDraft", { phone: "" });
    expect((await view()).onboarding.complete).toBe(false);
    mocks.memory.set("owner-a", structuredClone(finished));
    const profile = mocks.memory.get("owner-a")!.profile;
    profile.resumeSource!.sha256 = "replacement";
    profile.resumeSourceDocument!.sourceHash = "replacement";
    expect((await view()).onboarding.complete).toBe(false);
  });

  it.each(["Remote", "Toronto, ON", "London, UK"])("keeps %s from satisfying a preferred US destination", async (destination) => {
    await upload(); await act("onboardingDraft", { ...answers, preferredLocations: [destination] });
    const review = await view();
    const response = await act("finishOnboarding", { reviewHash: review.onboarding.reviewHash });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ missing: ["preferredLocations"] });
    expect((await view()).onboarding.complete).toBe(false);
  });

  it("rejects stale draft reviews and corrections to unrelated professional information atomically", async () => {
    await upload(); await act("onboardingDraft", answers);
    const obsolete = await view();
    await act("onboardingDraft", { phone: "+7 701 765 4321" });
    const before = await loadState("owner-a");
    expect((await act("onboardingDraft", { expectedReviewHash: obsolete.onboarding.reviewHash, name: "Stale change" })).status).toBe(400);
    expect(await loadState("owner-a")).toEqual(before);
    const current = await view(); const unrelated = current.profile.facts.find(fact => fact.id === "unrelated")!;
    expect((await act("onboardingDraft", { expectedReviewHash: current.onboarding.reviewHash, factPatch: { expected: [unrelated], updated: [{ ...unrelated, text: "Unreviewed replacement" }] } })).status).toBe(400);
    expect(await loadState("owner-a")).toEqual(before);
  });

  it("uses the same bounded and normalized profile draft contract at both authenticated action boundaries", async () => {
    const before = await loadState("owner-a");
    expect((await act("profile", { email: `${"a".repeat(245)}@example.com` })).status).toBe(400);
    expect(await loadState("owner-a")).toEqual(before);
    expect((await act("onboardingDraft", { links: Array.from({ length: 21 }, () => "https://example.com") })).status).toBe(400);
    expect(await loadState("owner-a")).toEqual(before);

    expect((await act("profile", {
      name: "  Synthetic Applicant  ", email: "synthetic@example.com", phone: " +1 212 555 0100 ",
      links: ["linkedin.com/in/synthetic", "https://linkedin.com/in/synthetic"],
      currentLocation: { city: " New York ", region: " NY ", country: " United States " },
      preferredLocations: [" United States ", "United States"], workArrangements: ["remote", "remote"],
      willingToRelocate: null,
    })).status).toBe(200);
    let saved = await loadState("owner-a");
    expect(saved.profile).toMatchObject({
      name: "Synthetic Applicant", email: "synthetic@example.com", phone: "+1 212 555 0100",
      links: ["https://linkedin.com/in/synthetic"],
      currentLocation: { city: "New York", region: "NY", country: "United States" },
      preferredLocations: ["United States"], workArrangements: ["remote"], remoteOnly: true,
    });

    expect((await act("onboardingDraft", {
      email: "draft@example.com", links: ["github.com/synthetic", "https://github.com/synthetic"],
      preferredLocations: [" United States ", "United States"],
    })).status).toBe(200);
    saved = await loadState("owner-a");
    expect(saved.profile.email).toBe("draft@example.com");
    expect(saved.profile.links).toEqual(["https://github.com/synthetic"]);
    expect(saved.profile.preferredLocations).toEqual(["United States"]);
  });
});
