import type { DocxSourceAnchor, DocxSourceRepresentation, PdfSourceAnchor, PdfSourceRepresentation } from "@/lib/types";

export interface DocxBaselinePageLayout {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  marginsPt?: { top: number; right: number; bottom: number; left: number };
  regions: Array<{
    id: string;
    pageIndex: number;
    columnId: string;
    bounds: { left: number; top: number; right: number; bottom: number };
    readingOrder: number;
  }>;
}

export interface DocxBaselineAnchorLayout {
  anchorId: string;
  pageNumber: number;
  regionId: string;
  readingOrder: number;
  boundsPt: { left: number; top: number; right: number; bottom: number };
}

/** Structurally identical to ResumeSourceLayoutMap; local so this adapter can be tested independently. */
export interface DocxSourceLayoutMap {
  version: 1;
  pages: DocxBaselinePageLayout[];
  anchors: DocxBaselineAnchorLayout[];
}

export type DocxSourceLayoutResult =
  | { status: "supported"; layout: DocxSourceLayoutMap }
  | { status: "blocked"; reason: string };

type PdfAnchorWithPosition = PdfSourceAnchor & { regionId: string; readingOrder: number; repeatedRole?: "header" | "footer" };
type Region = DocxBaselinePageLayout["regions"][number];

function blocked(reason: string): DocxSourceLayoutResult { return { status: "blocked", reason }; }
function normalized(text: string): string { return text.normalize("NFKC").replace(/[\u00a0\u200b\u200c\u200d]/g, " ").replace(/\s+/g, " ").trim(); }
function finiteBounds(value: unknown): value is { left: number; top: number; right: number; bottom: number } {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Record<string, unknown>;
  return [bounds.left, bounds.top, bounds.right, bounds.bottom].every((part) => typeof part === "number" && Number.isFinite(part))
    && (bounds.right as number) > (bounds.left as number) && (bounds.bottom as number) > (bounds.top as number);
}
function isRegion(value: unknown): value is Region {
  if (!value || typeof value !== "object") return false;
  const region = value as Record<string, unknown>;
  return typeof region.id === "string" && Boolean(region.id)
    && Number.isInteger(region.pageIndex) && (region.pageIndex as number) >= 0
    && typeof region.columnId === "string" && Boolean(region.columnId)
    && finiteBounds(region.bounds)
    && Number.isInteger(region.readingOrder) && (region.readingOrder as number) >= 0;
}
function isPageLayout(value: unknown): value is DocxBaselinePageLayout {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return Number.isInteger(page.pageNumber) && (page.pageNumber as number) > 0
    && typeof page.widthPt === "number" && Number.isFinite(page.widthPt) && page.widthPt > 0
    && typeof page.heightPt === "number" && Number.isFinite(page.heightPt) && page.heightPt > 0
    && page.rotation === 0
    && Array.isArray(page.regions) && page.regions.length > 0 && page.regions.every(isRegion);
}
function hasPosition(anchor: PdfSourceAnchor): anchor is PdfAnchorWithPosition {
  return "regionId" in anchor && typeof anchor.regionId === "string" && Boolean(anchor.regionId)
    && "readingOrder" in anchor && typeof anchor.readingOrder === "number" && Number.isInteger(anchor.readingOrder) && anchor.readingOrder >= 0
    && Number.isInteger(anchor.pageNumber) && anchor.pageNumber > 0 && finiteBounds(anchor.boundsPt);
}
function roleOf(anchor: DocxSourceAnchor | PdfSourceAnchor): "header" | "footer" | undefined {
  return "repeatedRole" in anchor && (anchor.repeatedRole === "header" || anchor.repeatedRole === "footer") ? anchor.repeatedRole : undefined;
}
function positionedPdfBaseline(source: PdfSourceRepresentation): { pages: DocxBaselinePageLayout[]; anchors: PdfAnchorWithPosition[] } | undefined {
  if (!("pages" in source.layout) || !Array.isArray(source.layout.pages) || source.layout.pages.length !== source.layout.pageCount) return undefined;
  const pages = source.layout.pages;
  if (!pages.every(isPageLayout)) return undefined;
  const pageNumbers = pages.map((page) => page.pageNumber);
  if (new Set(pageNumbers).size !== pages.length || pageNumbers.some((pageNumber, index) => pageNumber !== index + 1)) return undefined;
  for (const page of pages) {
    if (new Set(page.regions.map((region) => region.id)).size !== page.regions.length
      || page.regions.some((region) => region.pageIndex !== page.pageNumber - 1)) return undefined;
  }
  if (!source.anchors.every(hasPosition)) return undefined;
  const anchors = source.anchors as PdfAnchorWithPosition[];
  if (new Set(anchors.map((anchor) => anchor.readingOrder)).size !== anchors.length) return undefined;
  for (const anchor of anchors) {
    const page = pages[anchor.pageNumber - 1];
    if (!page || !page.regions.some((region) => region.id === anchor.regionId)) return undefined;
  }
  return { pages, anchors };
}
function copyBounds(bounds: DocxBaselineAnchorLayout["boundsPt"]) {
  return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
}
function copyPage(page: DocxBaselinePageLayout): DocxBaselinePageLayout {
  return { ...page, ...(page.marginsPt ? { marginsPt: { ...page.marginsPt } } : {}), regions: page.regions.map((region) => ({ ...region, bounds: copyBounds(region.bounds) })) };
}
function layoutAnchor(anchorId: string, pdfAnchor: PdfAnchorWithPosition): DocxBaselineAnchorLayout {
  return { anchorId, pageNumber: pdfAnchor.pageNumber, regionId: pdfAnchor.regionId, readingOrder: pdfAnchor.readingOrder, boundsPt: copyBounds(pdfAnchor.boundsPt) };
}
function sectionBoundary(left: DocxSourceAnchor | PdfSourceAnchor, right: DocxSourceAnchor | PdfSourceAnchor) { return left.sectionId !== right.sectionId; }
function entryBoundary(left: DocxSourceAnchor | PdfSourceAnchor, right: DocxSourceAnchor | PdfSourceAnchor) { return left.entryId !== right.entryId; }

