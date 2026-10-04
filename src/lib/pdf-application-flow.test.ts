import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  state: null as AppState | null,
  demo: true,
  tasks: [] as Array<{ task: string; payload: { userId: string; applicationId: string; runToken?: string } }>,
  parse: vi.fn(),
  browser: null as unknown,
}));

vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: async (task: string, payload: { userId: string; applicationId: string; runToken?: string }) => {
  fixture.tasks.push({ task, payload }); return { id: `dispatch-${fixture.tasks.length}` };
} } }));
vi.mock("@/lib/repository", () => ({
  isDemo: () => fixture.demo,
  currentUserId: async () => fixture.state!.profile.id,
  loadState: async () => structuredClone(fixture.state!),
  mutateState: async (_userId: string, change: (state: AppState) => unknown) => change(fixture.state!),
}));
vi.mock("@/lib/budget", () => ({
  serviceBudgetMonth: () => "2026-10",
  browserBudgetReservationId: (applicationId: string, attemptId: string) => `browser:${applicationId}:${attemptId}`,
  releaseBrowserBudget: async () => true,
  reserveServiceBudget: async () => true,
  reserveBrowserBudget: async () => true,
  reserveQueuedBudget: async (_userId: string, applicationId: string, queuedId: string, projectedUsd: number) => ({ queuedId, reservationId: `queued:${queuedId}`, month: "2026-10", ownerId: fixture.state!.profile.id, applicationId, projectedUsd }),
  releaseQueuedBudget: async () => true,
  markQueuedBudgetClaimed: async () => true,
  markQueuedBudgetTerminal: async () => true,
}));
vi.mock("openai", () => ({ default: class { responses = { parse: fixture.parse }; } }));
vi.mock("playwright-core", () => ({ chromium: { launch: async () => fixture.browser, connectOverCDP: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn().mockResolvedValue(undefined) }));

import { initialDemoState } from "@/lib/demo-data";
import { completeOnboardingFixture } from "@/lib/testing/onboarding";
import { resumeOnboardingStatus } from "@/lib/onboarding-completion";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { POST as uploadResume } from "@/app/api/resume/route";
import { POST as actionRoute } from "@/app/api/actions/route";
import { GET as applicationFile } from "@/app/api/applications/[id]/files/[kind]/route";
import { runDraft, runFill } from "@/lib/application-runs";
import { bytesHash } from "@/lib/resume-artifacts";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import { cancelBrowser } from "@/lib/browser-runner";
import { createControlledEmployerBrowser } from "@/lib/test-support/controlled-employer-browser";
import { assertSourceInformationComplete } from "@/lib/resume-source-draft";
import { unconfirmedPdfFactSuggestions } from "@/lib/source-plan-evidence";

let employer: ReturnType<typeof createControlledEmployerBrowser>;

beforeAll(async () => {
  await ensurePdfTestRuntime();
}, 150_000);

const publicAction = (action: string, payload: Record<string, unknown>) => actionRoute(new Request("https://apply.example/api/actions", {
  method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
}));

async function finishFixtureOnboarding() {
  const profile = fixture.state!.profile;
  const draft = await publicAction("onboardingDraft", { name: profile.name, email: profile.email || "synthetic@example.com", phone: profile.phone || "+1 212 555 0100",
    currentLocation: { city: "New York", region: "NY", country: "United States" }, preferredLocations: ["United States"], workArrangements: ["remote", "hybrid"],
    questionnaire: { immigrationStatus: "us-citizen", workAuthorization: "yes", sponsorshipNow: "no", sponsorshipFuture: "no" }, stage: "review" });
  expect(draft.status, await draft.clone().text()).toBe(200);
  const finished = await publicAction("finishOnboarding", { reviewHash: resumeOnboardingStatus(profile).reviewHash });
  expect(finished.status, await finished.clone().text()).toBe(200);
}

function responseFor(request: { input: Array<{ content: string }>; text: { format: { name: string } }; model: string }) {
  const name = request.text.format.name;
  if (name === "anchored_resume_edit_plan") {
    const body = JSON.parse(request.input[1].content) as { sourceDocument: { anchors: Array<{ id: string; kind: string; text: string; candidateClaim: boolean }> }; confirmedFacts: Array<{ id: string; sourceAnchorId?: string }> };
    return { edits: body.sourceDocument.anchors.filter((anchor) => anchor.candidateClaim && anchor.kind === "bullet").map((anchor) => ({
      anchorId: anchor.id,
      text: anchor.kind === "bullet" && anchor.text === "Built a search index for 1,200 users." ? "Built search index for 1,200 users." : anchor.text,
      factIds: [body.confirmedFacts.find((fact) => fact.sourceAnchorId === anchor.id)!.id],
    })) };
  }
  if (name === "anchored_resume_grounding_audit") {
    const body = JSON.parse(request.input[1].content) as { claims: Array<{ claimId: string; factIds: string[] }>; sourceActivityPreservationChecks: Array<{ sourceClaimId: string }> };
    return {
      findings: body.claims.map((claim) => ({ claimId: claim.claimId, outcome: "supported", reason: "Confirmed facts support this wording.", evidenceFactIds: claim.factIds, requiredInformation: null })),
      sourceActivityPreservations: body.sourceActivityPreservationChecks.map((check) => ({ sourceClaimId: check.sourceClaimId, outcome: "preserved", preservedClaimId: check.sourceClaimId,
        reason: "The same activity remains in the source bullet and entry.", requiredInformation: null })),
    };
  }
  if (name === "application_essay") {
    const body = JSON.parse(request.input[1].content) as { facts: Array<{ id: string; text: string }> };
    return { sentences: [{ text: "I am interested in this role.", kind: "perspective", factIds: [] }, { text: body.facts[0].text, kind: "fact", factIds: [body.facts[0].id] }] };
  }
  if (name === "essay_grounding_check") return { grounded: true, unsupportedClaims: [] };
  throw new Error(`Unexpected model format: ${name}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture"); vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("MODEL_USAGE_TEST_DIR", `/tmp/pdf-flow-usage-${process.pid}`);
  fixture.demo = true; fixture.tasks = [];
  fixture.state = initialDemoState();
  fixture.state.profile = completeOnboardingFixture(fixture.state.profile);
  fixture.state.profile.id = "pdf-flow-owner";
  fixture.state.applications = [];
  fixture.state.jobs[0].url = "https://jobs.example/apply";
  fixture.state.jobs[0].applyUrl = "https://jobs.example/apply";
  employer = createControlledEmployerBrowser({ targetUrl: fixture.state.jobs[0].applyUrl, html: "<title>Application</title><h1>Application</h1><form action=\"https://jobs.example/apply\" method=\"post\" enctype=\"multipart/form-data\"><label for=\"resume\">Resume</label><input id=\"resume\" name=\"resume\" type=\"file\" accept=\".pdf,application/pdf\" required><button type=\"submit\">Submit application</button></form>" });
  fixture.browser = employer.browser;
  fixture.parse.mockImplementation(async (request: Parameters<typeof responseFor>[0]) => ({
    id: `fixture-${fixture.parse.mock.calls.length}`, model: request.model, service_tier: "default", output_parsed: responseFor(request),
    usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
  }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const app of fixture.state?.applications ?? []) await cancelBrowser(app).catch(() => undefined);
  await rm(`/tmp/pdf-flow-usage-${process.pid}`, { recursive: true, force: true });
  for (const app of fixture.state?.applications ?? []) {
    await rm(`.data/screenshots/${app.id}.png`, { force: true });
    for (const file of app.packet?.files ?? []) if (file.storageKey) await rm(`.data/application-files/${file.storageKey}`, { force: true });
    if (app.packet?.resumeArtifact?.format === "pdf") {
      await rm(`.data/application-files/${app.packet.resumeArtifact.baseline.storageKey}`, { force: true });
      await rm(`.data/application-files/${app.packet.resumeArtifact.source.storageKey}`, { force: true });
    }
  }
  const originalKey = fixture.state?.profile.resumeSource?.storageKey;
  if (originalKey) await rm(`.data/resumes/${originalKey}`, { force: true });
});

it("uploads, confirms unbulleted qualifications, drafts, renders, previews, downloads, and attaches the exact PDFBox artifact", async () => {
  const sourceBytes = await createPdfSourceFixture({ qualificationText: "Python, scikit-learn, and PostgreSQL", positionedWordSpacing: true, sectionDivider: true });
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], "source.pdf", { type: "application/pdf" }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  expect(fixture.state!.profile.resumeSourceDocument?.text).toContain("Built a search index for 1,200 users.");
  const skillsAnchor = fixture.state!.profile.resumeSourceDocument!.anchors.find((anchor) => anchor.text === "Python, scikit-learn, and PostgreSQL")!;
  expect(skillsAnchor.candidateClaim).toBe(true);
  expect(fixture.state!.profile.facts.find((fact) => fact.sourceAnchorId === skillsAnchor.id)).toMatchObject({ verified: false, source: "resume" });

  const confirmedFacts = fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ ...fact, verified: true }));
  const confirmed = await publicAction("onboarding", { facts: confirmedFacts });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  expect(fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).every((fact) => fact.verified)).toBe(true);
  await finishFixtureOnboarding();

  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(200);
  const handoff = fixture.tasks.find((item) => item.task === "draft-application-packet")!;
  await runDraft(handoff.payload);
  expect(application.status).toBe("draft_review");
  expect(application.packet).toMatchObject({ schemaVersion: 3, resumeArtifact: { format: "pdf", renderer: "apache-pdfbox", pageCount: 1, layoutValidation: { outcome: "passed" } } });

  const file = (kind: string, query = "") => applicationFile(new Request(`https://apply.example/api/applications/${application.id}/files/${kind}${query}`), { params: Promise.resolve({ id: application.id, kind }) });
  const preview = await file("resume");
  const download = await file("resume", "?download=1");
  const sourceDownload = await file("resume-source");
  const originalPreview = await file("resume-original-preview");
  expect(preview.status).toBe(200); expect(download.status).toBe(200); expect(sourceDownload.status).toBe(200); expect(originalPreview.status).toBe(200);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  expect(previewBytes).toEqual(Buffer.from(await download.arrayBuffer()));
  expect(previewBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(preview.headers.get("content-disposition")).toContain("inline");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(sourceDownload.headers.get("content-type")).toBe("application/pdf");
  expect(Buffer.from(await sourceDownload.arrayBuffer())).toEqual(sourceBytes);
  expect(Buffer.from(await originalPreview.arrayBuffer())).toEqual(sourceBytes);
  const tailoredText = (await parsePdfSource(previewBytes)).text;
  expect(tailoredText).toContain("Built search index for 1,200 users.");
  expect(tailoredText).not.toContain("Built a search index for 1,200 users.");

  const essayIndex = application.packet!.answers.findIndex((answer) => answer.aiDraft);
  expect(essayIndex).toBeGreaterThanOrEqual(0);
  const essay = application.packet!.answers[essayIndex];
  const essayConfirmed = await publicAction("confirmEssay", { applicationId: application.id, packetHash: application.packetHash, answerIndex: essayIndex, answerHash: essay.aiDraft!.contentHash });
  expect(essayConfirmed.status, await essayConfirmed.clone().text()).toBe(200);
  const approved = await publicAction("approveFill", { applicationId: application.id, packetHash: application.packetHash });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const started = await publicAction("startBrowser", { applicationId: application.id });
  expect(started.status, await started.clone().text()).toBe(200);
  const fillHandoff = fixture.tasks.find((item) => item.task === "fill-application-form")!;
  await runFill(fillHandoff.payload);
  const attached = await employer.attachedFiles();
  expect(attached).toHaveLength(1);
  expect(attached[0]).toMatchObject({ name: "tailored-resume.pdf", mimeType: "application/pdf", sha256: bytesHash(previewBytes) });
  expect(attached[0].bytes).toEqual(previewBytes);
  expect(employer.observations().submitClicks).toBe(0);
  expect(application.form?.fields[0].fileHashes).toEqual([`tailored-resume.pdf:${previewBytes.length}:${bytesHash(previewBytes)}`]);
  expect({ status: application.status, readyToSubmit: application.form?.readyToSubmit, blockers: application.form?.blockers }).toMatchObject({ status: "final_review", readyToSubmit: true, blockers: [] });

  const submissionApproved = await publicAction("approveSubmit", { applicationId: application.id, formHash: application.form!.hash });
  expect(submissionApproved.status, await submissionApproved.clone().text()).toBe(200);
  const submit = await publicAction("submit", { applicationId: application.id });
  expect(submit.status, await submit.clone().text()).toBe(200);
  expect(application.status).toBe("submitting");
  expect(application.submissionStartedAt).toBeTruthy();
  expect(fixture.tasks.some((item) => item.task === "submit-application-form")).toBe(true);
}, 180_000);

it("re-inspects a cached parser-v2 PDF before drafting and keeps confirmed source-fact identities", async () => {
  const sourceBytes = await createPdfSourceFixture();
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], "source.pdf", { type: "application/pdf" }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  const confirmedFacts = fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ ...fact, verified: true }));
  const confirmed = await publicAction("onboarding", { facts: confirmedFacts });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  await finishFixtureOnboarding();
  const originalAnchorIds = fixture.state!.profile.resumeSourceDocument!.anchors.map((anchor) => anchor.id);
  const originalFactLinks = fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ id: fact.id, anchorId: fact.sourceAnchorId }));

  const cached = structuredClone(fixture.state!.profile.resumeSourceDocument!);
  if (cached.format !== "pdf") throw new Error("The upload did not create a PDF source cache.");
  cached.version = 2;
  cached.parser = "pdfjs-text-2";
  cached.support = { status: "blocked", reason: "Older parser text spans could not be matched to PDF source operators." };
  for (const anchor of cached.anchors) {
    delete anchor.showOperatorIndex;
    delete anchor.operatorText;
  }
  fixture.state!.profile.resumeSourceDocument = cached;

  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(200);
  await runDraft(fixture.tasks.find((item) => item.task === "draft-application-packet")!.payload);

  expect(fixture.state!.profile.resumeSourceDocument).toMatchObject({ version: 3, parser: "pdfjs-text-3", support: { status: "candidate" } });
  expect(fixture.state!.profile.resumeText).toBe(fixture.state!.profile.resumeSourceDocument!.text);
  expect(fixture.state!.profile.resumeSourceDocument!.anchors.map((anchor) => anchor.id)).toEqual(originalAnchorIds);
  expect(fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ id: fact.id, anchorId: fact.sourceAnchorId }))).toEqual(originalFactLinks);
  expect(fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).every((fact) => fact.verified)).toBe(true);
  expect(application.packet?.resumeArtifact).toMatchObject({ format: "pdf", renderer: "apache-pdfbox", layoutValidation: { outcome: "passed" } });

  const priorPacket = structuredClone(application.packet);
  const legacyAgain = structuredClone(fixture.state!.profile.resumeSourceDocument!);
  if (legacyAgain.format !== "pdf") throw new Error("The refreshed source cache changed formats.");
  legacyAgain.version = 2;
  legacyAgain.parser = "pdfjs-text-2";
  legacyAgain.support = { status: "blocked", reason: "Older parser text spans could not be matched to PDF source operators." };
  fixture.state!.profile.resumeSourceDocument = legacyAgain;
  const staleFact = fixture.state!.profile.facts.find((fact) => fact.sourceAnchorId)!;
  staleFact.sourceAnchorId = "stale-confirmed-anchor";
  const priorModelCalls = fixture.parse.mock.calls.length;
  const retry = await publicAction("draft", { applicationId: application.id, draftMode: "resume" });
  expect(retry.status, await retry.clone().text()).toBe(200);
  const retryPayload = fixture.tasks.filter((item) => item.task === "draft-application-packet")[1].payload;
  await expect(runDraft(retryPayload)).rejects.toThrow(/confirmed résumé fact no longer matches/i);
  expect(application.status).toBe("draft_review");
  expect(application.runWorkerClaimedAt).toBeUndefined();
  expect(application.packet).toEqual(priorPacket);
  expect(fixture.parse).toHaveBeenCalledTimes(priorModelCalls);
}, 180_000);

