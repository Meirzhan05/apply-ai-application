import { beforeAll, describe, expect, it } from "vitest";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { renderPdfSourceBytes } from "@/lib/pdf-renderer";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import { bytesHash } from "@/lib/resume-artifacts";
import type { PdfSourceRepresentation, ResumeSourcePlan } from "@/lib/types";

function planFor(source: PdfSourceRepresentation, edit?: { anchorId: string; text: string }): ResumeSourcePlan {
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    anchorId: anchor.id, text: anchor.id === edit?.anchorId ? edit.text : anchor.text, factIds: [`synthetic-fact-${index}`],
  }));
  const editedClaim = claims.find((claim) => claim.anchorId === edit?.anchorId);
  return {
    version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: "a".repeat(64), factsHash: "b".repeat(64), settingsHash: "c".repeat(64), jobHash: "d".repeat(64), claims,
    edits: edit && editedClaim ? [{ anchorId: edit.anchorId, text: edit.text, factIds: editedClaim.factIds }] : [],
    grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: claims.map((claim) => ({ claimId: claim.anchorId,
      affectedText: claim.text, outcome: "supported", reason: "Synthetic confirmed fact.", evidenceFactIds: claim.factIds })) }, model: "synthetic-smoke",
  };
}

describe("PDFBox source-preserving renderer", () => {
  beforeAll(async () => {
    await ensurePdfTestRuntime();
  }, 150_000);

  it("replaces a grounded source bullet and renders identical pixels outside its measured edit mask", async () => {
    const sourceBytes = await createPdfSourceFixture();
    const source = await parsePdfSource(sourceBytes);
    const anchor = source.anchors.find((item) => item.text === "Built a search index for 1,200 users.");
    expect(source.support.status).toBe("candidate");
    expect(anchor?.editable).toBe(true);
    const plan = planFor(source, { anchorId: anchor!.id, text: "Built index for 1,200 users." });

    const rendered = await renderPdfSourceBytes(sourceBytes, source, plan, Date.now() + 90_000);

    expect(rendered).toMatchObject({ renderer: "apache-pdfbox", rendererVersion: "3.0.8", pageWidthPt: 612, pageHeightPt: 792,
      visualOutsideEditDifferenceAt144Dpi: 0, visualOutsideEditDifferenceAt300Dpi: 0 });
    expect(rendered.baselinePdf).toEqual(sourceBytes);
    expect(rendered.sourcePdf).toEqual(sourceBytes);
    expect(rendered.baselinePdfHash).toBe(bytesHash(sourceBytes));
    expect(bytesHash(rendered.pdf)).not.toBe(bytesHash(sourceBytes));
  }, 120_000);

  it("fails with a specific blocker when a source font cannot encode an edited glyph", async () => {
    const sourceBytes = await createPdfSourceFixture();
    const source = await parsePdfSource(sourceBytes);
    const anchor = source.anchors.find((item) => item.text === "Built a search index for 1,200 users.")!;
    const plan = planFor(source, { anchorId: anchor.id, text: "Built a 🪐 search index for 1,200 users." });

    await expect(renderPdfSourceBytes(sourceBytes, source, plan, Date.now() + 90_000)).rejects.toThrow(/glyph|font/i);
  }, 120_000);

  it("rejects a replacement wider than the existing source text box", async () => {
    const sourceBytes = await createPdfSourceFixture();
    const source = await parsePdfSource(sourceBytes);
    const anchor = source.anchors.find((item) => item.text === "Built a search index for 1,200 users.")!;
    const plan = planFor(source, { anchorId: anchor.id, text: "Built a search index for 1,200 users. ".repeat(10).trim() });

    await expect(renderPdfSourceBytes(sourceBytes, source, plan, Date.now() + 90_000)).rejects.toThrow(/width|longer/i);
  }, 120_000);
});
