import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { AppState } from "@/lib/types";

const flow = vi.hoisted(() => ({
  state: null as AppState | null,
  demo: true,
  tasks: [] as Array<{ task: string; payload: { userId: string; applicationId: string; runToken?: string } }>,
  parse: vi.fn(),
  browser: null as unknown,
  uploaded: [] as Array<{ name: string; mimeType: string; bytes: Buffer }>,
  editClaims: [] as Array<{ anchorId: string; text: string; factIds: string[] }>,
  layoutMode: "none" as "none" | "repair" | "exhaust",
  layoutRepairCount: 0,
}));

vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: async (task: string, payload: { userId: string; applicationId: string; runToken?: string }) => {
  flow.tasks.push({ task, payload }); return { id: `dispatch-${flow.tasks.length}` };
} } }));
vi.mock("@/lib/repository", () => ({
  isDemo: () => flow.demo,
  currentUserId: async () => flow.state!.profile.id,
  loadState: async () => structuredClone(flow.state!),
  mutateState: async (_userId: string, change: (state: AppState) => unknown) => change(flow.state!),
}));
vi.mock("@/lib/budget", () => ({
  serviceBudgetMonth: () => "2026-10",
  browserBudgetReservationId: (applicationId: string, attemptId: string) => `browser:${applicationId}:${attemptId}`,
  releaseBrowserBudget: async () => true,
  reserveServiceBudget: async () => true,
  reserveBrowserBudget: async () => true,
  reserveQueuedBudget: async (_userId: string, applicationId: string, queuedId: string, projectedUsd: number) => ({ queuedId, reservationId: `queued:${queuedId}`, month: "2026-10", ownerId: flow.state!.profile.id, applicationId, projectedUsd }),
  releaseQueuedBudget: async () => true,
  markQueuedBudgetClaimed: async () => true,
  markQueuedBudgetTerminal: async () => true,
}));
vi.mock("openai", () => ({ default: class { responses = { parse: flow.parse }; } }));
vi.mock("playwright-core", () => ({ chromium: { launch: async () => flow.browser } }));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn().mockResolvedValue(undefined) }));

import { initialDemoState } from "@/lib/demo-data";
import { createTwoColumnDocxFixture, createTwoColumnPdfFixture } from "@/lib/fixtures/two-column-resume";
import { parsePdfSource } from "@/lib/pdf-source";
import { POST as uploadResume } from "@/app/api/resume/route";
import { POST as actionRoute } from "@/app/api/actions/route";
import { GET as applicationFile } from "@/app/api/applications/[id]/files/[kind]/route";
import { runDraft, runFill } from "@/lib/application-runs";
import { cancelBrowser } from "@/lib/browser-runner";
import { bytesHash } from "@/lib/resume-artifacts";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";

const sofficeRuntime = (() => {
  const candidates = [process.env.TEST_DOCX_SOFFICE_BIN, process.env.SOFFICE_BIN, "/app/docx-runtime/opt/libreoffice26.8/program/soffice", "/usr/bin/soffice", "soffice"]
    .filter((value): value is string => Boolean(value));
  for (const binary of candidates) {
    if (binary !== "soffice" && !existsSync(binary)) continue;
    try {
      const output = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 8_000 }).trim().split("\n")[0];
      const version = output.match(/^(?:LibreOfficeDev|LibreOffice) (\S+)/)?.[1];
      if (version) return { binary, version };
    } catch { /* The container may not include the optional DOCX runtime. */ }
  }
  return undefined;
})();

const publicAction = (action: string, payload: Record<string, unknown>) => actionRoute(new Request("https://apply.example/api/actions", {
  method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
}));

type ModelRequest = { input: Array<{ content: string }>; text: { format: { name: string } }; model: string };
type AnchoredPlanInput = {
  sourceDocument: { anchors: Array<{ id: string; kind: string; text: string; candidateClaim: boolean; entryId?: string; entryHeading?: string; regionId?: string }> };
  confirmedFacts: Array<{ id: string; sourceAnchorId?: string }>;
};

