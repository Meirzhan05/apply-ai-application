import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { parseDocxSource } from "@/lib/docx-source";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { completeUploadedOnboardingFixture } from "@/lib/testing/onboarding";
import { resumeOnboardingStatus } from "@/lib/onboarding-completion";
import type { AppState, VerifiedFact } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: null as AppState | null, extract: vi.fn(), details: vi.fn(), budget: true, search: vi.fn(), matches: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/repository", () => ({ isDemo: () => false, loadState: async () => structuredClone(fixture.state!), mutateState: async (_owner: string, fn: (s: AppState) => unknown) => fn(fixture.state!) }));
vi.mock("@/lib/account-lifecycle", () => ({ withAccountOperation: async (_owner: string, _kind: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: async () => fixture.budget }));
vi.mock("@/lib/model-usage", () => ({ withModelUsageContext: async (_context: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/resume-profile-extraction", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/resume-profile-extraction")>(), extractResumeProfile: fixture.details }));
vi.mock("@/lib/resume-fact-extraction", () => ({ extractResumeFacts: fixture.extract }));
vi.mock("@/lib/personal-search", () => ({ queuePersonalSearch: fixture.search }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: fixture.matches }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: fixture.dispatch } }));
import { ensureResumeExtraction, queuedResumeExtraction, retryResumeExtraction, runResumeExtraction } from "@/lib/resume-extraction-jobs";

function onboardingImport(reused = false) {
  const profile = fixture.state!.profile;
  profile.resumeExtraction!.pending!.onboardingImport = { token: "import", reused,
    baseline: { name: profile.name, contactEmail: profile.contactEmail, phone: profile.phone, links: structuredClone(profile.links),
      linkedinUrl: profile.linkedinUrl, githubUrl: profile.githubUrl, portfolioUrl: profile.portfolioUrl } };
}

beforeEach(async () => {
  vi.clearAllMocks(); fixture.budget = true; fixture.details.mockResolvedValue([]);
  fixture.state = initialDemoState(); fixture.state.profile.name = "Riley Example";
  fixture.state.profile.facts = [
    { id: "manual", text: "Built a Python API for a class project.", source: "user", verified: true },
    { id: "old", text: "Old resume experience.", source: "resume", verified: true },
  ];
  const document = await parseDocxSource(await createDocxSourceFixture(), "Riley Example");
  fixture.state.profile.resumeFileName = "old.pdf";
  fixture.state.profile.resumeText = "Old source text.";
  fixture.state.profile.resumeExtraction = queuedResumeExtraction("new.docx", { source: {
    sha256: document.sourceHash, size: 1000, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", storageKey: "owner/fixture.docx",
  }, document });
  const bullet = document.anchors.find(a => a.kind === "bullet")!;
  const facts: VerifiedFact[] = [{ id: "new", text: "Built a recommender with 92% precision.", source: "resume", verified: false, status: "accepted", sourceAnchorId: bullet.id,
    grounding: { version: 1, sourceHash: document.sourceHash, model: "test", acceptedText: "Built a recommender with 92% precision.", evidence: [{ anchorId: bullet.id, quote: bullet.text }] } }];
  fixture.extract.mockResolvedValue(facts);
  fixture.search.mockResolvedValue(true); fixture.matches.mockResolvedValue(undefined); fixture.dispatch.mockResolvedValue({ id: "dispatched" });
  vi.stubEnv("TRIGGER_SECRET_KEY", "test");
});

it("activates source and facts together, preserving manual facts and starting downstream matching", async () => {
  const id = fixture.state!.profile.resumeExtraction!.id;
  const originalVersion = fixture.state!.profile.automationVersion;
  expect(await runResumeExtraction({ userId: "owner", requestId: id })).toMatchObject({ ready: true, facts: 1 });
  expect(fixture.state!.profile.resumeFileName).toBe("new.docx");
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "new"]);
  expect(fixture.state!.profile.resumeExtraction).toMatchObject({ status: "ready", pending: undefined });
  expect(fixture.state!.profile.automationVersion).toBeGreaterThan(originalVersion);
  expect(fixture.search).toHaveBeenCalledWith("owner");
  expect(fixture.matches).toHaveBeenCalledWith("owner");
  expect(await runResumeExtraction({ userId: "owner", requestId: id })).toEqual({ skipped: true });
  expect(fixture.extract).toHaveBeenCalledTimes(1);
});

