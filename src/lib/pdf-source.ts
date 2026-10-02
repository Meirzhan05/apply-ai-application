import { getDocument, OPS } from "@/lib/pdfjs-runtime";
import { bytesHash } from "@/lib/resume-artifacts";
import { hashJson } from "@/lib/crypto";
import { groupPositionedSpansIntoRegions } from "@/lib/source-regions";
import { readablePdfFontFamily } from "@/lib/pdf-fonts";
import { isResumeSectionHeading, isSubstantiveSourceText } from "@/lib/resume-source-semantics";
import type { PdfSourceAnchor, PdfSourceRepresentation, ResumeSourcePageLayout } from "@/lib/types";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_TEXT = 20_000;
const MAX_SUPPORTED_PAGES = 8;
const bulletText = /^[•●▪◦‣*\-–]\s*/;
const standaloneBulletMarker = (text: string) => /^[•●▪◦‣]$/.test(clean(text));
const imageOperations = new Set<number>([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup, OPS.paintSolidColorImageMask, OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectRepeat,
]);
const formOperations = new Set<number>([OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd]);
const vectorPaintOperations = new Set<number>([OPS.stroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeStroke, OPS.closeFillStroke]);

interface ItemStyle { fontFamily?: string; ascent?: number; descent?: number; vertical?: boolean }
interface TextItem { str: string; dir: string; transform: number[]; width: number; height: number; fontName: string; hasEOL?: boolean }
interface LocatedItem { item: TextItem; rawSourceText: string; style: ItemStyle; resolvedFontName: string; fontFamily: string; bold: boolean; italic: boolean; index: number; pageNumber: number; left: number; top: number; right: number; bottom: number; baseline: number }

const clean = (value: string) => value.replace(/[\u0000\u200b\u00ad]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const round = (value: number) => Math.round(value * 100) / 100;

type ParsedPage = { pageNumber: number; width: number; height: number; rotation: number; items: LocatedItem[]; orderedItems?: LocatedItem[] };

function repeatFurniture(pages: ParsedPage[]) {
  const candidates = new Map<string, Array<{ page: ParsedPage; item: LocatedItem; role: "header" | "footer" }>>();
  for (const page of pages) for (const item of page.items) {
    if (standaloneBulletMarker(item.rawSourceText)) continue;
    const role = item.top <= 54 ? "header" : item.bottom >= page.height - 54 ? "footer" : undefined;
    if (!role) continue;
    const text = clean(item.rawSourceText).toLocaleLowerCase();
    if (!text) continue;
    const key = `${role}:${text}`;
    candidates.set(key, [...(candidates.get(key) ?? []), { page, item, role }]);
  }
  const repeated = new Map<string, "header" | "footer">();
  for (const group of candidates.values()) {
    const pageNumbers = new Set(group.map(({ page }) => page.pageNumber));
    if (pageNumbers.size < 2) continue;
    const first = group[0];
    if (group.some(({ item, role }) => role !== first.role || Math.abs(item.left - first.item.left) > 2 || Math.abs(item.top - first.item.top) > 2)) continue;
    for (const { page, item, role } of group) repeated.set(`${page.pageNumber}:${item.index}`, role);
  }
  return repeated;
}

function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/password|encrypt/i.test(message)) return "This PDF is password-protected. Remove its password and upload an unlocked PDF or editable DOCX.";
  return "This PDF could not be read safely. Save it again as a text-based PDF or upload an editable DOCX.";
}

function appendReason(current: string | undefined, next: string) { return current ?? next; }

