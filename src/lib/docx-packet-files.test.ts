import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { initialDemoState } from "@/lib/demo-data";
import { parseDocxSource } from "@/lib/docx-source";
import { prepareDocxResumeBaseline } from "@/lib/docx-renderer";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { packetProfileHash, validatePacket } from "@/lib/drafting";
import { reviewedPacketFile, reviewedResumeSource, withPacketFiles } from "@/lib/packet-files";
import { sourceJobHash, sourceProfileHash } from "@/lib/resume-source-draft";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { hashJson } from "@/lib/crypto";
import { bytesHash } from "@/lib/resume-artifacts";
import { readArtifact } from "@/lib/resume-artifacts";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import { selectApplication } from "@/lib/workflow";
import { GET as getApplicationFile } from "@/app/api/applications/[id]/files/[kind]/route";
import type { ApplicationPacket, ResumeSourcePlan } from "@/lib/types";

const routeMocks = vi.hoisted(() => ({ userId: vi.fn(), loadState: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: routeMocks.userId, loadState: routeMocks.loadState }));

const cleanups: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => { vi.unstubAllEnvs(); for (const file of cleanups.splice(0)) await rm(file, { force: true }); });

function installedRenderer() {
  const candidates = [process.env.TEST_DOCX_SOFFICE_BIN, process.env.SOFFICE_BIN, process.platform === "linux" ? "/usr/bin/soffice" : undefined].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const output = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 8_000 }).trim().split("\n")[0];
      const match = output.match(/^(LibreOfficeDev|LibreOffice) (\S+)/);
      if (match) return { binary: candidate, version: match[2], output };
    } catch { /* An installed but unusable converter is not a usable fixture runtime. */ }
  }
  return undefined;
}
const renderer = installedRenderer();

async function sourcePacket(imported = false) {
  vi.stubEnv("DEMO_MODE", "true");
  if (renderer) {
    vi.stubEnv("DOCX_RENDERER_VERSION", renderer.version);
    vi.stubEnv("SOFFICE_BIN", renderer.binary);
  }
  const state = initialDemoState();
  const profile = state.profile;
  const job = state.jobs[0];
  const application = imported ? (() => {
    Object.assign(job, {
      source: "imported" as const,
      sourceId: "synthetic-imported-posting",
      sourceLabel: "Private synthetic posting",
      url: "https://example.invalid/synthetic-role",
      applyUrl: "https://example.invalid/synthetic-role",
      importUrl: "https://example.invalid/synthetic-role",
      description: "Synthetic description used only before verification.",
      requirements: ["synthetic requirement"],
      importCheck: undefined,
    });
    return selectApplication(state, job.id, profile.id);
  })() : undefined;
  const originalBytes = await createDocxSourceFixture();
  const originalKey = `${profile.id}/00000000-0000-4000-8000-000000000016.docx`;
  await saveDemoOriginalResume(originalKey, originalBytes);
  cleanups.push(`.data/resumes/${originalKey}`);
  const source = await parseDocxSource(originalBytes);
  const baseline = renderer ? await prepareDocxResumeBaseline(originalBytes, source, Date.now() + 90_000) : undefined;
  const sourceFacts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    id: `source-fact-${index}`, text: anchor.text, verified: true, source: "resume" as const, sourceAnchorId: anchor.id,
  }));
  profile.facts = sourceFacts;
  profile.resumeFileName = "source.docx";
  profile.resumeSource = { storageKey: originalKey, sha256: bytesHash(originalBytes), size: originalBytes.length,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  profile.resumeText = source.text;
  profile.resumeSourceDocument = source;
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({ anchorId: anchor.id, text: anchor.text,
    factIds: [sourceFacts.find((fact) => fact.sourceAnchorId === anchor.id)!.id] }));
  const bullet = source.anchors.find((anchor) => anchor.kind === "bullet")!;
  const editText = "Built recommender with 92% precision.";
  const editedClaim = claims.find((claim) => claim.anchorId === bullet.id)!;
  editedClaim.text = editText;
  const plan: ResumeSourcePlan = { version: 1, format: "docx", sourceHash: source.sourceHash, representationVersion: source.version,
    ...(baseline ? { sourceLayout: baseline.sourceLayout, layoutHash: baseline.layoutHash } : {}),
    profileHash: sourceProfileHash(profile), factsHash: hashJson(profile.facts.map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))), settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(application ? importedAutonomyJob(application, job) : job),
    claims, edits: [{ anchorId: bullet.id, text: editText, factIds: editedClaim.factIds }], grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported", reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) }, model: "gpt-6-sol" };
  const factsHash = hashJson(profile.facts.map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) })));
  plan.factsHash = factsHash;
  const packet: ApplicationPacket = { schemaVersion: 3, version: 1, summary: "Application fixture", resumeMode: "tailored", resumeSourcePlan: plan,
    resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })), answers: [], createdAt: new Date().toISOString(), model: plan.model,
    profileHash: packetProfileHash(profile) };
  return { profile, job, source, originalBytes, packet, plan, state, application };
}