it("preserves v2 completion when refreshing the same reviewed resume without legacy sponsorship answers", async () => {
  let profile = fixture.state!.profile;
  const pending = profile.resumeExtraction!.pending!;
  profile.resumeSource = pending.source; profile.resumeSourceDocument = pending.document; profile.resumeText = pending.document!.text;
  profile.contactEmail = profile.email;
  profile = completeUploadedOnboardingFixture(profile); fixture.state!.profile = profile;
  delete profile.onboarding!.questionnaire.requiresSponsorship;
  onboardingImport(true);
  const completion = structuredClone(profile.onboarding!);
  expect(resumeOnboardingStatus(profile).complete).toBe(true);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.onboarding!.completedAt).toBe(completion.completedAt);
  expect(resumeOnboardingStatus(profile).complete).toBe(true);
  expect(profile.onboarding!.questionnaire).toEqual(completion.questionnaire);
});

it("retains the complete previous snapshot on model failure and retries with a fresh request", async () => {
  const original = structuredClone(fixture.state!.profile);
  fixture.extract.mockRejectedValueOnce(new Error("Provider temporarily unavailable."));
  await expect(runResumeExtraction({ userId: "owner", requestId: original.resumeExtraction!.id })).rejects.toThrow("Provider temporarily unavailable");
  expect(fixture.state!.profile.facts).toEqual(original.facts);
  expect(fixture.state!.profile.resumeText).toBe("Old source text.");
  expect(fixture.state!.profile.resumeFileName).toBe("old.pdf");
  expect(fixture.state!.profile.resumeExtraction!.status).toBe("failed");
  await retryResumeExtraction("owner");
  const retryId = fixture.state!.profile.resumeExtraction!.id;
  expect(retryId).not.toBe(original.resumeExtraction!.id);
  expect(await runResumeExtraction({ userId: "owner", requestId: retryId })).toMatchObject({ ready: true });
});

it("publishes verified basic details only after experience extraction succeeds", async () => {
  const profile = fixture.state!.profile;
  const source = profile.resumeExtraction!.pending!.document!;
  const anchor = source.anchors.find(item => item.text.includes("riley@example.com"))!;
  profile.currentLocation = undefined;
  onboardingImport();
  fixture.details.mockResolvedValue([
    { key: "contactEmail", value: "riley@example.com", anchorId: anchor.id, quote: anchor.text },
    { key: "location", value: "Boston, MA", anchorId: anchor.id, quote: anchor.text },
  ]);
  const previousFacts = structuredClone(profile.facts);
  const version = profile.automationVersion;
  fixture.extract.mockRejectedValueOnce(new Error("Request timed out."));
  const request = { userId: "owner", requestId: profile.resumeExtraction!.id };
  await expect(runResumeExtraction(request)).rejects.toThrow("Request timed out.");
  expect(profile.contactEmail).toBeUndefined();
  expect(profile.currentLocation).toBeUndefined();
  expect(profile.facts).toEqual(previousFacts);
  expect(profile.resumeFileName).toBe("old.pdf");
  expect(profile.automationVersion).toBe(version);
  expect(await runResumeExtraction(request)).toMatchObject({ ready: true });
  expect(profile.contactEmail).toBe("riley@example.com");
  expect(profile.currentLocation).toEqual({ city: "Boston", region: "MA", country: "United States" });
});

it("does not allow an older upload to replace a newer pending upload", async () => {
  const oldId = fixture.state!.profile.resumeExtraction!.id;
  fixture.extract.mockImplementationOnce(async () => {
    fixture.state!.profile.resumeExtraction = { ...fixture.state!.profile.resumeExtraction!, id: "newer-request", status: "queued" };
    return [{ id: "old-output", text: "Stale model output.", source: "resume", verified: true }];
  });
  expect(await runResumeExtraction({ userId: "owner", requestId: oldId })).toMatchObject({ ready: false });
  expect(fixture.state!.profile.resumeExtraction!.id).toBe("newer-request");
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "old"]);
  expect(fixture.search).not.toHaveBeenCalled();
});

it("preserves manual facts entered while extraction is running", async () => {
  fixture.extract.mockImplementationOnce(async () => {
    fixture.state!.profile.facts.push({ id: "late-manual", text: "Led a separate volunteer project.", source: "user", verified: true });
    return [];
  });
  await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id });
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "late-manual"]);
});

it("keeps prior facts when the service budget prevents extraction", async () => {
  fixture.budget = false;
  expect(await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id })).toEqual({ budgetLimited: true });
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "old"]);
  expect(fixture.state!.profile.resumeExtraction!.status).toBe("budget_limited");
  expect(fixture.extract).not.toHaveBeenCalled();
});