/**
 * Maps structural DOCX anchors to the exact PDF baseline rendered by LibreOffice.
 * It uses full ordered text and section/entry boundaries; any unpaired or ambiguous
 * source span blocks tailoring rather than guessing which paragraph moved.
 */
export function mapDocxSourceToPdfLayout(source: DocxSourceRepresentation, baseline: PdfSourceRepresentation): DocxSourceLayoutResult {
  if (source.format !== "docx" || source.support.status !== "candidate") return blocked(source.support.reason ?? "The uploaded DOCX structure is unsupported. Replace it with an editable DOCX résumé.");
  if (baseline.format !== "pdf" || baseline.support.status !== "candidate") return blocked(baseline.support.reason ?? "LibreOffice could not produce a supported baseline PDF. Check the source layout and fonts, then upload a replacement DOCX.");
  const positioned = positionedPdfBaseline(baseline);
  if (!positioned) return blocked("The DOCX baseline PDF is missing a complete page, region, or text-anchor map. Upload a simpler DOCX layout for safe page mapping.");

  const sourceIds = source.anchors.map((anchor) => anchor.id);
  if (!source.anchors.length || sourceIds.some((id) => !id.trim()) || new Set(sourceIds).size !== sourceIds.length)
    return blocked("The inspected DOCX has missing or duplicate anchor identities, so its layout cannot be mapped safely. Re-upload the original DOCX.");

  const sourceFurniture = source.anchors.filter((anchor) => roleOf(anchor));
  const sourceBody = source.anchors.filter((anchor) => anchor.partName === "word/document.xml" && !roleOf(anchor)).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  if (source.anchors.some((anchor) => anchor.partName !== "word/document.xml" && !roleOf(anchor)))
    return blocked("The DOCX contains visible text outside its body that cannot be classified as a repeated header or footer. Move it into the document body or upload a simpler DOCX.");
  if (sourceBody.length === 0 || sourceBody.some((anchor, index) => !Number.isInteger(anchor.paragraphIndex) || anchor.paragraphIndex < 0 || (index > 0 && anchor.paragraphIndex <= sourceBody[index - 1].paragraphIndex)))
    return blocked("The DOCX body anchors are incomplete or out of order, so the baseline cannot be mapped safely. Re-upload the original DOCX.");

  const furnitureAnchors: DocxBaselineAnchorLayout[] = [];
  const matchedFurniture = new Set<string>();
  const sourceFurnitureKeys = new Set<string>();
  for (const anchor of sourceFurniture) {
    const role = roleOf(anchor)!;
    const key = `${role}\0${normalized(anchor.text)}`;
    if (!normalized(anchor.text) || sourceFurnitureKeys.has(key)) return blocked("The DOCX repeats or omits a header/footer anchor in a way that is ambiguous. Remove the duplicate furniture or upload a replacement DOCX.");
    sourceFurnitureKeys.add(key);
    const matches = positioned.anchors.filter((candidate) => normalized(candidate.text) === normalized(anchor.text));
    const roleMismatch = matches.some((candidate) => {
      const candidateRole = roleOf(candidate);
      return (candidateRole !== undefined && candidateRole !== role) || (positioned.pages.length > 1 && candidateRole !== role);
    });
    if (matches.length === 0 || roleMismatch)
      return blocked(`The DOCX ${role} text “${anchor.text.slice(0, 60)}” does not match the rendered baseline on the expected pages. Remove or repair the repeated furniture before tailoring.`);
    const pageNumbers = matches.map((candidate) => candidate.pageNumber);
    const repeatedOnEveryPage = positioned.pages.length === 1
      ? matches.length === 1
      : matches.length === positioned.pages.length && positioned.pages.every((page) => pageNumbers.includes(page.pageNumber));
    if (new Set(pageNumbers).size !== pageNumbers.length || !repeatedOnEveryPage)
      return blocked(`The DOCX ${role} text “${anchor.text.slice(0, 60)}” is missing or duplicated on a page. Fix the repeated furniture before tailoring.`);
    for (const match of matches) {
      matchedFurniture.add(match.id);
      furnitureAnchors.push(layoutAnchor(anchor.id, match));
    }
  }
  for (const anchor of positioned.anchors.filter((candidate) => roleOf(candidate))) {
    const key = `${roleOf(anchor)}\0${normalized(anchor.text)}`;
    if (!sourceFurnitureKeys.has(key)) return blocked("The baseline PDF contains repeated header/footer text that is not present in the DOCX source. Replace the source with a matching editable document.");
  }

  const pdfBody = positioned.anchors.filter((anchor) => !matchedFurniture.has(anchor.id)).sort((left, right) => left.readingOrder - right.readingOrder);
  if (sourceBody.length !== pdfBody.length)
    return blocked(`The DOCX has ${sourceBody.length} body anchors but its PDF baseline has ${pdfBody.length} corresponding text anchors. Shorten or simplify the source so every paragraph maps one-to-one.`);

  const mappedBody: DocxBaselineAnchorLayout[] = [];
  for (let index = 0; index < sourceBody.length; index++) {
    const docxAnchor = sourceBody[index];
    const pdfAnchor = pdfBody[index];
    if (normalized(docxAnchor.text) !== normalized(pdfAnchor.text))
      return blocked(`The rendered baseline text at paragraph ${docxAnchor.paragraphIndex + 1} does not match the DOCX source. Check for missing, reordered, or substituted content, then upload a replacement.`);
    if (docxAnchor.kind !== pdfAnchor.kind)
      return blocked(`The rendered baseline changes the source structure near “${docxAnchor.text.slice(0, 60)}”. Upload a DOCX whose headings and entries render as ordinary text.`);
    if (normalized(docxAnchor.sectionHeading) !== normalized(pdfAnchor.sectionHeading) || normalized(docxAnchor.entryHeading) !== normalized(pdfAnchor.entryHeading))
      return blocked(`The rendered baseline changes the section or employer/project association for “${docxAnchor.text.slice(0, 60)}”. Review the original structure or upload a replacement DOCX.`);
    if (index > 0) {
      const sourceSectionBoundary = sectionBoundary(sourceBody[index - 1], docxAnchor);
      const pdfSectionBoundary = sectionBoundary(pdfBody[index - 1], pdfAnchor);
      const sourceEntryBoundary = entryBoundary(sourceBody[index - 1], docxAnchor);
      const pdfEntryBoundary = entryBoundary(pdfBody[index - 1], pdfAnchor);
      if (sourceSectionBoundary !== pdfSectionBoundary || sourceEntryBoundary !== pdfEntryBoundary)
        return blocked(`The rendered baseline changes section or entry grouping near “${docxAnchor.text.slice(0, 60)}”. Use a DOCX whose page flow keeps each employer and project together.`);
    }
    mappedBody.push(layoutAnchor(docxAnchor.id, pdfAnchor));
  }

  const anchors = [...mappedBody, ...furnitureAnchors].sort((left, right) => left.pageNumber - right.pageNumber || left.readingOrder - right.readingOrder);
  const mappedIds = new Set(anchors.map((anchor) => anchor.anchorId));
  const anchorsPerId = new Map<string, number>();
  for (const anchor of anchors) anchorsPerId.set(anchor.anchorId, (anchorsPerId.get(anchor.anchorId) ?? 0) + 1);
  const complete = source.anchors.every((anchor) => {
    const expected = roleOf(anchor) ? positioned.pages.length : 1;
    return mappedIds.has(anchor.id) && anchorsPerId.get(anchor.id) === expected;
  });
  if (!complete || mappedIds.size !== source.anchors.length || source.anchors.filter((anchor) => anchor.candidateClaim && !roleOf(anchor)).some((anchor) => anchorsPerId.get(anchor.id) !== 1))
    return blocked("The DOCX baseline did not produce one unique page and region for every source anchor. Upload a simpler source document.");
  return { status: "supported", layout: { version: 1, pages: positioned.pages.map(copyPage).sort((left, right) => left.pageNumber - right.pageNumber), anchors } };
}
