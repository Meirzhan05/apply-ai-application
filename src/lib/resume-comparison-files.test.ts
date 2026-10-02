import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readArtifact: vi.fn() }));
vi.mock("@/lib/resume-artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resume-artifacts")>();
  return { ...actual, readArtifact: mocks.readArtifact };
});

import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parseDocxSource } from "@/lib/docx-source";
import { hashJson } from "@/lib/crypto";
import type { ApplicationPacket, DocxResumeArtifact, ResumeSourcePlan } from "@/lib/types";
import { reviewedResumeComparisonFiles } from "@/lib/packet-files";

const baselineBytes = Buffer.from("%PDF-checked baseline preview");
const tailoredBytes = Buffer.from("%PDF-checked tailored output");

async function fixture() {
  const profile = structuredClone(initialDemoState().profile);
  const sourceBytes = await createDocxSourceFixture();
  const source = await parseDocxSource(sourceBytes);
  const jobHash = "e".repeat(64);
  const plan: ResumeSourcePlan = {
    version: 1, format: "docx", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: "b".repeat(64), factsHash: "c".repeat(64), settingsHash: "d".repeat(64), jobHash,
    claims: [], edits: [], grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: [] }, model: "fixture",
  };
  const inputHash = hashJson({ kind: "source-preserving-docx", sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
    profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: "docx-single-column-one-page-v1", claims: plan.claims, edits: plan.edits, grounding: plan.grounding });
  const baselineHash = "1".repeat(64);
  const tailoredHash = "2".repeat(64);
  const sourceHash = "3".repeat(64);
  const artifact: DocxResumeArtifact = {
    format: "docx", inputHash, pageCount: 1, renderer: "libreoffice-26.8.0.3", rendererVersion: "LibreOffice 26.8.0.3",
    sourceHash: plan.sourceHash, representationVersion: source.version, profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash,
    jobHash: plan.jobHash, layoutPolicy: "docx-single-column-one-page-v1",
    layoutValidation: { outcome: "passed", pageWidthPt: 612, pageHeightPt: 792, unchangedAnchorTolerancePt: 1, pageSizeTolerancePt: 0.5,
      visualOutsideEditTolerance: 0.001, visualOutsideEditDifference: 0, baselinePdfHash: baselineHash },
    baseline: { storageKey: `${profile.id}/${inputHash}/${baselineHash}.pdf`, sha256: baselineHash, size: baselineBytes.length, mimeType: "application/pdf" },
    source: { storageKey: `${profile.id}/${inputHash}/${sourceHash}.docx`, sha256: sourceHash, size: 512, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  };
  const packet: ApplicationPacket = {
    schemaVersion: 3, version: 1, summary: "Fixture", resumeMode: "tailored", resumeLines: [], resumeSourcePlan: plan, resumeArtifact: artifact,
    files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", size: tailoredBytes.length, sha256: tailoredHash,
      storageKey: `${profile.id}/${inputHash}/${tailoredHash}.pdf`, factIds: [] }],
    answers: [], createdAt: "2026-10-01T00:00:00.000Z", model: "fixture",
  };
  profile.resumeFileName = "original-riley.docx";
  profile.resumeSource = { storageKey: `${profile.id}/00000000-0000-4000-8000-000000000001.docx`, sha256: source.sourceHash, size: sourceBytes.length,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  profile.resumeSourceDocument = source;
  mocks.readArtifact.mockImplementation(async (_owner: string, key: string) => key === artifact.baseline.storageKey ? baselineBytes : tailoredBytes);
  return { profile, packet, artifact };
}

beforeEach(() => vi.clearAllMocks());

describe("reviewed résumé comparison files", () => {
  it("serves both stored PDFs after inputs change and reports why the saved version is stale", async () => {
    const { profile, packet, artifact } = await fixture();
    const result = await reviewedResumeComparisonFiles(profile, packet);

    expect(result).toMatchObject({ stale: true, staleReasons: expect.arrayContaining(["profile", "facts", "settings"]) });
    expect(result.baseline).toEqual({ bytes: baselineBytes, filename: "original-layout-preview.pdf", mimeType: "application/pdf" });
    expect(result.tailored).toEqual({ bytes: tailoredBytes, filename: "tailored-resume.pdf", mimeType: "application/pdf" });
    expect(mocks.readArtifact).toHaveBeenNthCalledWith(1, profile.id, artifact.baseline.storageKey, artifact.baseline.sha256, artifact.baseline.size);
    expect(mocks.readArtifact).toHaveBeenNthCalledWith(2, profile.id, packet.files?.[0].storageKey, packet.files?.[0].sha256, packet.files?.[0].size);
  });

  it("rejects a baseline whose saved hash disagrees with the artifact layout record", async () => {
    const { profile, packet, artifact } = await fixture();
    artifact.baseline.sha256 = "9".repeat(64);

    await expect(reviewedResumeComparisonFiles(profile, packet)).rejects.toThrow(/baseline|layout/i);
    expect(mocks.readArtifact).not.toHaveBeenCalled();
  });
});