function responseFor(request: ModelRequest) {
  const name = request.text.format.name;
  if (name === "anchored_resume_edit_plan") {
    const layoutRepair = request.input[0].content.includes("layout fit repair");
    const retryIndex = layoutRepair ? flow.layoutRepairCount++ : 0;
    const body = JSON.parse(request.input[1].content) as AnchoredPlanInput;
    const claims = body.sourceDocument.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => {
      const fact = body.confirmedFacts.find((candidate) => candidate.sourceAnchorId === anchor.id);
      if (!fact) throw new Error(`The confirmed source fact for ${anchor.id} is missing.`);
      const text = anchor.text.startsWith("Built ranking service for 1,200 users.")
        ? flow.layoutMode === "repair" ? (layoutRepair ? "Built ranking for 1,200 users." : "Built ranking service for 1,200 users Built ranking service for 1,200 users.")
          : flow.layoutMode === "exhaust" ? (layoutRepair ? retryIndex === 1 ? "Built ranking service for 1,200 users Built ranking." : "Built ranking service for 1,200 users Built ranking service." : "Built ranking service for 1,200 users Built ranking service for 1,200 users.")
            : "Built ranking for 1,200 users."
        : anchor.text.startsWith("Created accessibility scanner for 40 students.") ? "Created access scanner for 40 students."
          : anchor.text;
      return { anchorId: anchor.id, text, factIds: [fact.id] };
    });
    flow.editClaims = claims;
    return { claims };
  }
  if (name === "anchored_resume_grounding_audit") {
    const body = JSON.parse(request.input[1].content) as {
      claims: Array<{ claimId: string; factIds: string[] }>;
      sourceActivityPreservationChecks: Array<{ sourceClaimId: string }>;
    };
    return {
      findings: body.claims.map((claim) => ({ claimId: claim.claimId, outcome: "supported", reason: "The confirmed source fact supports this wording.", evidenceFactIds: claim.factIds, requiredInformation: null })),
      sourceActivityPreservations: body.sourceActivityPreservationChecks.map((check) => ({ sourceClaimId: check.sourceClaimId, outcome: "preserved", preservedClaimId: check.sourceClaimId,
        reason: "The same activity remains within its original employer or project entry.", requiredInformation: null })),
    };
  }
  if (name === "application_essay") {
    const body = JSON.parse(request.input[1].content) as { facts: Array<{ id: string; text: string }> };
    return { sentences: [{ text: "I am interested in this role.", kind: "perspective", factIds: [] }, { text: body.facts[0].text, kind: "fact", factIds: [body.facts[0].id] }] };
  }
  if (name === "essay_grounding_check") return { grounded: true, unsupportedClaims: [] };
  if (name === "browser_field_mapping") return { mappings: [] };
  throw new Error(`Unexpected model format: ${name}`);
}

type InputFile = { name: string; mimeType: string; buffer: Buffer };

class FixturePage {
  private targetUrl = "about:blank";
  private attachment?: InputFile;

  async goto(url: string) { this.targetUrl = url; }
  url() { return this.targetUrl; }
  context() { return { route: async () => undefined }; }
  async waitForFunction() { return undefined; }
  async waitForTimeout(duration: number) { await new Promise((resolve) => setTimeout(resolve, Math.min(duration, 100))); }
  async screenshot() { return Buffer.from("fixture screenshot"); }
  async title() { return "Application"; }
  locator(selector: string) { return new FixtureLocator(this, selector); }
  getByRole(role: string) { return new FixtureLocator(this, `role:${role}`); }

  fields() {
    const fileHashes = this.attachment ? [`${this.attachment.name}:${this.attachment.buffer.length}:${bytesHash(this.attachment.buffer)}`] : [];
    return [{ index: 0, label: "Resume upload", optionLabel: "Resume", autocomplete: false, kind: "file", required: true, checked: false,
      valid: Boolean(this.attachment), identifier: "resume", stableIdentifier: true, editable: true, fileHashes,
      value: this.attachment?.name ?? "", options: [] }];
  }

  acceptFile(file: InputFile) {
    const exact = { name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.buffer) };
    this.attachment = exact;
    flow.uploaded.push({ name: exact.name, mimeType: exact.mimeType, bytes: exact.buffer });
  }
}