export async function parsePdfSource(bytes: Buffer, trustedName?: string): Promise<PdfSourceRepresentation> {
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) throw new Error("Choose a PDF résumé up to 5 MB.");
  const sourceHash = bytesHash(bytes);
  const loadingTask = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, stopAtErrors: true, maxImageSize: 30_000_000 });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages < 1 || pdf.numPages > 50) throw new Error("This PDF has an unsupported page count.");
    let reason: string | undefined;
    if (pdf.isPureXfa) reason = "This PDF is an XFA form rather than a plain résumé. Save it as a text-based PDF or upload an editable DOCX.";
    if (pdf.numPages > MAX_SUPPORTED_PAGES) reason = appendReason(reason, `This PDF has ${pdf.numPages} pages. The source-preserving worker supports up to ${MAX_SUPPORTED_PAGES} pages; no content was dropped.`);
    const fontFamilies = new Set<string>();
    const anchors: PdfSourceAnchor[] = [];
    const sections: PdfSourceRepresentation["sections"] = [];
    const textLines: string[] = [];
    const parsedPages: ParsedPage[] = [];
    const pageLayouts: ResumeSourcePageLayout[] = [];
    let firstPageSize = { width: 0, height: 0 };
    let margins = { top: 0, right: 0, bottom: 0, left: 0 };
    let detectedColumns = 1;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      if (page.rotate !== 0) reason = appendReason(reason, "This PDF uses rotated page content. Save it as an upright, text-based PDF or upload an editable DOCX.");
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      if (viewport.width > 900 || viewport.height > 1100 || viewport.width * viewport.height > 600_000)
        reason = appendReason(reason, "A PDF page exceeds the bounded page-size profile. Use standard résumé page dimensions; no pages or text were removed.");
      if (pageNumber === 1) firstPageSize = { width: round(viewport.width), height: round(viewport.height) };

      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const operatorList = await page.getOperatorList({ intent: "display" });
      const showText = operatorList.fnArray.flatMap((operation, index) => operation === OPS.showText ? [operatorList.argsArray[index]?.[0] as Array<{ unicode?: string }> | undefined] : []).filter((value): value is Array<{ unicode?: string }> => Boolean(value));
      const readableShowText = showText.map((glyphs) => glyphs.map((glyph) => glyph.unicode ?? "").join(""));
      const nonEmptyTextItemCount = content.items.filter((value) => Boolean(value && typeof value === "object" && "str" in value && "transform" in value && clean((value as TextItem).str))).length;
      if (readableShowText.length !== nonEmptyTextItemCount) reason = appendReason(reason, "This PDF's text operators cannot be correlated to all displayed text spans without ambiguity. Upload an editable DOCX for source-aware editing.");
      const located: LocatedItem[] = [];
      let textItemCursor = 0;
      for (let index = 0; index < content.items.length; index++) {
        const value = content.items[index] as TextItem | { type: string };
        if (!value || typeof value !== "object" || !("str" in value) || !("transform" in value)) continue;
        const item = value as TextItem;
        const visibleText = clean(item.str);
        if (!visibleText) continue;
        const operatorText = readableShowText[textItemCursor++];
        const cleanedOperatorText = operatorText ? clean(operatorText) : "";
        if (cleanedOperatorText && !cleanedOperatorText.startsWith(visibleText) && !visibleText.startsWith(cleanedOperatorText)) reason = appendReason(reason, "This PDF's visible text could not be matched exactly to its source text operators. Upload an editable DOCX for source-aware editing.");
        const text = cleanedOperatorText.startsWith(visibleText) ? cleanedOperatorText : visibleText;
        const rawSourceText = operatorText && cleanedOperatorText.startsWith(visibleText) ? operatorText : item.str;
        const style = (content.styles as Record<string, ItemStyle>)[item.fontName] ?? {};
        let resolvedFontName = "";
        try {
          const font = page.commonObjs.get(item.fontName) as { name?: string };
          resolvedFontName = font.name ?? "";
        } catch {
          // A missing font object is reported as an unsupported source below.
        }
        const fontFamily = resolvedFontName ? readablePdfFontFamily(resolvedFontName) : "";
        const bold = /bold|black|semibold|demi/i.test(resolvedFontName);
        const italic = /italic|oblique/i.test(resolvedFontName);
        const [a, b, c, d, x, y] = item.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || Math.abs(a - d) > 0.05 || a <= 0 || d <= 0 || style.vertical)
          reason = appendReason(reason, "This PDF has rotated, sheared, or vertically scaled text. Save it as an upright, text-based PDF or upload an editable DOCX.");
        const left = x;
        const top = viewport.height - y - item.height;
        const right = x + item.width;
        const bottom = viewport.height - y;
        located.push({ item: { ...item, str: text }, rawSourceText, style, resolvedFontName, fontFamily, bold, italic, index, pageNumber, left, top, right, bottom, baseline: y });
        if (left < -0.5 || top < -0.5 || right > viewport.width + 0.5 || bottom > viewport.height + 0.5) reason = appendReason(reason, `The source text “${text.slice(0, 60)}” extends outside the visible page, so the full source cannot be safely edited. Shorten or reposition it in the original PDF, or upload an editable DOCX.`);
        if (fontFamily) fontFamilies.add(fontFamily);
        else reason = appendReason(reason, `The source font for “${text.slice(0, 60)}” cannot be identified. Upload an editable DOCX rather than substituting a font.`);
      }
      located.sort((left, right) => left.top - right.top || left.left - right.left || left.index - right.index);
      if (!located.length) reason = appendReason(reason, "This PDF has no extractable text and appears scanned or image-only. Upload an editable DOCX; OCR and image reconstruction are not supported.");

      if (operatorList.fnArray.some((operation) => imageOperations.has(operation))) reason = appendReason(reason, "This PDF contains images or a scanned-page background that cannot be edited without changing its appearance. Upload an editable DOCX.");
      if (operatorList.fnArray.some((operation) => formOperations.has(operation))) reason = appendReason(reason, "This PDF uses a Form XObject, which is outside the supported text-only profile. Upload an editable DOCX to preserve its layout.");
      if (operatorList.fnArray.some((operation) => vectorPaintOperations.has(operation))) reason = appendReason(reason, "This PDF contains vector artwork or outlined text that the current source editor cannot validate safely. Upload an editable DOCX.");

      const width = round(viewport.width);
      const height = round(viewport.height);
      parsedPages.push({ pageNumber, width, height, rotation: page.rotate, items: located });
      page.cleanup();
    }

    const repeated = repeatFurniture(parsedPages);
    const positioned = parsedPages.flatMap((page) => page.items.filter((item) => !repeated.has(`${page.pageNumber}:${item.index}`)).map((item) => ({
      id: `${page.pageNumber}:${item.index}`, pageIndex: page.pageNumber - 1,
      bounds: { left: item.left, top: item.top, right: item.right, bottom: item.bottom },
    })));
    const grouping = groupPositionedSpansIntoRegions(positioned);
    const regionBySpanId = new Map<string, string>();
    const assignmentOrder = new Map<string, number>();
    if (grouping.status === "supported") {
      for (const assignment of grouping.assignments) {
        regionBySpanId.set(assignment.spanId, assignment.regionId);
        assignmentOrder.set(assignment.spanId, assignment.readingOrder);
      }
    }
    for (const page of parsedPages) {
        const headerItems = page.items.filter((item) => repeated.get(`${page.pageNumber}:${item.index}`) === "header").sort((a, b) => a.top - b.top || a.left - b.left);
        const footerItems = page.items.filter((item) => repeated.get(`${page.pageNumber}:${item.index}`) === "footer").sort((a, b) => a.top - b.top || a.left - b.left);
        const pageRegions = grouping.status === "supported" ? grouping.regions.filter((region) => region.pageIndex === page.pageNumber - 1) : [];
        const furnitureRegion = (items: LocatedItem[], role: "header" | "footer") => items.length ? [{
          id: `page-${page.pageNumber}-${role}`, pageIndex: page.pageNumber - 1, columnId: role,
          bounds: { left: Math.min(...items.map((item) => item.left)), top: Math.min(...items.map((item) => item.top)),
            right: Math.max(...items.map((item) => item.right)), bottom: Math.max(...items.map((item) => item.bottom)) },
          readingOrder: role === "header" ? -1 : pageRegions.length,
        }] : [];
        const regions = [...furnitureRegion(headerItems, "header"), ...pageRegions, ...furnitureRegion(footerItems, "footer")];
        const headerRegionId = `page-${page.pageNumber}-header`;
        const footerRegionId = `page-${page.pageNumber}-footer`;
        for (const item of headerItems) regionBySpanId.set(`${page.pageNumber}:${item.index}`, headerRegionId);
        for (const item of footerItems) regionBySpanId.set(`${page.pageNumber}:${item.index}`, footerRegionId);
        const bodyItems = page.items.filter((item) => !repeated.has(`${page.pageNumber}:${item.index}`));
        const orderedBody = grouping.status === "supported"
          ? grouping.assignments.filter((assignment) => assignment.spanId.startsWith(`${page.pageNumber}:`)).map((assignment) => bodyItems.find((item) => `${page.pageNumber}:${item.index}` === assignment.spanId)!).filter(Boolean)
          : [...bodyItems].sort((left, right) => left.top - right.top || left.left - right.left || left.index - right.index);
        page.orderedItems = [...headerItems, ...orderedBody, ...footerItems];
        pageLayouts.push({ pageNumber: page.pageNumber, widthPt: page.width, heightPt: page.height, rotation: page.rotation, regions });
    }
    if (grouping.status === "supported") {
      detectedColumns = Math.max(1, ...grouping.regions.reduce((counts, region) => {
        counts[region.pageIndex] = (counts[region.pageIndex] ?? 0) + 1;
        return counts;
      }, [] as number[]));
    }

    const separateBulletBySpanId = new Map<string, string>();
    const separateBulletMarkerSpans = new Set<string>();
    const mappedBulletBodySpans = new Set<string>();
    for (const page of parsedPages) for (const marker of page.items.filter((item) => standaloneBulletMarker(item.rawSourceText))) {
      const markerSpanId = `${page.pageNumber}:${marker.index}`;
      const markerRegionId = regionBySpanId.get(markerSpanId);
      const candidates = markerRegionId ? page.items.flatMap((item) => {
        const spanId = `${page.pageNumber}:${item.index}`;
        const gap = item.left - marker.right;
        if (spanId === markerSpanId || standaloneBulletMarker(item.rawSourceText) || repeated.has(spanId) || mappedBulletBodySpans.has(spanId) ||
          regionBySpanId.get(spanId) !== markerRegionId || gap < 0 || gap > 36 || Math.abs(item.baseline - marker.baseline) > 1.5) return [];
        return [{ item, spanId, gap }];
      }).sort((left, right) => left.gap - right.gap) : [];
      const first = candidates[0];
      const second = candidates[1];
      if (!first || (second && second.gap - first.gap < 2) || first.item.rawSourceText.match(bulletText)) {
        reason = appendReason(reason, "A visible list marker could not be mapped unambiguously to text in the same page and column. Reformat that list or upload an editable DOCX.");
        continue;
      }
      separateBulletBySpanId.set(first.spanId, marker.rawSourceText);
      separateBulletMarkerSpans.add(markerSpanId);
      mappedBulletBodySpans.add(first.spanId);
    }

    let activeSection = { id: `pdf-section-${hashJson([sourceHash, "default"]).slice(0, 12)}`, heading: "Résumé", anchorIds: [] as string[] };
    sections.push(activeSection);
    let currentEntryId = `pdf-entry-${hashJson([sourceHash, "preamble"]).slice(0, 12)}`;
    let currentEntryHeading = "Résumé details";
    let entryHasBullet = false;
    let currentColumnId: string | undefined;
    let readingOrder = 0;
    for (const page of parsedPages) {
      const pageItems: string[] = [];
      let seenBodyItem = false;
      const ordered = page.orderedItems ?? page.items;
      for (const item of ordered) {
        const spanId = `${page.pageNumber}:${item.index}`;
        if (separateBulletMarkerSpans.has(spanId)) continue;
        const rawText = item.rawSourceText;
        const text = clean(rawText);
        if (!text) { pageItems.push(rawText); continue; }
        const repeatedRole = repeated.get(`${page.pageNumber}:${item.index}`);
        const regionId = regionBySpanId.get(`${page.pageNumber}:${item.index}`);
        const columnId = pageLayouts[page.pageNumber - 1]?.regions.find((region) => region.id === regionId)?.columnId;
        const prefix = rawText.match(bulletText)?.[0] ?? "";
        const separateBulletMarker = separateBulletBySpanId.get(spanId);
        const isBullet = Boolean(prefix) || separateBulletMarker !== undefined;
        const continuedEntryAtPageStart = page.pageNumber > 1 && !seenBodyItem && isBullet && entryHasBullet;
        if (!repeatedRole && columnId && currentColumnId && columnId !== currentColumnId && !continuedEntryAtPageStart) {
          currentEntryId = `pdf-entry-${hashJson([sourceHash, page.pageNumber, regionId, "region-preamble"]).slice(0, 12)}`;
          currentEntryHeading = activeSection.heading;
          entryHasBullet = false;
        }
        if (!repeatedRole && columnId) currentColumnId = columnId;
        if (!repeatedRole) seenBodyItem = true;
        const claimText = clean(rawText.slice(prefix.length));
        const isHeading = isResumeSectionHeading(claimText);
        if (!repeatedRole && isHeading) {
          activeSection = { id: `pdf-section-${hashJson([sourceHash, page.pageNumber, item.index, claimText]).slice(0, 12)}`, heading: claimText.replace(/:$/, ""), anchorIds: [] };
          sections.push(activeSection);
          currentEntryId = `pdf-entry-${hashJson([activeSection.id, "intro"]).slice(0, 12)}`;
          currentEntryHeading = activeSection.heading;
          entryHasBullet = false;
        } else if (!repeatedRole && !isBullet && (entryHasBullet || currentEntryHeading === "Résumé details" || currentEntryHeading === activeSection.heading)) {
          currentEntryId = `pdf-entry-${hashJson([activeSection.id, item.index, claimText]).slice(0, 12)}`;
          currentEntryHeading = claimText;
          entryHasBullet = false;
        } else if (!repeatedRole && !isBullet && !entryHasBullet && currentEntryHeading !== "Résumé details" && currentEntryHeading !== activeSection.heading) {
          currentEntryHeading = `${currentEntryHeading} · ${claimText}`;
        }
        const kind: PdfSourceAnchor["kind"] = repeatedRole ? "paragraph" : isHeading ? "section" : isBullet ? "bullet" : "entry";
        const candidateClaim = isSubstantiveSourceText(claimText, { isSection: isHeading, firstBodyParagraph: Boolean(repeatedRole) || (page.pageNumber === 1 && readingOrder === 0), trustedName });
        const editable = !repeatedRole && isBullet && !item.style.vertical && item.item.str.length <= 500 && Boolean(item.fontFamily) && item.item.height > 0 && item.item.width > 0 && item.left >= -0.5 && item.top >= -0.5 && item.right <= page.width + 0.5 && item.bottom <= page.height + 0.5;
        const styleFingerprint = { fontName: item.resolvedFontName, fontFamily: item.fontFamily, size: round(Math.hypot(item.item.transform[0], item.item.transform[1])), bounds: [round(item.left), round(item.top), round(item.right), round(item.bottom)] };
        const operatorFingerprint = hashJson({ sourceHash, pageNumber: page.pageNumber, index: item.index, text: rawText, styleFingerprint });
        const id = `pdf:${sourceHash.slice(0, 12)}:p${page.pageNumber}:i${item.index}:${operatorFingerprint.slice(0, 12)}`;
        const fontSize = round(Math.hypot(item.item.transform[0], item.item.transform[1]));
        const anchor: PdfSourceAnchor = { id, pageNumber: page.pageNumber, ...(regionId ? { regionId } : {}), readingOrder, sourceText: rawText,
          bulletPrefix: prefix, text: claimText, sectionId: activeSection.id, sectionHeading: activeSection.heading,
          entryId: currentEntryId, entryHeading: currentEntryHeading, kind, candidateClaim, editable, ...(repeatedRole ? { repeatedRole } : {}),
          boundsPt: { left: round(item.left), top: round(item.top), right: round(item.right), bottom: round(item.bottom) },
          operatorFingerprint, fontResourceName: item.item.fontName, styleHash: hashJson(styleFingerprint), font: { family: item.fontFamily || "unknown", sizePt: fontSize, bold: item.bold, italic: item.italic } };
        anchors.push(anchor);
        activeSection.anchorIds.push(id);
        pageItems.push(`${separateBulletMarker ?? ""}${separateBulletMarker ? " " : ""}${rawText}`);
        if (!repeatedRole && isBullet) entryHasBullet = true;
        if (candidateClaim && isBullet && !editable) reason = appendReason(reason, `The résumé bullet “${claimText.slice(0, 80)}” is too long or its source font/layout cannot be mapped safely. Upload an editable DOCX.`);
        readingOrder++;
      }
      textLines.push(pageItems.join("\n"));
      if (page.pageNumber === 1 && page.items.length) {
        const left = Math.min(...page.items.map((item) => item.left)); const right = Math.max(...page.items.map((item) => item.right));
        const top = Math.min(...page.items.map((item) => item.top)); const bottom = Math.max(...page.items.map((item) => item.bottom));
        margins = { top: round(Math.max(0, top)), right: round(Math.max(0, page.width - right)), bottom: round(Math.max(0, page.height - bottom)), left: round(Math.max(0, left)) };
      }
      const pageItemsBounds = page.items;
      const pageLayout = pageLayouts[page.pageNumber - 1];
      if (pageItemsBounds.length && pageLayout) pageLayout.marginsPt = {
        top: round(Math.max(0, Math.min(...pageItemsBounds.map((item) => item.top)))),
        right: round(Math.max(0, page.width - Math.max(...pageItemsBounds.map((item) => item.right)))),
        bottom: round(Math.max(0, page.height - Math.max(...pageItemsBounds.map((item) => item.bottom)))),
        left: round(Math.max(0, Math.min(...pageItemsBounds.map((item) => item.left)))),
      };
    }
    const text = textLines.join("\n").trim();
    if (text.length > MAX_SOURCE_TEXT) throw new Error(`This PDF contains ${text.length.toLocaleString()} readable characters, above the ${MAX_SOURCE_TEXT.toLocaleString()}-character source-context limit. Shorten the résumé or upload a supported version; no text was dropped.`);
    if (!text) reason = appendReason(reason, "This PDF has no extractable text and appears scanned or image-only. Upload an editable DOCX; OCR and image reconstruction are not supported.");
    if (!anchors.some((anchor) => anchor.candidateClaim)) reason = appendReason(reason, "This PDF has no clearly separated résumé claim text to confirm and preserve. Upload an editable DOCX with ordinary text paragraphs.");
    const duplicateBullets = new Set(anchors.filter((anchor) => anchor.kind === "bullet").map((anchor) => anchor.sourceText).filter((value, index, all) => all.indexOf(value) !== index));
    if (duplicateBullets.size) {
      reason = appendReason(reason, "This PDF repeats identical résumé bullet text, so the source operator cannot be mapped unambiguously. Edit the duplicate wording in the source PDF or upload an editable DOCX.");
      for (const anchor of anchors) if (duplicateBullets.has(anchor.sourceText)) anchor.editable = false;
    }
    if (grouping.status === "blocked") reason = appendReason(reason, grouping.reason);
    if (!sections.length) sections.push({ id: `pdf-section-${hashJson([sourceHash, "default"]).slice(0, 12)}`, heading: "Résumé", anchorIds: anchors.map((anchor) => anchor.id) });
    if (anchors.some((anchor) => anchor.candidateClaim && !anchor.font.family)) reason = appendReason(reason, "A required source font could not be identified. Upload an editable DOCX rather than substituting a font.");
    return { version: 2, parser: "pdfjs-text-2", format: "pdf", sourceHash, text, support: reason ? { status: "blocked", reason } : { status: "candidate" },
      layout: { columns: detectedColumns, pageCount: pdf.numPages, pageSizePt: firstPageSize, marginsPt: margins, fontFamilies: [...fontFamilies].sort(), pages: pageLayouts }, sections, anchors };
  } catch (error) {
    if (error instanceof Error && /above the|Choose a PDF/.test(error.message)) throw error;
    throw new Error(reasonFromError(error));
  } finally {
    await loadingTask.destroy();
  }
}

export function suggestPdfFacts(source: PdfSourceRepresentation): Array<{ text: string; sourceAnchorId: string }> {
  return source.anchors.filter((anchor) => anchor.candidateClaim).flatMap((anchor) => {
    const text = clean([anchor.sectionHeading, anchor.entryHeading, anchor.text].filter(Boolean).join(" · "));
    return text.length >= 25 && text.length <= 500 ? [{ text, sourceAnchorId: anchor.id }] : [];
  });
}