it("migrates an existing stored resume once without clearing its active facts", async () => {
  const pending = fixture.state!.profile.resumeExtraction!.pending!;
  fixture.state!.profile.resumeSource = pending.source;
  fixture.state!.profile.resumeSourceDocument = pending.document;
  fixture.state!.profile.resumeExtraction = undefined;
  expect(await ensureResumeExtraction("owner", fixture.state!.profile)).toBe(true);
  expect(await ensureResumeExtraction("owner", fixture.state!.profile)).toBe(false);
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "old"]);
  expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  expect(fixture.state!.profile.resumeExtraction!.pending!.document).toBeUndefined();
});


it("continues a valid extraction when a newer upload has not passed parsing", async () => {
  const facts = await fixture.extract.getMockImplementation()!();
  fixture.extract.mockImplementationOnce(async (_source, options) => {
    fixture.state!.profile.resumeUploadSequence = 2;
    await options.beforeModelCall();
    return facts;
  });
  expect(await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id })).toMatchObject({ ready: true });
  expect(fixture.state!.profile.resumeExtraction!.status).toBe("ready");
});


it("publishes basic details with facts and preserves edits made while extraction runs", async () => {
  const source = fixture.state!.profile.resumeExtraction!.pending!.document!;
  const anchor = source.anchors.find(item => item.text.includes("riley@example.com"))!;
  fixture.state!.profile.phone = "";
  fixture.details.mockResolvedValue([{ key: "contactEmail", value: "riley@example.com", anchorId: anchor.id, quote: anchor.text }]);
  fixture.extract.mockImplementationOnce(async () => { fixture.state!.profile.phone = "+1 (212) 555-0199"; return []; });
  await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id });
  expect(fixture.state!.profile.contactEmail).toBe("riley@example.com");
  expect(fixture.state!.profile.phone).toBe("+1 (212) 555-0199");
  expect(fixture.state!.profile.resumeDetailsVersion).toBe(1);
});

it("preserves explicit clears made while basic details are being extracted", async () => {
  const profile = fixture.state!.profile;
  const anchor = profile.resumeExtraction!.pending!.document!.anchors.find(item => item.text.includes("riley@example.com"))!;
  fixture.details.mockResolvedValue([{ key: "contactEmail", value: "riley@example.com", anchorId: anchor.id, quote: anchor.text }]);
  fixture.extract.mockImplementationOnce(async () => {
    profile.contactEmail = "";
    profile.detailSources = { ...profile.detailSources, contactEmail: { source: "user", value: "" } };
    return [];
  });
  expect(await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id })).toMatchObject({ ready: true });
  expect(profile.contactEmail).toBe("");
});

it("continues fact extraction after the resume fills an empty applicant name", async () => {
  const profile = fixture.state!.profile;
  profile.name = "";
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "name", value: "Riley Example", anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  fixture.extract.mockImplementationOnce(async (_source, options) => {
    await options.beforeModelCall();
    expect(options.trustedName).toBe("Riley Example");
    return [];
  });
  expect(await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id })).toMatchObject({ ready: true });
  expect(profile.name).toBe("Riley Example");
});

it("discards basic details from an upload superseded while its profile check runs", async () => {
  const profile = fixture.state!.profile;
  const requestId = profile.resumeExtraction!.id;
  fixture.details.mockImplementationOnce(async () => {
    profile.resumeExtraction = { ...profile.resumeExtraction!, id: "newer", status: "queued" };
    return [{ key: "githubUrl", value: "https://github.com/stale" }];
  });
  expect(await runResumeExtraction({ userId: "owner", requestId })).toMatchObject({ ready: false });
  expect(profile.githubUrl).toBeUndefined();
  expect(fixture.extract).not.toHaveBeenCalled();
});

it("keeps all active profile details and facts when the profile grounding check fails", async () => {
  fixture.state!.profile.githubUrl = "https://github.com/previous";
  const before = structuredClone(fixture.state!.profile);
  fixture.details.mockRejectedValueOnce(new Error("Resume profile details could not be reliably grounded."));
  await expect(runResumeExtraction({ userId: "owner", requestId: before.resumeExtraction!.id })).rejects.toThrow("reliably grounded");
  expect(fixture.state!.profile.githubUrl).toBe(before.githubUrl);
  expect(fixture.state!.profile.facts).toEqual(before.facts);
  expect(fixture.extract).not.toHaveBeenCalled();
});

it("upgrades a previously extracted resume only once, using original bytes for embedded hyperlinks", async () => {
  const pending = fixture.state!.profile.resumeExtraction!.pending!;
  fixture.state!.profile.resumeSource = pending.source;
  fixture.state!.profile.resumeExtraction!.status = "ready";
  fixture.state!.profile.resumeExtraction!.pending = undefined;
  expect(await ensureResumeExtraction("owner", fixture.state!.profile)).toBe(true);
  expect(fixture.state!.profile.resumeExtraction!.pending!.document).toBeUndefined();
  fixture.state!.profile.resumeExtraction!.status = "ready";
  fixture.state!.profile.resumeDetailsVersion = 1;
  expect(await ensureResumeExtraction("owner", fixture.state!.profile)).toBe(false);
});

