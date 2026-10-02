import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Browser, Locator, Page } from "playwright-core";
import { initialDemoState } from "@/lib/demo-data";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { parseDocxSource } from "@/lib/docx-source";
import { prepareDocxResumeBaseline } from "@/lib/docx-renderer";
import { packetProfileHash, validatePacket } from "@/lib/drafting";
import { withPacketFiles, reviewedPacketFile } from "@/lib/packet-files";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { sourceJobHash, sourceProfileHash } from "@/lib/resume-source-draft";
import { hashJson } from "@/lib/crypto";
import { bytesHash, saveArtifact } from "@/lib/resume-artifacts";
import { pdfSourceLayout, sourceLayoutHash } from "@/lib/resume-source-layout";
import { approveFill, selectApplication, setPacket } from "@/lib/workflow";
import { prepareBrowser } from "@/lib/browser-runner";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import type { Application, FormFieldSnapshot, ResumeSourcePlan } from "@/lib/types";

const transport = vi.hoisted(() => ({ launch: vi.fn(), uploaded: [] as Array<{ name: string; mimeType: string; buffer: Buffer }> }));
vi.mock("playwright-core", () => ({ chromium: { launch: transport.launch, connectOverCDP: vi.fn() } }));

const cleanupPaths: string[] = [];
let uploadedField: FormFieldSnapshot & { optionLabel: string; stableIdentifier: boolean; autocomplete: boolean };

function fakePage(application: Application) {
  uploadedField = { label: "Resume", identifier: "resume", kind: "file", value: "", required: false, checked: false, valid: true,
    options: [], fileHashes: [], editable: true, optionLabel: "Resume", stableIdentifier: true, autocomplete: false };
  let structureReads = 0;
  const inputLocator = {
    getAttribute: async (name: string) => name === "accept" ? "application/pdf" : null,
    setInputFiles: async (file: { name: string; mimeType: string; buffer: Buffer }) => {
      transport.uploaded.push({ ...file, buffer: Buffer.from(file.buffer) });
      uploadedField = { ...uploadedField, value: file.name, fileHashes: [`${file.name}:${file.buffer.length}:${bytesHash(file.buffer)}`] };
    },
    fill: vi.fn(),
    check: vi.fn(),
    selectOption: vi.fn(),
    setChecked: vi.fn(),
    isVisible: async () => true,
    isEnabled: async () => true,
    first() { return this; },
    nth() { return this; },
    count: async () => 0,
    evaluateAll: async () => [],
    evaluate: async () => undefined,
  };
  const locator = (selector: string) => ({
    evaluateAll: async () => {
      if (selector === "input, textarea, select") {
        if (structureReads++ < 6) return "input:resume:file";
        return [{ ...uploadedField, index: 0 }];
      }
      return [];
    },
    count: async () => 0,
    nth: () => inputLocator,
    first: () => inputLocator,
    getAttribute: inputLocator.getAttribute,
    setInputFiles: inputLocator.setInputFiles,
    isVisible: inputLocator.isVisible,
    isEnabled: inputLocator.isEnabled,
    evaluate: inputLocator.evaluate,
    fill: inputLocator.fill,
  });
  const submitButton = { count: async () => 0, first: () => inputLocator, nth: () => inputLocator, evaluateAll: async () => [], evaluate: async () => undefined };
  const context = { route: vi.fn(), pages: () => [page], newPage: async () => page };
  const page = {
    context: () => context,
    url: () => application.jobSnapshot!.applyUrl,
    goto: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    locator,
    getByRole: () => submitButton,
    screenshot: async () => Buffer.from("test screenshot"),
  };
  const browser = { newPage: async () => page, close: vi.fn().mockResolvedValue(undefined) };
  return { browser: browser as unknown as Browser, page: page as unknown as Page, inputLocator: inputLocator as unknown as Locator };
}

