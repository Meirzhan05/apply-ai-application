import { getDocument, OPS } from "@/lib/pdfjs-runtime";
import { bytesHash } from "@/lib/resume-artifacts";
import { hashJson } from "@/lib/crypto";
import type { PdfSourceAnchor, PdfSourceRepresentation } from "@/lib/types";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_TEXT = 20_000;
const sectionNames = /^(?:education|academic background|publications|research|work experience|professional experience|experience|internship experience|open source experience|projects|personal projects|technical skills|skills|certifications|awards|leadership|volunteering|summary|profile)$/i;
const claimStart = /^(?:built|created|developed|designed|analyzed|managed|led|implemented|conducted|researched|improved|worked|used|organized|launched|integrated|shipped|collaborated|architected|published|authored|supported|automated|reduced|increased|delivered|maintained|deployed|contributed)\b/i;
const bulletText = /^[•●▪◦‣*\-–]\s*/;
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

function readableFontFamily(name: string) {
  return name.replace(/^[A-Z]{6}\+/, "").replace(/[-_](?:Bold|Italic|Oblique|Regular|Medium|Light|Book|Roman|Semibold|Demi|Black)(?:[-_]\d+)?/gi, "").replace(/[-_]\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

function reasonFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/password|encrypt/i.test(message)) return "This PDF is password-protected. Remove its password and upload an unlocked PDF or editable DOCX.";
  return "This PDF could not be read safely. Save it again as a text-based PDF or upload an editable DOCX.";
}

function appendReason(current: string | undefined, next: string) { return current ?? next; }

function detectColumns(items: LocatedItem[]) {
  const groups: Array<{ left: number; tops: number[]; count: number }> = [];
  for (const item of items) {
    let nearest = groups.find((group) => Math.abs(group.left - item.left) <= 28);
    if (!nearest) { nearest = { left: item.left, tops: [], count: 0 }; groups.push(nearest); }
    nearest.tops.push(item.top); nearest.count++;
  }
  const substantial = groups.filter((group) => group.count >= 2);
  let columns = 1;
  for (let i = 0; i < substantial.length; i++) for (let j = i + 1; j < substantial.length; j++) {
    const a = substantial[i]; const b = substantial[j];
    if (Math.abs(a.left - b.left) < 120) continue;
    const aTop = Math.min(...a.tops); const aBottom = Math.max(...a.tops);
    const bTop = Math.min(...b.tops); const bBottom = Math.max(...b.tops);
    if (Math.min(aBottom, bBottom) - Math.max(aTop, bTop) >= 24) columns = Math.max(columns, 2);
  }
  return columns;
}