it.each([2, 3] as const)("recovers a missing confirmation from an existing parser-v%1 PDF cache without changing confirmed facts", async (version) => {
  const sourceBytes = await createPdfSourceFixture();
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], "source.pdf", { type: "application/pdf" }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  const source = fixture.state!.profile.resumeSourceDocument!;
  const missingAnchor = source.anchors.find((anchor) => anchor.kind === "bullet" && anchor.candidateClaim)!;
  const confirmedFacts = fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ ...fact, verified: true }));
  const missingFact = confirmedFacts.find((fact) => fact.sourceAnchorId === missingAnchor.id)!;
  const keptFacts = confirmedFacts.filter((fact) => fact.id !== missingFact.id);
  const confirmed = await publicAction("onboarding", { facts: keptFacts });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  await finishFixtureOnboarding();
  const originalFacts = structuredClone(fixture.state!.profile.facts);

  if (version === 2) {
    const legacy = structuredClone(source);
    if (legacy.format !== "pdf") throw new Error("Expected PDF fixture source.");
    legacy.version = 2;
    legacy.parser = "pdfjs-text-2";
    legacy.support = { status: "blocked", reason: "Cached legacy source needs reinspection." };
    for (const anchor of legacy.anchors) { delete anchor.showOperatorIndex; delete anchor.operatorText; }
    fixture.state!.profile.resumeSourceDocument = legacy;
  }

  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(200);
  const handoff = fixture.tasks.find((item) => item.task === "draft-application-packet")!;
  await expect(runDraft(handoff.payload)).rejects.toThrow(/Review 1 original résumé claim in your profile/i);

  const recovered = fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId === missingAnchor.id);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({ text: missingFact.text, verified: false, source: "resume" });
  expect(fixture.state!.profile.facts.filter((fact) => fact.id !== recovered[0].id)).toEqual(originalFacts);
  expect(unconfirmedPdfFactSuggestions(fixture.state!.profile, fixture.state!.profile.resumeSourceDocument!)).toEqual([]);
  expect(fixture.state!.profile.resumeSourceDocument?.version).toBe(3);
  expect(fixture.state!.applications[0].resumeDraftDiagnostics).toMatchObject({ outcome: "needs_information", writerAttempts: 0, findings: [{ claimId: missingAnchor.id }] });
  expect(fixture.parse).not.toHaveBeenCalled();

  const reviewed = await publicAction("onboarding", { facts: fixture.state!.profile.facts.map((fact) => fact.id === recovered[0].id ? { ...fact, verified: true } : fact) });
  expect(reviewed.status, await reviewed.clone().text()).toBe(200);
  expect(() => assertSourceInformationComplete(fixture.state!.profile.resumeSourceDocument!, fixture.state!.profile)).not.toThrow();
}, 180_000);