async function sourcePacket() {
  const state = initialDemoState();
  const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" };
  state.jobs = [job];
  const profile = state.profile;
  const originalBytes = await createPdfSourceFixture();
  const sourceKey = `${profile.id}/${randomUUID()}.pdf`;
  await saveDemoOriginalResume(sourceKey, originalBytes);
  cleanupPaths.push(`.data/resumes/${sourceKey}`);
  const source = await parsePdfSource(originalBytes);
  const facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    id: `browser-pdf-fact-${index}`, text: anchor.text, verified: true, source: "resume" as const, sourceAnchorId: anchor.id,
  }));
  profile.facts = facts;
  profile.resumeFileName = "source-resume.pdf";
  profile.resumeSource = { storageKey: sourceKey, sha256: bytesHash(originalBytes), size: originalBytes.length, mimeType: "application/pdf" };
  profile.resumeText = source.text;
  profile.resumeSourceDocument = source;
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({ anchorId: anchor.id, text: anchor.text,
    factIds: [facts.find((fact) => fact.sourceAnchorId === anchor.id)!.id] }));
  const bullet = source.anchors.find((anchor) => anchor.text === "Built a search index for 1,200 users.")!;
  const factId = facts.find((fact) => fact.sourceAnchorId === bullet.id)!.id;
  const editText = "Built search index for 1,200 users.";
  claims.find((claim) => claim.anchorId === bullet.id)!.text = editText;
  const sourceLayout = pdfSourceLayout(source)!;
  const plan: ResumeSourcePlan = { version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: sourceProfileHash(profile), factsHash: hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))),
    settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(job), sourceLayout, layoutHash: sourceLayoutHash(sourceLayout), claims,
    edits: [{ anchorId: bullet.id, text: editText, factIds: [factId] }],
    grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) },
    model: "fixture" };
  const packet = await withPacketFiles(profile, { schemaVersion: 3, version: 1, summary: "PDF browser upload", resumeMode: "tailored", resumeSourcePlan: plan,
    resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })), answers: [], createdAt: new Date().toISOString(), model: plan.model,
    profileHash: packetProfileHash(profile) });
  for (const file of packet.files ?? []) if (file.storageKey) cleanupPaths.push(`.data/application-files/${file.storageKey}`);
  if (packet.resumeArtifact?.format === "pdf") {
    cleanupPaths.push(`.data/application-files/${packet.resumeArtifact.baseline.storageKey}`, `.data/application-files/${packet.resumeArtifact.source.storageKey}`);
  }
  return { state, profile, job, originalBytes, packet };
}