export async function parsePdfSource(bytes: Buffer): Promise<PdfSourceRepresentation> {
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) throw new Error("Choose a PDF résumé up to 5 MB.");
  const sourceHash = bytesHash(bytes);
  const loadingTask = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, stopAtErrors: true, maxImageSize: 30_000_000 });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages < 1 || pdf.numPages > 50) throw new Error("This PDF has an unsupported page count.");
    let reason: string | undefined;
    if (pdf.isPureXfa) reason = "This PDF is an XFA form rather than a plain résumé. Save it as a text-based PDF or upload an editable DOCX.";
    if (pdf.numPages !== 1) reason = appendReason(reason, `This PDF has ${pdf.numPages} pages. PDF layout-preserving tailoring currently supports one page; upload an editable DOCX if the résumé needs to stay multi-page.`);
    const fontFamilies = new Set<string>();
    const anchors: PdfSourceAnchor[] = [];
    const sections: PdfSourceRepresentation["sections"] = [];
    const textLines: string[] = [];
    let firstPageSize = { width: 0, height: 0 };
    let margins = { top: 0, right: 0, bottom: 0, left: 0 };
    let detectedColumns = 1;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      if (page.rotate !== 0) reason = appendReason(reason, "This PDF uses rotated page content. Save it as an upright, text-based PDF or upload an editable DOCX.");
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      if (viewport.width > 900 || viewport.height > 1100 || viewport.width * viewport.height > 600_000)
        reason = appendReason(reason, "This PDF page is larger than the bounded one-page layout profile. Save it to a standard résumé page size or upload an editable DOCX.");
      if (pageNumber === 1) firstPageSize = { width: round(viewport.width), height: round(viewport.height) };
      else if (Math.abs(viewport.width - firstPageSize.width) > 0.5 || Math.abs(viewport.height - firstPageSize.height) > 0.5) reason = appendReason(reason, "This PDF uses mixed page dimensions. Upload an editable DOCX to preserve the résumé layout.");

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
        const fontFamily = resolvedFontName ? readableFontFamily(resolvedFontName) : "";
        const bold = /bold|black|semibold|demi/i.test(resolvedFontName);
        const italic = /italic|oblique/i.test(resolvedFontName);
        const [a, b, c, d, x, y] = item.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || Math.abs(a - d) > 0.05 || a <= 0 || d <= 0 || style.vertical)
          reason = appendReason(reason, "This PDF has rotated, sheared, or vertically scaled text. Save it as an upright single-column PDF or upload an editable DOCX.");
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
      detectedColumns = Math.max(detectedColumns, detectColumns(located));
      if (detectedColumns > 1) reason = appendReason(reason, "This PDF uses a two-column or parallel text layout. Upload an editable DOCX; multi-column PDF reconstruction is not supported.");

      if (operatorList.fnArray.some((operation) => imageOperations.has(operation))) reason = appendReason(reason, "This PDF contains images or a scanned-page background that cannot be edited without changing its appearance. Upload an editable DOCX.");
      if (operatorList.fnArray.some((operation) => formOperations.has(operation))) reason = appendReason(reason, "This PDF uses a Form XObject, which is outside the supported text-only profile. Upload an editable DOCX to preserve its layout.");
      if (operatorList.fnArray.some((operation) => vectorPaintOperations.has(operation))) reason = appendReason(reason, "This PDF contains vector artwork or outlined text that the current source editor cannot validate safely. Upload an editable DOCX.");

      const pageItems: string[] = [];
      let activeSection = { id: `pdf-section-${hashJson([sourceHash, pageNumber, "default"]).slice(0, 12)}`, heading: "Résumé", anchorIds: [] as string[] };
      if (pageNumber === 1) sections.push(activeSection);
      let currentEntryId = `pdf-entry-${hashJson([sourceHash, pageNumber, "preamble"]).slice(0, 12)}`;
      let currentEntryHeading = "Résumé details";
      let entryHasBullet = false;
      for (const item of located) {
        const rawText = item.rawSourceText;
        const prefix = rawText.match(bulletText)?.[0] ?? "";
        const text = clean(rawText.slice(prefix.length));
        if (!text) { pageItems.push(rawText); continue; }
        const isHeading = sectionNames.test(text.replace(/:$/, ""));
        const isBullet = Boolean(prefix);
        if (isHeading) {
          activeSection = { id: `pdf-section-${hashJson([sourceHash, pageNumber, item.index, text]).slice(0, 12)}`, heading: text.replace(/:$/, ""), anchorIds: [] };
          sections.push(activeSection);
          currentEntryId = `pdf-entry-${hashJson([activeSection.id, "intro"]).slice(0, 12)}`;
          currentEntryHeading = activeSection.heading;
          entryHasBullet = false;
        } else if (!isBullet && (entryHasBullet || currentEntryHeading === "Résumé details" || currentEntryHeading === activeSection.heading)) {
          currentEntryId = `pdf-entry-${hashJson([activeSection.id, item.index, text]).slice(0, 12)}`;
          currentEntryHeading = text;
          entryHasBullet = false;
        } else if (!isBullet && !entryHasBullet && currentEntryHeading !== "Résumé details" && currentEntryHeading !== activeSection.heading) {
          currentEntryHeading = `${currentEntryHeading} · ${text}`;
        }
        const kind: PdfSourceAnchor["kind"] = isHeading ? "section" : isBullet ? "bullet" : "entry";
        const candidateClaim = isBullet || claimStart.test(text) || /\b(?:19|20)\d{2}\b|\b(?:expected|in preparation|submitted|prototype|coursework)\b/i.test(text);
        const editable = isBullet && !item.style.vertical && item.item.str.length <= 500 && Boolean(item.fontFamily) && item.item.height > 0 && item.item.width > 0 && item.left >= -0.5 && item.top >= -0.5 && item.right <= viewport.width + 0.5 && item.bottom <= viewport.height + 0.5;
        const styleFingerprint = { fontName: item.resolvedFontName, fontFamily: item.fontFamily, size: round(Math.hypot(item.item.transform[0], item.item.transform[1])), bounds: [round(item.left), round(item.top), round(item.right), round(item.bottom)] };
        const operatorFingerprint = hashJson({ sourceHash, pageNumber, index: item.index, text: rawText, styleFingerprint });
        const id = `pdf:${sourceHash.slice(0, 12)}:p${pageNumber}:i${item.index}:${operatorFingerprint.slice(0, 12)}`;
        const fontSize = round(Math.hypot(item.item.transform[0], item.item.transform[1]));
        const anchor: PdfSourceAnchor = { id, pageNumber, sourceText: rawText, bulletPrefix: prefix, text, sectionId: activeSection.id, sectionHeading: activeSection.heading,
          entryId: currentEntryId, entryHeading: currentEntryHeading, kind, candidateClaim, editable, boundsPt: { left: round(item.left), top: round(item.top), right: round(item.right), bottom: round(item.bottom) },
          operatorFingerprint, fontResourceName: item.item.fontName, styleHash: hashJson(styleFingerprint), font: { family: item.fontFamily || "unknown", sizePt: fontSize, bold: item.bold, italic: item.italic } };
        anchors.push(anchor);
        activeSection.anchorIds.push(id);
        pageItems.push(rawText);
        if (isBullet) entryHasBullet = true;
        if (candidateClaim && isBullet && !editable) reason = appendReason(reason, `The résumé bullet “${text.slice(0, 80)}” is too long or its source font/layout cannot be mapped safely. Upload an editable DOCX.`);
      }
      textLines.push(pageItems.join("\n"));
      if (pageNumber === 1 && located.length) {
        const left = Math.min(...located.map((item) => item.left)); const right = Math.max(...located.map((item) => item.right));
        const top = Math.min(...located.map((item) => item.top)); const bottom = Math.max(...located.map((item) => item.bottom));
        margins = { top: round(Math.max(0, top)), right: round(Math.max(0, viewport.width - right)), bottom: round(Math.max(0, viewport.height - bottom)), left: round(Math.max(0, left)) };
      }
      page.cleanup();
    }
    const text = textLines.join("\n").trim();
    if (text.length > MAX_SOURCE_TEXT) throw new Error(`This PDF contains ${text.length.toLocaleString()} readable characters, above the ${MAX_SOURCE_TEXT.toLocaleString()}-character source-context limit. Shorten the résumé or upload a supported one-page version; no text was dropped.`);
    if (!text) reason = appendReason(reason, "This PDF has no extractable text and appears scanned or image-only. Upload an editable DOCX; OCR and image reconstruction are not supported.");
    if (!anchors.some((anchor) => anchor.candidateClaim)) reason = appendReason(reason, "This PDF has no clearly separated résumé claim text to confirm and preserve. Upload an editable DOCX with ordinary text paragraphs.");
    const duplicateBullets = new Set(anchors.filter((anchor) => anchor.kind === "bullet").map((anchor) => anchor.sourceText).filter((value, index, all) => all.indexOf(value) !== index));
    if (duplicateBullets.size) {
      reason = appendReason(reason, "This PDF repeats identical résumé bullet text, so the source operator cannot be mapped unambiguously. Edit the duplicate wording in the source PDF or upload an editable DOCX.");
      for (const anchor of anchors) if (duplicateBullets.has(anchor.sourceText)) anchor.editable = false;
    }
    if (!sections.length) sections.push({ id: `pdf-section-${hashJson([sourceHash, "default"]).slice(0, 12)}`, heading: "Résumé", anchorIds: anchors.map((anchor) => anchor.id) });
    if (anchors.some((anchor) => anchor.candidateClaim && !anchor.font.family)) reason = appendReason(reason, "A required source font could not be identified. Upload an editable DOCX rather than substituting a font.");
    return { version: 1, parser: "pdfjs-text-1", format: "pdf", sourceHash, text, support: reason ? { status: "blocked", reason } : { status: "candidate" },
      layout: { columns: detectedColumns, pageCount: pdf.numPages, pageSizePt: firstPageSize, marginsPt: margins, fontFamilies: [...fontFamilies].sort() }, sections, anchors };
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
