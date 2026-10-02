import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Browser, Locator, Page } from "playwright-core";
import { initialDemoState } from "@/lib/demo-data";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { packetProfileHash, validatePacket } from "@/lib/drafting";
import { withPacketFiles, reviewedPacketFile } from "@/lib/packet-files";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { sourceJobHash, sourceProfileHash } from "@/lib/resume-source-draft";
import { hashJson } from "@/lib/crypto";
import { bytesHash } from "@/lib/resume-artifacts";
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
  const plan: ResumeSourcePlan = { version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: sourceProfileHash(profile), factsHash: hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))),
    settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(job), claims,
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