async function legacyV1Packet() {
  const state = initialDemoState();
  const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" };
  state.jobs = [job];
  const profile = state.profile;
  const originalBytes = await createPdfSourceFixture();
  const sourceKey = `${profile.id}/${randomUUID()}.pdf`;
  await saveDemoOriginalResume(sourceKey, originalBytes);
  cleanupPaths.push(`.data/resumes/${sourceKey}`);
  const source = await parsePdfSource(originalBytes);
  source.version = 1;
  source.parser = "pdfjs-text-1";
  delete source.layout.pages;
  for (const anchor of source.anchors) {
    delete anchor.regionId;
    delete anchor.readingOrder;
  }
  const facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    id: `legacy-pdf-fact-${index}`, text: anchor.text, verified: true, source: "resume" as const, sourceAnchorId: anchor.id,
  }));
  profile.facts = facts;
  profile.resumeFileName = "source-resume.pdf";
  profile.resumeSource = { storageKey: sourceKey, sha256: bytesHash(originalBytes), size: originalBytes.length, mimeType: "application/pdf" };
  profile.resumeText = source.text;
  profile.resumeSourceDocument = source;
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({ anchorId: anchor.id, text: anchor.text,
    factIds: [facts.find((fact) => fact.sourceAnchorId === anchor.id)!.id] }));
  const factsHash = hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source: factSource, sourceAnchorId }) => ({ id, text, source: factSource, ...(sourceAnchorId ? { sourceAnchorId } : {}) })));
  const plan: ResumeSourcePlan = { version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: 1,
    profileHash: sourceProfileHash(profile), factsHash, settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(job), claims, edits: [],
    grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) },
    model: "legacy-v1-fixture" };
  const inputHash = hashJson({ kind: "source-preserving-pdf", sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
    profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: "pdf-single-column-one-page-v1", claims: plan.claims, edits: plan.edits, grounding: plan.grounding });
  const finalFile = await saveArtifact(profile.id, inputHash, originalBytes, "pdf");
  const sourceFile = await saveArtifact(profile.id, inputHash, originalBytes, "pdf");
  const baselineFile = await saveArtifact(profile.id, inputHash, originalBytes, "pdf");
  cleanupPaths.push(`.data/application-files/${finalFile.storageKey}`);
  const packet = {
    schemaVersion: 3 as const, version: 1, summary: "Legacy v1 PDF attachment", resumeMode: "tailored" as const, resumeSourcePlan: plan,
    resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })), answers: [], createdAt: new Date().toISOString(), model: plan.model,
    profileHash: packetProfileHash(profile), files: [{ kind: "resume" as const, filename: "tailored-resume.pdf", mimeType: "application/pdf" as const,
      ...finalFile, factIds: [...new Set(claims.flatMap((claim) => claim.factIds))] }],
    resumeArtifact: { format: "pdf" as const, inputHash, pageCount: 1, renderer: "apache-pdfbox" as const, rendererVersion: "3.0.8",
      javaVersion: "21.0.12.1+1-LTS", runtimeArchitecture: `${process.platform}-${process.arch}`, sourceHash: source.sourceHash, representationVersion: 1 as const,
      profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
      layoutPolicy: "pdf-single-column-one-page-v1" as const, layoutValidation: { outcome: "passed" as const, pageWidthPt: 612, pageHeightPt: 792,
        unchangedAnchorTolerancePt: 0.5 as const, pageSizeTolerancePt: 0.5 as const, visualMaskPaddingPt: 1.5 as const, visualOutsideEditTolerance: 0 as const,
        visualOutsideEditDifferenceAt144Dpi: 0 as const, visualOutsideEditDifferenceAt300Dpi: 0 as const, baselinePdfHash: bytesHash(originalBytes) },
      baseline: { ...baselineFile, mimeType: "application/pdf" as const }, source: { ...sourceFile, mimeType: "application/pdf" as const } },
  };
  return { state, profile, job, originalBytes, packet };
}

