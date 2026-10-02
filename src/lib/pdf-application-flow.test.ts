import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { AppState, Application, Profile } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  state: null as AppState | null,
  demo: true,
  tasks: [] as Array<{ task: string; payload: { userId: string; applicationId: string; runToken?: string } }>,
  parse: vi.fn(),
  prepare: vi.fn(),
  attached: [] as Array<{ bytes: Buffer; filename: string; mimeType: string }>,
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
vi.mock("@/lib/browser-runner", () => ({
  prepareBrowser: fixture.prepare,
  preflightBrowser: vi.fn(), submitBrowser: vi.fn(), cancelBrowser: vi.fn().mockResolvedValue(undefined),
  refreshBrowserSnapshot: vi.fn(), repairEducationFields: vi.fn(), fillApprovedBrowserAnswers: vi.fn(), checkBrowserSubmission: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn().mockResolvedValue(undefined) }));

import { initialDemoState } from "@/lib/demo-data";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { POST as uploadResume } from "@/app/api/resume/route";
import { POST as actionRoute } from "@/app/api/actions/route";
import { GET as applicationFile } from "@/app/api/applications/[id]/files/[kind]/route";
import { runDraft, runFill } from "@/lib/application-runs";
import { reviewedPacketFile } from "@/lib/packet-files";
import { bytesHash } from "@/lib/resume-artifacts";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";

beforeAll(async () => {
  await ensurePdfTestRuntime();
}, 150_000);

const publicAction = (action: string, payload: Record<string, unknown>) => actionRoute(new Request("https://apply.example/api/actions", {
  method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
}));

function responseFor(request: { input: Array<{ content: string }>; text: { format: { name: string } }; model: string }) {
  const name = request.text.format.name;
  if (name === "anchored_resume_edit_plan") {
    const body = JSON.parse(request.input[1].content) as { sourceDocument: { anchors: Array<{ id: string; kind: string; text: string; candidateClaim: boolean }> }; confirmedFacts: Array<{ id: string; sourceAnchorId?: string }> };
    return { claims: body.sourceDocument.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({
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
  fixture.demo = true; fixture.tasks = []; fixture.attached = [];
  fixture.state = initialDemoState();
  fixture.state.profile.id = "pdf-flow-owner";
  fixture.state.applications = [];
  fixture.parse.mockImplementation(async (request: Parameters<typeof responseFor>[0]) => ({
    id: `fixture-${fixture.parse.mock.calls.length}`, model: request.model, service_tier: "default", output_parsed: responseFor(request),
    usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
  }));
  fixture.prepare.mockImplementation(async (application: Application, job: AppState["jobs"][number], profile: Profile, onSession: (session: { sessionId: string; provider: "browser-use" }) => Promise<boolean>, onAction: (label: string) => Promise<boolean>) => {
    await onSession({ sessionId: "pdf-flow-browser", provider: "browser-use" });
    await onAction("Checking permission: Resume");
    const attachment = await reviewedPacketFile(profile, application.packet!, "resume");
    fixture.attached.push(attachment);
    return { sessionId: "pdf-flow-browser", provider: "browser-use", needsAction: false, needsCoverLetter: false, form: {
      version: 1, url: job.applyUrl, capturedAt: new Date().toISOString(), readyToSubmit: true, blockers: [], attachments: [attachment.filename],
      fields: [{ label: "Resume", identifier: "resume", kind: "file", required: true, valid: true, value: attachment.filename,
        fileHashes: [`${attachment.filename}:${attachment.bytes.length}:${bytesHash(attachment.bytes)}`] }],
    } };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(`/tmp/pdf-flow-usage-${process.pid}`, { recursive: true, force: true });
  for (const app of fixture.state?.applications ?? []) {
    for (const file of app.packet?.files ?? []) if (file.storageKey) await rm(`.data/application-files/${file.storageKey}`, { force: true });
    if (app.packet?.resumeArtifact?.format === "pdf") {
      await rm(`.data/application-files/${app.packet.resumeArtifact.baseline.storageKey}`, { force: true });
      await rm(`.data/application-files/${app.packet.resumeArtifact.source.storageKey}`, { force: true });
    }
  }
  const originalKey = fixture.state?.profile.resumeSource?.storageKey;
  if (originalKey) await rm(`.data/resumes/${originalKey}`, { force: true });
});

it("uploads, confirms, drafts, renders, previews, downloads, and attaches the exact PDFBox artifact", async () => {
  const sourceBytes = await createPdfSourceFixture();
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], "source.pdf", { type: "application/pdf" }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  expect(fixture.state!.profile.resumeSourceDocument?.text).toContain("Built a search index for 1,200 users.");

  const confirmedFacts = fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ ...fact, verified: true }));
  const confirmed = await publicAction("onboarding", { facts: confirmedFacts });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  expect(fixture.state!.profile.facts.filter((fact) => fact.sourceAnchorId).every((fact) => fact.verified)).toBe(true);

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
  expect(fixture.attached).toHaveLength(1);
  expect(fixture.attached[0]).toMatchObject({ filename: "tailored-resume.pdf", mimeType: "application/pdf" });
  expect(fixture.attached[0].bytes).toEqual(previewBytes);
  expect(application.form?.fields[0].fileHashes).toEqual([`tailored-resume.pdf:${previewBytes.length}:${bytesHash(previewBytes)}`]);

  const submissionApproved = await publicAction("approveSubmit", { applicationId: application.id, formHash: application.form!.hash });
  expect(submissionApproved.status, await submissionApproved.clone().text()).toBe(200);
  const submit = await publicAction("submit", { applicationId: application.id });
  expect(submit.status, await submit.clone().text()).toBe(200);
  expect(application.status).toBe("submitting");
  expect(application.submissionStartedAt).toBeTruthy();
  expect(fixture.tasks.some((item) => item.task === "submit-application-form")).toBe(true);
}, 180_000);

it("blocks a pre-feature PDF at the worker instead of using a generic résumé", async () => {
  fixture.state!.profile.resumeFileName = "older-source.pdf";
  fixture.state!.profile.resumeSource = { storageKey: `${fixture.state!.profile.id}/00000000-0000-4000-8000-000000000001.pdf`, sha256: "a".repeat(64), size: 1000, mimeType: "application/pdf" };
  fixture.demo = false;
  const selected = await publicAction("select", { jobId: fixture.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = fixture.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(200);
  const handoff = fixture.tasks.find((item) => item.task === "draft-application-packet")!;
  await expect(runDraft(handoff.payload)).rejects.toThrow(/predates source-aware résumé review.*re-upload/i);
  expect(application.status).toBe("selected");
  expect(application.packet).toBeUndefined();
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

  await expect(runDraft(handoff.payload)).rejects.toThrow(/upload and confirm your original pdf or docx/i);
  expect(application.status).toBe("selected");
  expect(application.packet).toBeUndefined();
  expect(fixture.parse).not.toHaveBeenCalled();
});