it("blocks a pre-feature PDF at the worker instead of using a generic résumé", async () => {
  fixture.state!.profile.resumeFileName = "older-source.pdf";
  fixture.state!.profile.resumeSource = { storageKey: `${fixture.state!.profile.id}/00000000-0000-4000-8000-000000000001.pdf`, sha256: "a".repeat(64), size: 1000, mimeType: "application/pdf" };
  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(400);
  expect(application.status).toBe("selected");
  expect(application.packet).toBeUndefined();
  expect(fixture.tasks).toEqual([]);
  expect(fixture.parse).not.toHaveBeenCalled();
});

it("blocks a new enabled worker draft without an owner-checked original before model work", async () => {
  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(200);
  const handoff = fixture.tasks.find((item) => item.task === "draft-application-packet")!;

  await expect(runDraft(handoff.payload)).rejects.toThrow(/manifest is invalid|upload and confirm your original pdf or docx/i);
  expect(application.status).toBe("selected");
  expect(application.packet).toBeUndefined();
  expect(fixture.parse).not.toHaveBeenCalled();
});

it.each([undefined, "resume"] as const)("prepares exact original bytes after tailoring is disabled even when the prior source plan is stale (%s draft)", async (draftMode) => {
  const sourceBytes = await createPdfSourceFixture();
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], "source.pdf", { type: "application/pdf" }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  const confirmed = await publicAction("onboarding", { facts: fixture.state!.profile.facts.map((fact) => ({ ...fact, verified: true })) });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  await finishFixtureOnboarding();

  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const firstDraft = await publicAction("draft", { applicationId: application.id });
  expect(firstDraft.status, await firstDraft.clone().text()).toBe(200);
  await runDraft(fixture.tasks.find((item) => item.task === "draft-application-packet")!.payload);
  expect(application.packet?.resumeSourcePlan).toBeDefined();

  const settings = await publicAction("automationSettings", { settings: { resumeTailoring: false } });
  expect(settings.status, await settings.clone().text()).toBe(200);
  fixture.state!.jobs[0].description = "Updated synthetic posting with changed duties.";
  const originalDraft = await publicAction("draft", { applicationId: application.id, ...(draftMode ? { draftMode } : {}) });
  expect(originalDraft.status, await originalDraft.clone().text()).toBe(200);

  await runDraft(fixture.tasks.filter((item) => item.task === "draft-application-packet")[1].payload);

  expect(application.status).toBe("draft_review");
  expect(application.packet).toMatchObject({ resumeMode: "original", originalResume: { sha256: fixture.state!.profile.resumeSource!.sha256 } });
  expect(application.packet?.resumeSourcePlan).toBeUndefined();
  expect(application.packet?.resumeArtifact).toBeUndefined();
  const preview = await applicationFile(new Request(`https://apply.example/api/applications/${application.id}/files/resume`), { params: Promise.resolve({ id: application.id, kind: "resume" }) });
  expect(preview.status).toBe(200);
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(sourceBytes);
}, 120_000);
