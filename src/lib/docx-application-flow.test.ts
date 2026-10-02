import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { POST as uploadResume } from "@/app/api/resume/route";
import { POST as actionRoute } from "@/app/api/actions/route";
import { GET as applicationFile } from "@/app/api/applications/[id]/files/[kind]/route";
import { runDraft, runFill } from "@/lib/application-runs";
import { reviewedPacketFile } from "@/lib/packet-files";
import { bytesHash } from "@/lib/resume-artifacts";

const runtime = (() => {
  const candidates = [process.env.TEST_DOCX_SOFFICE_BIN, process.env.SOFFICE_BIN, process.platform === "linux" ? "/usr/bin/soffice" : undefined]
    .filter((value): value is string => Boolean(value));
  for (const binary of candidates) {
    if (!existsSync(binary)) continue;
    try {
      const output = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 8_000 }).trim().split("\n")[0];
      const version = output.match(/^(?:LibreOfficeDev|LibreOffice) (\S+)/)?.[1];
      if (version) return { binary, version };
    } catch { /* Skip unusable local converter paths. */ }
  }
  return undefined;
})();

const publicAction = (action: string, payload: Record<string, unknown>) => actionRoute(new Request("https://apply.example/api/actions", {
  method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
}));

function responseFor(request: { input: Array<{ content: string }>; text: { format: { name: string } }; model: string }) {
  const name = request.text.format.name;
  if (name === "anchored_resume_edit_plan") {
    const layoutRepair = request.input[0].content.includes("This is a layout fit repair");
    const body = JSON.parse(request.input[1].content) as { sourceDocument: { anchors: Array<{ id: string; kind: string; text: string; candidateClaim: boolean }> }; confirmedFacts: Array<{ id: string; sourceAnchorId?: string }> };
    return { claims: body.sourceDocument.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({
      anchorId: anchor.id,
      text: anchor.text === "Built a recommender with 92% precision." ? layoutRepair ? "Built recommender with 92% precision." : "Built an explainable recommender with 92% precision." : anchor.text,
      factIds: [body.confirmedFacts.find((fact) => fact.sourceAnchorId === anchor.id)!.id],
    })) };
  }
  if (name === "anchored_resume_grounding_audit") {
    const body = JSON.parse(request.input[1].content) as { claims: Array<{ claimId: string; factIds: string[] }>; sourceActivityPreservationChecks: Array<{ sourceClaimId: string }> };
    return {
      findings: body.claims.map((claim) => ({ claimId: claim.claimId, outcome: "supported", reason: "Confirmed facts support this wording.", evidenceFactIds: claim.factIds, requiredInformation: null })),
      sourceActivityPreservations: body.sourceActivityPreservationChecks.map((check) => ({ sourceClaimId: check.sourceClaimId, outcome: "preserved", preservedClaimId: check.sourceClaimId, reason: "The same activity remains in the source bullet and entry.", requiredInformation: null })),
    };
  }
  if (name === "application_essay") {
    const body = JSON.parse(request.input[1].content) as { facts: Array<{ id: string; text: string }> };
    const fact = body.facts[0];
    return { sentences: [{ text: "I am interested in this role.", kind: "perspective", factIds: [] }, { text: fact.text, kind: "fact", factIds: [fact.id] }] };
  }
  if (name === "essay_grounding_check") return { grounded: true, unsupportedClaims: [] };
  throw new Error(`Unexpected model format: ${name}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture"); vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("MODEL_USAGE_TEST_DIR", `/tmp/docx-flow-usage-${process.pid}`);
  fixture.demo = true; fixture.tasks = []; fixture.attached = [];
  fixture.state = initialDemoState();
  fixture.state.profile.id = "docx-flow-owner";
  fixture.state.applications = [];
  fixture.parse.mockImplementation(async (request: Parameters<typeof responseFor>[0]) => ({
    id: `fixture-${fixture.parse.mock.calls.length}`, model: request.model, service_tier: "default", output_parsed: responseFor(request),
    usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
  }));
  fixture.prepare.mockImplementation(async (application: Application, job: AppState["jobs"][number], profile: Profile, onSession: (session: { sessionId: string; provider: "browser-use" }) => Promise<boolean>, onAction: (label: string) => Promise<boolean>) => {
    await onSession({ sessionId: "docx-flow-browser", provider: "browser-use" });
    await onAction("Checking permission: Resume");
    const attachment = await reviewedPacketFile(profile, application.packet!, "resume");
    fixture.attached.push(attachment);
    return { sessionId: "docx-flow-browser", provider: "browser-use", needsAction: false, needsCoverLetter: false, form: {
      version: 1, url: job.applyUrl, capturedAt: new Date().toISOString(), readyToSubmit: true, blockers: [], attachments: [attachment.filename],
      fields: [{ label: "Resume", identifier: "resume", kind: "file", required: true, valid: true, value: attachment.filename, fileHashes: [`${attachment.filename}:${attachment.bytes.length}:${bytesHash(attachment.bytes)}`] }],
    } };
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(`/tmp/docx-flow-usage-${process.pid}`, { recursive: true, force: true });
  for (const app of fixture.state?.applications ?? []) {
    for (const file of app.packet?.files ?? []) if (file.storageKey) await rm(`.data/application-files/${file.storageKey}`, { force: true });
    if (app.packet?.resumeArtifact?.format === "docx") {
      await rm(`.data/application-files/${app.packet.resumeArtifact.baseline.storageKey}`, { force: true });
      await rm(`.data/application-files/${app.packet.resumeArtifact.source.storageKey}`, { force: true });
    }
  }
  const originalKey = fixture.state?.profile.resumeSource?.storageKey;
  if (originalKey) await rm(`.data/resumes/${originalKey}`, { force: true });
});

async function exerciseDocxFlow(multiPage: boolean) {
  vi.stubEnv("SOFFICE_BIN", runtime!.binary); vi.stubEnv("DOCX_RENDERER_VERSION", runtime!.version);
  const sourceBytes = await createDocxSourceFixture({ multiPage });
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], "source.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  const source = fixture.state!.profile.resumeSourceDocument!;
  expect(source.text).toContain("Built a recommender with 92% precision.");
  expect(source.anchors.some((anchor) => anchor.kind === "bullet" && anchor.candidateClaim)).toBe(true);

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
  const draftHandoff = fixture.tasks.find((item) => item.task === "draft-application-packet")!;
  expect(draftHandoff.payload.applicationId).toBe(application.id);
  await runDraft(draftHandoff.payload);
  expect(application.status).toBe("draft_review");
  expect(application.packet).toMatchObject({ schemaVersion: 3, resumeArtifact: { format: "docx", pageCount: multiPage ? 2 : 1, layoutValidation: { outcome: "passed" } } });
  expect(application.packet?.resumeSourcePlan?.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 });

  const preview = await applicationFile(new Request(`https://apply.example/api/applications/${application.id}/files/resume`), { params: Promise.resolve({ id: application.id, kind: "resume" }) });
  const download = await applicationFile(new Request(`https://apply.example/api/applications/${application.id}/files/resume?download=1`), { params: Promise.resolve({ id: application.id, kind: "resume" }) });
  const sourceDownload = await applicationFile(new Request(`https://apply.example/api/applications/${application.id}/files/resume-source`), { params: Promise.resolve({ id: application.id, kind: "resume-source" }) });
  expect(preview.status).toBe(200); expect(download.status).toBe(200);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  expect(previewBytes).toEqual(Buffer.from(await download.arrayBuffer()));
  expect(previewBytes.subarray(0, 5).toString()).toBe("%PDF-");
  const finalText = await parsePdfSource(previewBytes);
  if (multiPage) expect(finalText.text).toContain("Improved model recall to 94%.");
  expect(preview.headers.get("content-disposition")).toContain("inline");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(sourceDownload.status).toBe(200);
  expect(sourceDownload.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const savedDocx = Buffer.from(await sourceDownload.arrayBuffer());
  expect((await parseDocxSource(savedDocx)).anchors.find((anchor) => anchor.kind === "bullet")?.text).toBe("Built recommender with 92% precision.");

  const essayIndex = application.packet!.answers.findIndex((answer) => answer.aiDraft);
  expect(essayIndex, JSON.stringify({ answers: application.packet!.answers, formats: fixture.parse.mock.calls.map((call) => call[0].text.format.name) })).toBeGreaterThanOrEqual(0);
  const essay = application.packet!.answers[essayIndex];
  const essayConfirmed = await publicAction("confirmEssay", { applicationId: application.id, packetHash: application.packetHash,
    answerIndex: essayIndex, answerHash: essay.aiDraft!.contentHash });
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
  expect(fixture.attached[0].bytes).toEqual(previewBytes);
  expect(application.form?.attachments).toEqual(["tailored-resume.pdf"]);

  const submissionApproved = await publicAction("approveSubmit", { applicationId: application.id, formHash: application.form!.hash });
  expect(submissionApproved.status, await submissionApproved.clone().text()).toBe(200);
  const submit = await publicAction("submit", { applicationId: application.id });
  expect(submit.status, await submit.clone().text()).toBe(200);
  expect(application.status).toBe("submitting");
  expect(application.submissionStartedAt).toBeTruthy();
  expect(fixture.tasks.some((item) => item.task === "submit-application-form")).toBe(true);
}

it.skipIf(!runtime)("uploads, confirms, drafts, renders, reviews, downloads, and attaches the exact saved one-page DOCX-based PDF", async () => {
  await exerciseDocxFlow(false);
});

it.skipIf(!runtime)("preserves a single-column DOCX entry continuation across a rendered page break", async () => {
  await exerciseDocxFlow(true);
});

it("blocks a pre-feature DOCX at the worker instead of replacing it with a generic template", async () => {
  vi.stubEnv("DEMO_MODE", "true");
  fixture.state!.profile.resumeFileName = "older-source.docx";
  fixture.state!.profile.resumeSource = { storageKey: `${fixture.state!.profile.id}/00000000-0000-4000-8000-000000000001.docx`,
    sha256: "a".repeat(64), size: 1000, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
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
