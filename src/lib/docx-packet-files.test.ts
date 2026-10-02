import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { initialDemoState } from "@/lib/demo-data";
import { parseDocxSource } from "@/lib/docx-source";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { packetProfileHash, validatePacket } from "@/lib/drafting";
import { reviewedPacketFile, reviewedResumeSource, withPacketFiles } from "@/lib/packet-files";
import { sourceJobHash, sourceProfileHash } from "@/lib/resume-source-draft";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { hashJson } from "@/lib/crypto";
import { bytesHash } from "@/lib/resume-artifacts";
import { readArtifact } from "@/lib/resume-artifacts";
import type { ApplicationPacket, ResumeSourcePlan } from "@/lib/types";

const cleanups: string[] = [];
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

async function sourcePacket() {
  vi.stubEnv("DEMO_MODE", "true");
  if (renderer) {
    vi.stubEnv("DOCX_RENDERER_VERSION", renderer.version);
    vi.stubEnv("SOFFICE_BIN", renderer.binary);
  }
  const state = initialDemoState();
  const profile = state.profile;
  const job = state.jobs[0];
  const originalBytes = await createDocxSourceFixture();
  const originalKey = `${profile.id}/00000000-0000-4000-8000-000000000016.docx`;
  await saveDemoOriginalResume(originalKey, originalBytes);
  cleanups.push(`.data/resumes/${originalKey}`);
  const source = await parseDocxSource(originalBytes);
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
  const editText = "Built an explainable recommender with 92% precision.";
  const editedClaim = claims.find((claim) => claim.anchorId === bullet.id)!;
  editedClaim.text = editText;
  const plan: ResumeSourcePlan = { version: 1, format: "docx", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: sourceProfileHash(profile), factsHash: hashJson(profile.facts.map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))), settingsHash: hashJson(profile.automationSettings ?? null), jobHash: sourceJobHash(job),
    claims, edits: [{ anchorId: bullet.id, text: editText, factIds: editedClaim.factIds }], grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported", reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) }, model: "gpt-6-sol" };
  const factsHash = hashJson(profile.facts.map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) })));
  plan.factsHash = factsHash;
  const packet: ApplicationPacket = { schemaVersion: 3, version: 1, summary: "Application fixture", resumeMode: "tailored", resumeSourcePlan: plan,
    resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })), answers: [], createdAt: new Date().toISOString(), model: plan.model,
    profileHash: packetProfileHash(profile) };
  return { profile, job, source, originalBytes, packet, plan };
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
  expect(revisedSource.anchors.find((anchor) => anchor.kind === "bullet")?.text).toBe("Built an explainable recommender with 92% precision.");
  expect(await (await import("@/lib/original-resume")).readOriginalResume(fixture.profile.id, { ...fixture.profile.resumeSource!, filename: fixture.profile.resumeFileName! })).toEqual(fixture.originalBytes);
});

it("rejects stale confirmed source facts before creating a reviewed artifact", async () => {
  const fixture = await sourcePacket();
  fixture.profile.facts[0].text += " changed";
  await expect(withPacketFiles(fixture.profile, fixture.packet, Date.now() + 30_000)).rejects.toThrow(/stale|confirmed facts/i);
});