it.skipIf(!renderer)("runs a real source-to-edited-DOCX-to-PDF fidelity check and serves those immutable packet bytes", async () => {
  const fixture = await sourcePacket();
  const packet = await withPacketFiles(fixture.profile, fixture.packet, Date.now() + 30_000);
  for (const file of packet.files ?? []) cleanups.push(`.data/application-files/${file.storageKey}`);
  if (packet.resumeArtifact?.format === "docx") cleanups.push(`.data/application-files/${packet.resumeArtifact.source.storageKey}`, `.data/application-files/${packet.resumeArtifact.baseline.storageKey}`);
  const preview = await reviewedPacketFile(fixture.profile, packet, "resume");
  const source = await reviewedResumeSource(fixture.profile, packet);
  validatePacket(fixture.profile, packet);

  expect(packet).toMatchObject({ schemaVersion: 3, resumeArtifact: { format: "docx", pageCount: 1, renderer: `libreoffice-${renderer!.version}`, layoutValidation: { outcome: "passed", pageWidthPt: 612, pageHeightPt: 792 } } });
  expect(packet.resumeArtifact?.format === "docx" ? packet.resumeArtifact.layoutValidation.visualOutsideEditDifference : 1).toBeLessThanOrEqual(0.001);
  expect(packet.resumeArtifact).toMatchObject({ baseline: { mimeType: "application/pdf", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(packet.resumeArtifact?.format).toBe("docx");
  if (packet.resumeArtifact?.format !== "docx") throw new Error("DOCX artifact metadata is missing.");
  const baseline = await readArtifact(fixture.profile.id, packet.resumeArtifact.baseline.storageKey, packet.resumeArtifact.baseline.sha256, packet.resumeArtifact.baseline.size);
  expect(baseline.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytesHash(baseline)).toBe(packet.resumeArtifact.baseline.sha256);
  expect(preview.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(preview.mimeType).toBe("application/pdf");
  expect(source.bytes.length).toBeGreaterThan(100);
  expect(source).toMatchObject({ filename: "tailored-resume.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const revisedSource = await parseDocxSource(source.bytes);
  expect(revisedSource.anchors.find((anchor) => anchor.kind === "bullet")?.text).toBe("Built recommender with 92% precision.");
  expect(await (await import("@/lib/original-resume")).readOriginalResume(fixture.profile.id, { ...fixture.profile.resumeSource!, filename: fixture.profile.resumeFileName! })).toEqual(fixture.originalBytes);
}, 150_000);

it.skipIf(!renderer)("serves a fresh imported-job DOCX comparison and blocks changed normalized inputs", async () => {
  const fixture = await sourcePacket(true);
  const packet = await withPacketFiles(fixture.profile, fixture.packet, Date.now() + 30_000);
  for (const file of packet.files ?? []) cleanups.push(`.data/application-files/${file.storageKey}`);
  if (packet.resumeArtifact?.format === "docx") cleanups.push(`.data/application-files/${packet.resumeArtifact.source.storageKey}`, `.data/application-files/${packet.resumeArtifact.baseline.storageKey}`);
  fixture.application!.packet = packet;
  routeMocks.userId.mockResolvedValue(fixture.profile.id);
  routeMocks.loadState.mockResolvedValue(fixture.state);

  const request = (kind: string) => getApplicationFile(new Request(`https://apply.example/api/applications/${fixture.application!.id}/files/${kind}`), {
    params: Promise.resolve({ id: fixture.application!.id, kind }),
  });
  const freshStatus = await request("resume-comparison-status");
  const originalSource = await request("resume-original");
  const tailoredSource = await request("resume-source");
  const baselinePreview = await request("resume-original-preview");
  const tailoredPreview = await request("resume-tailored-preview");
  const originalSourceBytes = Buffer.from(await originalSource.arrayBuffer());
  const tailoredSourceBytes = Buffer.from(await tailoredSource.arrayBuffer());
  const baselineBytes = Buffer.from(await baselinePreview.arrayBuffer());
  const tailoredBytes = Buffer.from(await tailoredPreview.arrayBuffer());

  expect(await freshStatus.json()).toMatchObject({ stale: false });
  expect(originalSource.status).toBe(200);
  expect(originalSourceBytes).toEqual(fixture.originalBytes);
  expect(originalSource.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(tailoredSource.status).toBe(200);
  expect(bytesHash(tailoredSourceBytes)).toBe(packet.resumeArtifact?.format === "docx" ? packet.resumeArtifact.source.sha256 : "");
  expect(baselinePreview.status).toBe(200);
  expect(tailoredPreview.status).toBe(200);
  expect(baselineBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(tailoredBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytesHash(baselineBytes)).toBe(packet.resumeArtifact?.format === "docx" ? packet.resumeArtifact.baseline.sha256 : "");
  expect(bytesHash(tailoredBytes)).toBe(packet.files?.find((file) => file.kind === "resume")?.sha256);

  const originalPacket = structuredClone(fixture.application!.packet);
  const originalTitle = fixture.job.title;
  fixture.job.title = "Changed synthetic role title";
  const changedTitle = await request("resume-comparison-status");
  const changedTitlePreview = await request("resume-tailored-preview");
  expect(await changedTitle.json()).toMatchObject({ stale: true, staleReasons: ["job"] });
  expect(changedTitlePreview.status).toBe(409);
  expect(fixture.application!.packet).toEqual(originalPacket);

  fixture.job.title = originalTitle;
  fixture.job.url = "https://boards.greenhouse.io/synthetic/jobs/123";
  fixture.job.applyUrl = fixture.job.url;
  fixture.job.importUrl = fixture.job.url;
  fixture.job.importCheck = { status: "verified", checkedAt: "2026-10-01T00:00:00.000Z" };
  const changedTrust = await request("resume-comparison-status");
  const changedTrustPreview = await request("resume-tailored-preview");
  expect(await changedTrust.json()).toMatchObject({ stale: true, staleReasons: ["job"] });
  expect(changedTrustPreview.status).toBe(409);
  expect(fixture.application!.packet).toEqual(originalPacket);
}, 150_000);

it("rejects stale confirmed source facts before creating a reviewed artifact", async () => {
  const fixture = await sourcePacket();
  fixture.profile.facts[0].text += " changed";
  await expect(withPacketFiles(fixture.profile, fixture.packet, Date.now() + 30_000)).rejects.toThrow(/stale|confirmed facts/i);
}, 150_000);