async function legacyDocxV1Packet() {
  const state = initialDemoState();
  const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" };
  state.jobs = [job];
  const profile = state.profile;
  const originalBytes = await createDocxSourceFixture();
  const sourceKey = `${profile.id}/${randomUUID()}.docx`;
  await saveDemoOriginalResume(sourceKey, originalBytes);
  cleanupPaths.push(`.data/resumes/${sourceKey}`);
  const source = await parseDocxSource(originalBytes);
  const facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    id: `legacy-docx-fact-${index}`, text: anchor.text, verified: true, source: "resume" as const, sourceAnchorId: anchor.id,
  }));
  profile.facts = facts;
  profile.resumeFileName = "source-resume.docx";
  profile.resumeSource = { storageKey: sourceKey, sha256: bytesHash(originalBytes), size: originalBytes.length,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  profile.resumeText = source.text;
  profile.resumeSourceDocument = source;
  const baseline = await prepareDocxResumeBaseline(originalBytes, source);
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({ anchorId: anchor.id, text: anchor.text,
    factIds: [facts.find((fact) => fact.sourceAnchorId === anchor.id)!.id] }));
  const factsHash = hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source: factSource, sourceAnchorId }) => ({ id, text, source: factSource, ...(sourceAnchorId ? { sourceAnchorId } : {}) })));
  const plan: ResumeSourcePlan = { version: 1, format: "docx", sourceHash: source.sourceHash, representationVersion: 1,
    profileHash: sourceProfileHash(profile), factsHash, settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(job), claims, edits: [],
    grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) },
    model: "legacy-v1-fixture" };
  const inputHash = hashJson({ kind: "source-preserving-docx", sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
    profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: "docx-single-column-one-page-v1", claims: plan.claims, edits: plan.edits, grounding: plan.grounding });
  const finalFile = await saveArtifact(profile.id, inputHash, baseline.baselinePdf, "pdf");
  const sourceFile = await saveArtifact(profile.id, inputHash, originalBytes, "docx");
  const baselineFile = await saveArtifact(profile.id, inputHash, baseline.baselinePdf, "pdf");
  cleanupPaths.push(`.data/application-files/${finalFile.storageKey}`, `.data/application-files/${sourceFile.storageKey}`);
  const rendererVersion = process.env.DOCX_RENDERER_VERSION ?? "26.8.0.3";
  const packet = {
    schemaVersion: 3 as const, version: 1, summary: "Legacy v1 DOCX attachment", resumeMode: "tailored" as const, resumeSourcePlan: plan,
    resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })), answers: [], createdAt: new Date().toISOString(), model: plan.model,
    profileHash: packetProfileHash(profile), files: [{ kind: "resume" as const, filename: "tailored-resume.pdf", mimeType: "application/pdf" as const,
      ...finalFile, storageBucket: "application-files" as const, factIds: [...new Set(claims.flatMap((claim) => claim.factIds))] }],
    resumeArtifact: { format: "docx" as const, inputHash, pageCount: 1, renderer: `libreoffice-${rendererVersion}`, rendererVersion: baseline.rendererVersion,
      sourceHash: source.sourceHash, representationVersion: 1 as const, profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash,
      jobHash: plan.jobHash, layoutPolicy: "docx-single-column-one-page-v1" as const,
      layoutValidation: { outcome: "passed" as const, pageWidthPt: 612, pageHeightPt: 792, unchangedAnchorTolerancePt: 1 as const,
        pageSizeTolerancePt: 0.5 as const, visualOutsideEditTolerance: 0.001 as const, visualOutsideEditDifference: 0,
        baselinePdfHash: bytesHash(baseline.baselinePdf) },
      baseline: { ...baselineFile, mimeType: "application/pdf" as const },
      source: { ...sourceFile, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const } },
  };
  return { state, profile, job, baselinePdf: baseline.baselinePdf, packet };
}

beforeAll(async () => {
  await ensurePdfTestRuntime();
  vi.stubEnv("DEMO_MODE", "true");
}, 150_000);

beforeEach(() => {
  transport.launch.mockReset();
  transport.uploaded = [];
});

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const file of cleanupPaths.splice(0)) await rm(file, { force: true });
}, 30_000);

it("passes the real source-aware browser guard and uploads the exact saved artifact bytes", async () => {
  transport.uploaded = [];
  const fixture = await sourcePacket();
  const app = selectApplication(fixture.state, fixture.job.id, fixture.profile.id);
  cleanupPaths.push(`.data/screenshots/${app.id}.png`);
  setPacket(fixture.state, app, fixture.packet);
  approveFill(app, fixture.profile.id, app.packetHash!, fixture.job.applyUrl);
  validatePacket(fixture.profile, app.packet!);
  const expected = await reviewedPacketFile(fixture.profile, app.packet!, "resume");
  const page = fakePage(app);
  transport.launch.mockResolvedValue(page.browser);

  const result = await prepareBrowser(app, fixture.job, fixture.profile);

  expect(result.sessionId).toBe(`local-${app.id}`);
  expect(transport.uploaded).toHaveLength(1);
  expect(transport.uploaded[0]).toMatchObject({ name: expected.filename, mimeType: expected.mimeType });
  expect(transport.uploaded[0].buffer).toEqual(expected.bytes);
  expect(uploadedField.fileHashes).toEqual([`${expected.filename}:${expected.bytes.length}:${bytesHash(expected.bytes)}`]);
  expect(transport.launch).toHaveBeenCalledOnce();
}, 180_000);

