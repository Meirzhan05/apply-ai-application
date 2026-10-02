import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { initialDemoState } from "@/lib/demo-data";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { packetProfileHash } from "@/lib/drafting";
import { reviewedPacketFile, reviewedResumeComparisonFiles, reviewedResumeSource, withPacketFiles } from "@/lib/packet-files";
import { sourceJobHash, sourceProfileHash } from "@/lib/resume-source-draft";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { hashJson } from "@/lib/crypto";
import { bytesHash, readArtifact } from "@/lib/resume-artifacts";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import type { ApplicationPacket, ResumeSourcePlan } from "@/lib/types";

const cleanups: string[] = [];

beforeAll(async () => {
  await ensurePdfTestRuntime();
  vi.stubEnv("DEMO_MODE", "true");
}, 150_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  for (const file of cleanups.splice(0)) await rm(file, { force: true });
}, 30_000);

async function pdfPacket() {
  const state = initialDemoState();
  const profile = state.profile;
  const job = state.jobs[0];
  const originalBytes = await createPdfSourceFixture();
  const originalKey = `${profile.id}/${randomUUID()}.pdf`;
  await saveDemoOriginalResume(originalKey, originalBytes);
  cleanups.push(`.data/resumes/${originalKey}`);
  const source = await parsePdfSource(originalBytes);
  const sourceFacts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    id: `pdf-source-fact-${index}`, text: anchor.text, verified: true, source: "resume" as const, sourceAnchorId: anchor.id,
  }));
  profile.facts = sourceFacts;
  profile.resumeFileName = "source-resume.pdf";
  profile.resumeSource = { storageKey: originalKey, sha256: bytesHash(originalBytes), size: originalBytes.length, mimeType: "application/pdf" };
  profile.resumeText = source.text;
  profile.resumeSourceDocument = source;
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => ({ anchorId: anchor.id, text: anchor.text,
    factIds: [sourceFacts.find((fact) => fact.sourceAnchorId === anchor.id)!.id] }));
  const bullet = source.anchors.find((anchor) => anchor.text === "Built a search index for 1,200 users.")!;
  const revisedText = "Built search index for 1,200 users.";
  const editedClaim = claims.find((claim) => claim.anchorId === bullet.id)!;
  editedClaim.text = revisedText;
  const factsHash = hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) })));
  const plan: ResumeSourcePlan = { version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: sourceProfileHash(profile), factsHash, settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(job),
    claims, edits: [{ anchorId: bullet.id, text: revisedText, factIds: editedClaim.factIds }],
    grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) },
    model: "gpt-6-sol" };
  const packet: ApplicationPacket = { schemaVersion: 3, version: 1, summary: "PDF application fixture", resumeMode: "tailored", resumeSourcePlan: plan,
    resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })), answers: [], createdAt: new Date().toISOString(), model: plan.model,
    profileHash: packetProfileHash(profile) };
  return { profile, source, originalBytes, packet, bullet, revisedText };
}

it("saves, previews, downloads, and compares the exact PDFBox artifact and baseline bytes", async () => {
  const fixture = await pdfPacket();
  const packet = await withPacketFiles(fixture.profile, fixture.packet, Date.now() + 90_000);
  for (const file of packet.files ?? []) cleanups.push(`.data/application-files/${file.storageKey}`);
  if (packet.resumeArtifact?.format === "pdf") cleanups.push(`.data/application-files/${packet.resumeArtifact.baseline.storageKey}`, `.data/application-files/${packet.resumeArtifact.source.storageKey}`);

  expect(packet).toMatchObject({ schemaVersion: 3, resumeArtifact: { format: "pdf", pageCount: 1, renderer: "apache-pdfbox", rendererVersion: "3.0.8",
    layoutPolicy: "pdf-single-column-one-page-v1", layoutValidation: { outcome: "passed", pageWidthPt: 612, pageHeightPt: 792,
      visualOutsideEditDifferenceAt144Dpi: 0, visualOutsideEditDifferenceAt300Dpi: 0 } } });
  if (packet.resumeArtifact?.format !== "pdf") throw new Error("The PDF résumé artifact metadata is missing.");
  const finalFile = packet.files!.find((file) => file.kind === "resume")!;
  const preview = await reviewedPacketFile(fixture.profile, packet, "resume");
  const source = await reviewedResumeSource(fixture.profile, packet);
  const comparison = await reviewedResumeComparisonFiles(fixture.profile, packet);
  const finalSaved = await readArtifact(fixture.profile.id, finalFile.storageKey!, finalFile.sha256, finalFile.size);

  expect(preview).toMatchObject({ filename: "tailored-resume.pdf", mimeType: "application/pdf" });
  expect(preview.bytes).toEqual(finalSaved);
  expect(source).toMatchObject({ filename: "original-source.pdf", mimeType: "application/pdf" });
  expect(source.bytes).toEqual(fixture.originalBytes);
  expect(comparison).toMatchObject({ stale: false, baseline: { filename: "original-layout-preview.pdf" }, tailored: { filename: "tailored-resume.pdf" } });
  expect(comparison.baseline.bytes).toEqual(fixture.originalBytes);
  expect(comparison.tailored.bytes).toEqual(finalSaved);
  const tailoredText = (await parsePdfSource(preview.bytes)).text;
  expect(tailoredText).toContain(fixture.revisedText);
  expect(tailoredText).not.toContain(fixture.bullet.text);

  const revision = await withPacketFiles(fixture.profile, { ...packet, version: 2, coverLetter: "A separate letter revision." }, Date.now() + 90_000);
  expect(revision.files?.find((file) => file.kind === "resume")?.sha256).toBe(finalFile.sha256);
}, 150_000);

it("blocks newly enabled tailoring when the confirmed PDF representation is absent", async () => {
  const fixture = await pdfPacket();
  fixture.profile.resumeSourceDocument = undefined;
  await expect(withPacketFiles(fixture.profile, fixture.packet)).rejects.toThrow(/inspected PDF source|re-upload|source plan/i);
});

it("retains owner-scoped PDF comparison bytes and labels them stale after confirmed facts change", async () => {
  const fixture = await pdfPacket();
  const packet = await withPacketFiles(fixture.profile, fixture.packet, Date.now() + 90_000);
  for (const file of packet.files ?? []) cleanups.push(`.data/application-files/${file.storageKey}`);
  if (packet.resumeArtifact?.format !== "pdf") throw new Error("The PDF résumé artifact metadata is missing.");
  cleanups.push(`.data/application-files/${packet.resumeArtifact.baseline.storageKey}`, `.data/application-files/${packet.resumeArtifact.source.storageKey}`);
  const artifact = packet.resumeArtifact;
  const finalFile = packet.files!.find((file) => file.kind === "resume")!;
  const finalBeforeChange = await readArtifact(fixture.profile.id, finalFile.storageKey!, finalFile.sha256, finalFile.size);
  fixture.profile.facts[0].text += " revised confirmation";

  const comparison = await reviewedResumeComparisonFiles(fixture.profile, packet);

  expect(comparison).toMatchObject({ stale: true, staleReasons: expect.arrayContaining(["facts", "profile"]) });
  expect(comparison.baseline.bytes).toEqual(fixture.originalBytes);
  expect(comparison.tailored.bytes).toEqual(finalBeforeChange);
  await expect(reviewedPacketFile(fixture.profile, packet, "resume")).rejects.toThrow(/stale|does not match/i);
  expect(artifact.baseline.sha256).toBe(bytesHash(comparison.baseline.bytes));
});