it("imports grounded basics into editable contact details without replacing the authenticated account email", async () => {
  const profile = fixture.state!.profile;
  const source = profile.resumeExtraction!.pending!.document!;
  const anchor = source.anchors.find(item => item.text.includes("riley@example.com"))!;
  const accountEmail = profile.email;
  profile.name = "Edited Previous Name";
  profile.contactEmail = "edited@example.com";
  onboardingImport();
  fixture.details.mockResolvedValue([
    { key: "name", value: "Riley Example", anchorId: anchor.id, quote: anchor.text },
    { key: "contactEmail", value: "riley@example.com", anchorId: anchor.id, quote: anchor.text },
  ]);
  expect(await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id })).toMatchObject({ ready: true });
  expect(profile.name).toBe("Riley Example");
  expect(profile.contactEmail).toBe("riley@example.com");
  expect(profile.email).toBe(accountEmail);
  expect(profile.phone).toBe("");
  expect(profile.links).toEqual([]);
  expect(profile.detailSources!.contactEmail).toMatchObject({ source: "resume", sourceHash: source.sourceHash });
});

it.each([
  ["Boston, MA", { city: "Boston", region: "MA", country: "United States" }],
  ["Almaty, Almaty Region, Kazakhstan", { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" }],
  ["Toronto, ON, Canada", { city: "Toronto", region: "ON", country: "Canada" }],
  ["Paris, France", { city: "Paris", region: "", country: "France" }],
  ["New York, NY 10001, USA", { city: "New York", region: "NY", country: "United States" }],
])("prefills structured current location only from grounded applicant detail: %s", async (value, expected) => {
  const profile = fixture.state!.profile;
  profile.currentLocation = undefined;
  onboardingImport();
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "location", value, anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.currentLocation).toEqual(expected);
  expect(profile.onboarding!.questionnaire.immigrationStatus).toBeUndefined();
});

it.each(["Boston", "Remote", "Boston, MA | Seattle, WA", "Preferred location: Boston, MA", "Tbilisi, Georgia", "Seattle, Georgia", "Seattle, NY", "State University, Boston, MA"])("leaves ambiguous or non-residential structured location blank: %s", async value => {
  const profile = fixture.state!.profile;
  profile.currentLocation = undefined;
  onboardingImport();
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "location", value, anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.currentLocation).toBeUndefined();
});

it.each([{ city: "Almaty", region: "Almaty Region", country: "Kazakhstan" }, { city: "Paris", region: "", country: "" }])("preserves previously entered or partial current location", async currentLocation => {
  const profile = fixture.state!.profile;
  profile.currentLocation = structuredClone(currentLocation);
  onboardingImport();
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "location", value: "Boston, MA", anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.currentLocation).toEqual(currentLocation);
});

it("preserves contact edits made after upload was queued", async () => {
  const profile = fixture.state!.profile;
  onboardingImport();
  profile.contactEmail = "during-extraction@example.com";
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "contactEmail", value: "riley@example.com", anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.contactEmail).toBe("during-extraction@example.com");
});

it("replaces an unchanged corrected link from a replacement resume", async () => {
  const profile = fixture.state!.profile;
  profile.githubUrl = "https://github.com/corrected";
  profile.detailSources = { githubUrl: { source: "user", value: profile.githubUrl } };
  onboardingImport();
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "githubUrl", value: "https://github.com/resume", anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.githubUrl).toBe("https://github.com/resume");
  expect(profile.links).toEqual(["https://github.com/resume"]);
});

it("preserves a link edited after replacement extraction was queued", async () => {
  const profile = fixture.state!.profile;
  profile.githubUrl = "https://github.com/corrected";
  profile.links = [profile.githubUrl];
  profile.detailSources = { githubUrl: { source: "user", value: profile.githubUrl } };
  onboardingImport();
  profile.githubUrl = "https://github.com/during-extraction";
  profile.links = [profile.githubUrl];
  profile.detailSources.githubUrl = { source: "user", value: profile.githubUrl };
  const source = profile.resumeExtraction!.pending!.document!;
  fixture.details.mockResolvedValue([{ key: "githubUrl", value: "https://github.com/resume", anchorId: source.anchors[0].id, quote: source.anchors[0].text }]);
  await runResumeExtraction({ userId: "owner", requestId: profile.resumeExtraction!.id });
  expect(profile.githubUrl).toBe("https://github.com/during-extraction");
  expect(profile.links).toEqual(["https://github.com/during-extraction"]);
});