it("rejects a schema-3 packet without its current fill approval before opening browser transport", async () => {
  transport.uploaded = [];
  const fixture = await sourcePacket();
  const app = selectApplication(fixture.state, fixture.job.id, fixture.profile.id);
  cleanupPaths.push(`.data/screenshots/${app.id}.png`);
  setPacket(fixture.state, app, fixture.packet);
  app.status = "authorized_to_fill";
  const page = fakePage(app);
  transport.launch.mockResolvedValue(page.browser);

  await expect(prepareBrowser(app, fixture.job, fixture.profile)).rejects.toThrow(/requires fill approval/i);
  expect(transport.launch).not.toHaveBeenCalled();
  expect(transport.uploaded).toEqual([]);
}, 180_000);

it("keeps a valid legacy v1 source artifact readable and attaches its exact saved bytes under the 1.5pt policy", async () => {
  transport.uploaded = [];
  const fixture = await legacyV1Packet();
  const app = selectApplication(fixture.state, fixture.job.id, fixture.profile.id);
  cleanupPaths.push(`.data/screenshots/${app.id}.png`);
  setPacket(fixture.state, app, fixture.packet);
  approveFill(app, fixture.profile.id, app.packetHash!, fixture.job.applyUrl);
  validatePacket(fixture.profile, app.packet!);
  const expected = await reviewedPacketFile(fixture.profile, app.packet!, "resume");
  const page = fakePage(app);
  transport.launch.mockResolvedValue(page.browser);

  await prepareBrowser(app, fixture.job, fixture.profile);

  expect(app.packet?.resumeArtifact).toMatchObject({ format: "pdf", representationVersion: 1, layoutPolicy: "pdf-single-column-one-page-v1",
    layoutValidation: { visualMaskPaddingPt: 1.5 } });
  expect(expected.bytes).toEqual(fixture.originalBytes);
  expect(transport.uploaded).toHaveLength(1);
  expect(transport.uploaded[0].buffer).toEqual(expected.bytes);
  expect(uploadedField.fileHashes).toEqual([`${expected.filename}:${expected.bytes.length}:${bytesHash(expected.bytes)}`]);
}, 180_000);

it("keeps a legacy one-page DOCX artifact readable and attaches its exact saved bytes without new page-map metadata", async () => {
  transport.uploaded = [];
  const fixture = await legacyDocxV1Packet();
  const app = selectApplication(fixture.state, fixture.job.id, fixture.profile.id);
  cleanupPaths.push(`.data/screenshots/${app.id}.png`);
  setPacket(fixture.state, app, fixture.packet);
  approveFill(app, fixture.profile.id, app.packetHash!, fixture.job.applyUrl);
  validatePacket(fixture.profile, app.packet!);
  const expected = await reviewedPacketFile(fixture.profile, app.packet!, "resume");
  const page = fakePage(app);
  transport.launch.mockResolvedValue(page.browser);

  await prepareBrowser(app, fixture.job, fixture.profile);

  expect(app.packet?.resumeArtifact).toMatchObject({ format: "docx", representationVersion: 1, layoutPolicy: "docx-single-column-one-page-v1",
    layoutValidation: { outcome: "passed" } });
  expect(app.packet?.resumeSourcePlan?.sourceLayout).toBeUndefined();
  expect(app.packet?.resumeSourcePlan?.layoutHash).toBeUndefined();
  expect(expected.bytes).toEqual(fixture.baselinePdf);
  expect(transport.uploaded).toHaveLength(1);
  expect(transport.uploaded[0].buffer).toEqual(expected.bytes);
  expect(uploadedField.fileHashes).toEqual([`${expected.filename}:${expected.bytes.length}:${bytesHash(expected.bytes)}`]);
}, 180_000);
