import { beforeAll, describe, expect, it } from "vitest";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { createPdfMultiPageFixture } from "@/lib/fixtures/pdf-multi-page";
import { parsePdfSource } from "@/lib/pdf-source";
import { renderPdfSourceBytes } from "@/lib/pdf-renderer";
import { ResumeLayoutFeedbackError } from "@/lib/resume-layout-feedback";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import { bytesHash } from "@/lib/resume-artifacts";
import { pdfSourceLayout, sourceLayoutHash } from "@/lib/resume-source-layout";
import type { PdfSourceRepresentation, ResumeSourcePlan } from "@/lib/types";

function planFor(source: PdfSourceRepresentation, edit?: { anchorId: string; text: string }): ResumeSourcePlan {
  const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({
    anchorId: anchor.id, text: anchor.id === edit?.anchorId ? edit.text : anchor.text, factIds: [`synthetic-fact-${index}`],
  }));
  const editedClaim = claims.find((claim) => claim.anchorId === edit?.anchorId);
  const sourceLayout = pdfSourceLayout(source);
  return {
    version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: source.version,
    profileHash: "a".repeat(64), factsHash: "b".repeat(64), settingsHash: "c".repeat(64), jobHash: "d".repeat(64), claims,
    edits: edit && editedClaim ? [{ anchorId: edit.anchorId, text: edit.text, factIds: editedClaim.factIds }] : [],
    ...(sourceLayout ? { sourceLayout, layoutHash: sourceLayoutHash(sourceLayout) } : {}),
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

  it("keeps a separate list marker immutable while replacing its same-column body text", async () => {
    const sourceBytes = await createPdfSourceFixture({ separateBulletMarker: "same-column" });
    const source = await parsePdfSource(sourceBytes);
    const anchor = source.anchors.find((item) => item.text === "Built a search index for 1,200 users.");
    expect(anchor).toMatchObject({ kind: "bullet", editable: true, bulletPrefix: "" });
    const plan = planFor(source, { anchorId: anchor!.id, text: "Built search index for 1,200 users." });

    const rendered = await renderPdfSourceBytes(sourceBytes, source, plan, Date.now() + 90_000);
    const reparsed = await parsePdfSource(rendered.pdf);

    expect(rendered.visualOutsideEditDifferenceAt144Dpi).toBe(0);
    expect(rendered.visualOutsideEditDifferenceAt300Dpi).toBe(0);
    expect(reparsed.text).toContain("• Built search index for 1,200 users.");
    expect(reparsed.text).not.toContain("Built a search index for 1,200 users.");
    expect(reparsed.anchors.filter((item) => item.text === "Built search index for 1,200 users.")).toHaveLength(1);
  }, 120_000);

  it("rewrites a continued bullet on page two and preserves page count, page geometry, and repeated furniture", async () => {
    const sourceBytes = await createPdfMultiPageFixture();
    const source = await parsePdfSource(sourceBytes);
    const continuedBullet = source.anchors.find((item) => item.text === "Improved retrieval speed by 22%.");
    expect(source.support.status).toBe("candidate");
    expect(source.layout.pages).toHaveLength(2);
    expect(continuedBullet).toMatchObject({ pageNumber: 2, candidateClaim: true, editable: true });
    const plan = planFor(source, { anchorId: continuedBullet!.id, text: "Improved retrieval speed 22%." });

    const rendered = await renderPdfSourceBytes(sourceBytes, source, plan, Date.now() + 90_000);
    const reparsed = await parsePdfSource(rendered.pdf);

    expect(rendered.pages).toHaveLength(2);
    expect(rendered.pages.map(({ pageNumber, widthPt, heightPt }) => ({ pageNumber, widthPt, heightPt }))).toEqual(source.layout.pages!.map((page) => ({
      pageNumber: page.pageNumber, widthPt: page.widthPt, heightPt: page.heightPt,
    })));
    expect(rendered.pages.every((page) => page.visualOutsideEditDifferenceAt144Dpi === 0 && page.visualOutsideEditDifferenceAt300Dpi === 0)).toBe(true);
    expect(reparsed.anchors.find((item) => item.text === "Improved retrieval speed 22%.")).toMatchObject({ pageNumber: 2 });
    expect(reparsed.anchors.filter((item) => item.text === "Avery Chen | Résumé")).toHaveLength(2);
    expect(reparsed.anchors.filter((item) => item.text === "Avery Chen · Confidential")).toHaveLength(2);
    expect(reparsed.text).not.toContain("Improved retrieval speed by 22%.");
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

    const failure = await renderPdfSourceBytes(sourceBytes, source, plan, Date.now() + 90_000).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResumeLayoutFeedbackError);
    expect(failure).toMatchObject({ feedback: { anchorId: anchor.id, pageNumber: 1, regionId: anchor.regionId } });
  }, 120_000);
});
