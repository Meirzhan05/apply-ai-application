import { hashJson } from "@/lib/crypto";
import type { PdfSourceRepresentation, ResumeSourceLayoutMap } from "@/lib/types";

export function pdfSourceLayout(source: PdfSourceRepresentation): ResumeSourceLayoutMap | undefined {
  if (source.version !== 2 && source.version !== 3) return undefined;
  const pages = source.layout.pages;
  if (!pages || pages.length !== source.layout.pageCount) throw new Error("The inspected PDF is missing its complete page and region map. Re-upload the original before drafting.");
  const anchors = source.anchors.map((anchor) => {
    if (!anchor.pageNumber || !anchor.regionId || anchor.readingOrder === undefined) throw new Error("The inspected PDF has an unmapped source anchor. Re-upload the original before drafting.");
    return { anchorId: anchor.id, pageNumber: anchor.pageNumber, regionId: anchor.regionId, readingOrder: anchor.readingOrder, boundsPt: anchor.boundsPt };
  });
  if (pages.some((page, index) => page.pageNumber !== index + 1 || page.rotation !== 0 || page.regions.length === 0))
    throw new Error("The inspected PDF has an incomplete page or region map. Re-upload the original before drafting.");
  return { version: 1, pages, anchors };
}

export function sourceLayoutHash(layout: ResumeSourceLayoutMap): string { return hashJson(layout); }