class FixtureLocator {
  constructor(private readonly page: FixturePage, private readonly selector: string) {}
  first() { return this; }
  nth(index: number) { void index; return this; }
  async count() { return this.selector === "role:button" ? 1 : 0; }
  async isVisible() { return true; }
  async isEnabled() { return true; }
  async getAttribute(name: string) { return name === "accept" ? ".pdf,application/pdf" : null; }
  async setInputFiles(file: InputFile) { this.page.acceptFile(file); }
  async evaluateAll<T>(callback: (elements: unknown[]) => T) {
    if (this.selector !== "input, textarea, select") return callback([]);
    if (/\.join\(["']\|["']\)/.test(callback.toString())) return "INPUT:resume:resume:file" as T;
    return this.page.fields() as T;
  }
  async evaluate<T>(callback: (element: unknown) => T) {
    void callback;
    return { label: "Apply", identifier: "apply", action: undefined, method: "POST", encoding: "multipart/form-data" } as T;
  }
}

function fixtureBrowser(page: FixturePage) {
  return { contexts: () => [{ pages: () => [page] }], newPage: async () => page, close: async () => undefined };
}

beforeAll(async () => {
  await ensurePdfTestRuntime();
}, 150_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture"); vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("MODEL_USAGE_TEST_DIR", `/tmp/columns-flow-usage-${process.pid}`);
  flow.demo = true; flow.tasks = []; flow.uploaded = []; flow.editClaims = [];
  flow.layoutMode = "none"; flow.layoutRepairCount = 0;
  flow.state = initialDemoState();
  flow.state.profile.id = "columns-flow-owner";
  flow.state.applications = [];
  const page = new FixturePage();
  flow.browser = fixtureBrowser(page);
  flow.parse.mockImplementation(async (request: ModelRequest) => ({
    id: `fixture-${flow.parse.mock.calls.length}`, model: request.model, service_tier: "default", output_parsed: responseFor(request),
    usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
  }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(`/tmp/columns-flow-usage-${process.pid}`, { recursive: true, force: true });
  for (const app of flow.state?.applications ?? []) {
    await cancelBrowser(app).catch(() => undefined);
    await rm(`.data/screenshots/${app.id}.png`, { force: true });
    for (const file of app.packet?.files ?? []) if (file.storageKey) await rm(`.data/application-files/${file.storageKey}`, { force: true });
    const artifact = app.packet?.resumeArtifact as { baseline?: { storageKey: string }; source?: { storageKey: string }; tailored?: { storageKey: string } } | undefined;
    for (const file of [artifact?.baseline, artifact?.source, artifact?.tailored]) if (file?.storageKey) await rm(`.data/application-files/${file.storageKey}`, { force: true });
  }
  const originalKey = flow.state?.profile.resumeSource?.storageKey;
  if (originalKey) await rm(`.data/resumes/${originalKey}`, { force: true });
});

async function exerciseTwoColumnFlow(format: "pdf" | "docx", options: { layoutRepair?: boolean; exhaustRedraft?: boolean } = {}) {
  flow.layoutMode = options.layoutRepair ? "repair" : "none";
  if (format === "docx") {
    if (!sofficeRuntime) throw new Error("Set SOFFICE_BIN to the pinned LibreOffice runtime before running the DOCX source-flow fixture.");
    vi.stubEnv("SOFFICE_BIN", sofficeRuntime.binary);
    vi.stubEnv("DOCX_RENDERER_VERSION", sofficeRuntime.version);
  }
  const sourceBytes = format === "pdf" ? await createTwoColumnPdfFixture({ pages: 2 }) : await createTwoColumnDocxFixture({ pages: 2 });
  const mimeType = format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const form = new FormData();
  form.append("file", new File([new Uint8Array(sourceBytes)], `source.${format}`, { type: mimeType }));
  const upload = await uploadResume(new Request("https://apply.example/api/resume", { method: "POST", headers: { Origin: "https://apply.example" }, body: form }));
  expect(upload.status, await upload.clone().text()).toBe(200);
  const source = flow.state!.profile.resumeSourceDocument!;
  expect(source.support).toMatchObject({ status: "candidate" });
  expect(source.text).toContain("Orbit Labs — Search Engineer, 2023–2024");
  expect(source.text).toContain("Campus Access Checker");
  expect(source.text).toContain("Technical Skills");
  expect(source.text).toContain("Improved keyboard navigation coverage to 96%.");
  if (format === "pdf") expect((source as { layout: { columns: number; pageCount: number } }).layout).toMatchObject({ columns: 2, pageCount: 2 });
  else expect((source as { layout: { columns: number } }).layout.columns).toBe(2);

  const confirmedFacts = flow.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => ({ ...fact, verified: true }));
  const confirmed = await publicAction("onboarding", { facts: confirmedFacts });
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  expect(flow.state!.profile.facts.filter((fact) => fact.sourceAnchorId).every((fact) => fact.verified)).toBe(true);

  flow.demo = false;
  const selected = await publicAction("select", { jobId: flow.state!.jobs[0].id });
  expect(selected.status, await selected.clone().text()).toBe(200);
  const application = flow.state!.applications[0];
  const requested = await publicAction("draft", { applicationId: application.id });
  expect(requested.status, await requested.clone().text()).toBe(200);
  const draftTask = flow.tasks.find((item) => item.task === "draft-application-packet")!;
  await runDraft(draftTask.payload);
  expect(application.status).toBe("draft_review");
  expect(application.packet?.resumeArtifact).toMatchObject({ pageCount: 2, layoutValidation: { outcome: "passed" } });
  if (options.layoutRepair) expect(application.packet?.resumeSourcePlan?.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 });

  const file = (kind: string, query = "") => applicationFile(new Request(`https://apply.example/api/applications/${application.id}/files/${kind}${query}`), {
    params: Promise.resolve({ id: application.id, kind }),
  });
  const preview = await file("resume");
  const download = await file("resume", "?download=1");
  expect(preview.status).toBe(200);
  expect(download.status).toBe(200);
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  expect(previewBytes).toEqual(Buffer.from(await download.arrayBuffer()));
  expect(previewBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(preview.headers.get("content-disposition")).toContain("inline");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  const output = await parsePdfSource(previewBytes);
  expect(output.text).toContain("Orbit Labs — Search Engineer, 2023–2024");
  expect(output.text).toContain("Campus Access Checker");
  expect(output.text).toContain("Improved keyboard navigation coverage to 96%.");
  if (options.exhaustRedraft) {
    const previousPacket = structuredClone(application.packet!);
    const previousBytes = Buffer.from(previewBytes);
    flow.layoutMode = "exhaust";
    flow.layoutRepairCount = 0;
    const requestedRetry = await publicAction("draft", { applicationId: application.id, draftMode: "resume" });
    expect(requestedRetry.status, await requestedRetry.clone().text()).toBe(200);
    const retryTask = flow.tasks.filter((item) => item.task === "draft-application-packet").at(-1)!;
    await expect(runDraft(retryTask.payload)).rejects.toMatchObject({ diagnostics: { outcome: "technical_failure", technicalFailure: "renderer", writerAttempts: 3, checkerAttempts: 3, repairAttempts: 2, findings: [] } });
    expect(application.status).toBe("draft_review");
    expect(application.packet).toEqual(previousPacket);
    const retainedPreview = await file("resume");
    expect(Buffer.from(await retainedPreview.arrayBuffer())).toEqual(previousBytes);
    return;
  }
  const writerCall = flow.parse.mock.calls.find(([request]) => request.text.format.name === "anchored_resume_edit_plan")?.[0] as ModelRequest | undefined;
  expect(writerCall).toBeDefined();
  expect(writerCall!.input[1].content).toContain("regionId");
  expect(writerCall!.input[1].content).toContain("pageNumber");
  const writerInput = JSON.parse(writerCall!.input[1].content) as { sourceDocument: { anchors: Array<{
    id: string; text: string; entryId: string; entryHeading: string; regionId: string; pageNumber: number; readingOrder: number;
  }> } };
  const orbit = writerInput.sourceDocument.anchors.find((anchor) => anchor.text.includes("Built ranking service for 1,200 users."));
  const campus = writerInput.sourceDocument.anchors.find((anchor) => anchor.text.includes("Created accessibility scanner for 40 students."));
  const continuation = writerInput.sourceDocument.anchors.find((anchor) => anchor.text.includes("Improved keyboard navigation coverage to 96%."));
  const aster = writerInput.sourceDocument.anchors.find((anchor) => anchor.text.includes("Aster Systems — Software Intern, 2021–2022"));
  const languages = writerInput.sourceDocument.anchors.find((anchor) => anchor.text === "Languages");
  expect(orbit).toMatchObject({ pageNumber: 1, regionId: "page-1-column-1" });
  expect(campus).toMatchObject({ pageNumber: 1, regionId: "page-1-column-2" });
  expect(continuation).toMatchObject({ pageNumber: 2, regionId: "page-2-column-1" });
  expect(aster).toMatchObject({ pageNumber: 2, regionId: "page-2-column-1" });
  expect(orbit!.entryId).not.toBe(campus!.entryId);
  expect(continuation!.entryId).toBe(campus!.entryId);
  expect(continuation!.entryHeading).toBe("Campus Access Checker");
  expect(aster!.entryId).not.toBe(continuation!.entryId);
  expect(aster!.entryHeading).toBe("Aster Systems — Software Intern, 2021–2022");
  expect(languages).toMatchObject({ kind: "section", sectionHeading: "Languages", entryHeading: "Languages" });
  expect(orbit!.readingOrder).toBeLessThan(campus!.readingOrder);
  const sourceFacts = new Map(flow.state!.profile.facts.filter((fact) => fact.sourceAnchorId).map((fact) => [fact.id, fact.sourceAnchorId]));
  const confirmedContinuationFact = flow.state!.profile.facts.find((fact) => fact.sourceAnchorId === continuation!.id);
  expect(confirmedContinuationFact?.verified).toBe(true);
  expect(flow.editClaims.every((claim) => claim.factIds.every((id) => sourceFacts.get(id) === claim.anchorId))).toBe(true);

  const essayIndex = application.packet!.answers.findIndex((answer) => answer.aiDraft);
  expect(essayIndex).toBeGreaterThanOrEqual(0);
  const essay = application.packet!.answers[essayIndex];
  const essayConfirmed = await publicAction("confirmEssay", { applicationId: application.id, packetHash: application.packetHash, answerIndex: essayIndex, answerHash: essay.aiDraft!.contentHash });
  expect(essayConfirmed.status, await essayConfirmed.clone().text()).toBe(200);
  const approved = await publicAction("approveFill", { applicationId: application.id, packetHash: application.packetHash });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const started = await publicAction("startBrowser", { applicationId: application.id });
  expect(started.status, await started.clone().text()).toBe(200);
  const fillTask = flow.tasks.find((item) => item.task === "fill-application-form")!;
  await runFill(fillTask.payload);
  expect(flow.uploaded).toHaveLength(1);
  expect(flow.uploaded[0]).toMatchObject({ name: "tailored-resume.pdf", mimeType: "application/pdf" });
  expect(flow.uploaded[0].bytes).toEqual(previewBytes);
  expect(application.form?.fields[0].fileHashes).toEqual([`tailored-resume.pdf:${previewBytes.length}:${bytesHash(previewBytes)}`]);
  if (options.layoutRepair) return;

  const approvedSubmission = await publicAction("approveSubmit", { applicationId: application.id, formHash: application.form!.hash });
  expect(approvedSubmission.status, await approvedSubmission.clone().text()).toBe(200);
  const submit = await publicAction("submit", { applicationId: application.id });
  expect(submit.status, await submit.clone().text()).toBe(200);
  expect(application.status).toBe("submitting");
}

it("preserves employers, projects, columns and continuation through PDF upload, tailoring and exact attachment", async () => {
  await exerciseTwoColumnFlow("pdf");
}, 240_000);

it("repairs an overlong PDF edit through the public draft path within the shared 3/3/2 budget", async () => {
  await exerciseTwoColumnFlow("pdf", { layoutRepair: true });
}, 300_000);

it("blocks an edit after two layout repairs and retains the prior valid artifact", async () => {
  await exerciseTwoColumnFlow("pdf", { exhaustRedraft: true });
}, 300_000);

it.skipIf(!sofficeRuntime)("preserves employers, projects, columns and continuation through DOCX upload, tailoring and exact attachment", async () => {
  await exerciseTwoColumnFlow("docx");
}, 300_000);
