import { isUsableFact, factAnchorIds, evidenceBelongsToEntry } from "@/lib/fact-evidence";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { DOMParser, XMLSerializer, type Node as XmlDomNode, type Element as XmlDomElement, type Document as XmlDomDocument } from "@xmldom/xmldom";
import type { DocxSourceAnchor, DocxSourceRepresentation, ResumeSourceEdit, VerifiedFact } from "@/lib/types";
import { bytesHash } from "@/lib/resume-artifacts";
import { isResumeSectionHeading, isSubstantiveSourceText } from "@/lib/resume-source-semantics";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAX_SOURCE_TEXT = 20_000;
const MAX_PACKAGE_BYTES = 24 * 1024 * 1024;
const MAX_PARTS = 300;
const FONT_ALLOWLIST = new Set(["noto sans"]);
const bulletText = /^[•●▪◦‣*\-–]\s*/;

type XmlNode = XmlDomNode & { localName?: string; namespaceURI?: string; textContent: string };
type ZipObjectWithSize = JSZip.JSZipObject & { _data?: { uncompressedSize?: number; length?: number } };
type XmlProperties = { fontFamily?: string; fontSizePt?: number; bold: boolean; italic: boolean; color?: string };

export interface DocxFactSuggestion { text: string; sourceAnchorId: string }

function children(node: XmlDomNode): XmlNode[] { return Array.from(node.childNodes).filter((child) => child.nodeType === 1) as XmlNode[]; }
function descendants(node: XmlDomNode, localName: string): XmlNode[] { return Array.from((node as XmlDomElement).getElementsByTagNameNS(WORD_NS, localName)) as unknown as XmlNode[]; }
function first(node: XmlDomNode | undefined, localName: string): XmlNode | undefined { return node ? children(node).find((child) => child.namespaceURI === WORD_NS && child.localName === localName) : undefined; }
function attr(node: XmlDomNode | undefined, name: string): string | undefined { return (node as XmlDomElement | undefined)?.getAttributeNS(WORD_NS, name) ?? undefined; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function normalized(value: string): string { return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function ptFromTwips(value: string | undefined): number | undefined { const number = Number(value); return value && Number.isFinite(number) ? number / 20 : undefined; }
function ptFromHalfPoints(value: string | undefined): number | undefined { const number = Number(value); return value && Number.isFinite(number) ? number / 2 : undefined; }

function parseXml(value: string, label: string): XmlDomDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error(`${label} uses XML declarations outside the supported DOCX profile.`);
  const parser = new DOMParser({ onError: (level, message) => { if (level !== "warning") throw new Error(`${label} is malformed: ${message}`); } });
  const document = parser.parseFromString(value, "application/xml");
  if (!document.documentElement || document.documentElement.localName === "parsererror") throw new Error(`${label} is malformed XML.`);
  return document;
}

async function loadDocx(bytes: Buffer): Promise<JSZip> {
  if (bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error("Choose a DOCX résumé up to 5 MB.");
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes, { createFolders: false }); }
  catch { throw new Error("This DOCX package is invalid or damaged. Save it again as a standard .docx file, then retry."); }
  const files = Object.values(zip.files).filter((file) => !file.dir);
  const expandedSize = files.reduce((sum, file) => {
    const data = (file as ZipObjectWithSize)._data;
    return sum + (Number(data?.uncompressedSize ?? data?.length) || 0);
  }, 0);
  if (files.length > MAX_PARTS || expandedSize > MAX_PACKAGE_BYTES || files.some((file) => file.name.split("/").some((part) => part === ".."))) throw new Error("This DOCX package is too complex to inspect safely. Save a smaller, simpler .docx file and retry.");
  if (!zip.file("word/document.xml") || !zip.file("word/styles.xml")) throw new Error("This DOCX is missing its main document or styles. Save it again as a standard .docx file.");
  return zip;
}

async function unsafePackageReason(zip: JSZip): Promise<string | undefined> {
  const entries = Object.values(zip.files).filter((file) => !file.dir);
  if (entries.some((file) => /(?:vbaProject|activeX|embeddings|customUI|afchunk)/i.test(file.name))) return "This DOCX contains macros, embedded objects, or active content. Remove those parts before uploading a source-preserving résumé.";
  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  if (contentTypes && /macroEnabled|vbaProject|activeX/i.test(contentTypes)) return "This DOCX package declares macros or active content. Save it as a macro-free .docx file before uploading.";
  for (const file of entries.filter((part) => /\.xml$/i.test(part.name))) {
    const xml = await file.async("string");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return "This DOCX contains XML declarations outside the supported package profile.";
  }
  for (const file of entries.filter((part) => /\.rels$/i.test(part.name))) {
    const xml = await file.async("string");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return "This DOCX contains XML declarations outside the supported package profile.";
    const relations = parseXml(xml, file.name).getElementsByTagNameNS("*", "Relationship");
    for (let index = 0; index < relations.length; index++) {
      const relation = relations.item(index) as Element | null;
      if (relation?.getAttribute("TargetMode") === "External" && !/\/hyperlink$/i.test(relation.getAttribute("Type") ?? "")) return "This DOCX references an external package resource. Remove external linked content before uploading.";
    }
  }
  for (const file of entries.filter((part) => /^word\/(?:header|footer|footnotes|endnotes|comments)[^/]*\.xml$/i.test(part.name))) {
    const xml = await file.async("string");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return "This DOCX contains XML declarations outside the supported package profile.";
    const supplemental = parseXml(xml, file.name);
    if (/^word\/(?:footnotes|endnotes|comments)[^/]*\.xml$/i.test(file.name) && descendants(supplemental, "p").some((paragraph) => paragraphText(paragraph).trim()))
      return "This DOCX has visible notes or comments outside its inspectable document body. Move that content into ordinary body paragraphs.";
  }
  return undefined;
}

async function partXml(zip: JSZip, part: string): Promise<XmlDomDocument> {
  const file = zip.file(part);
  if (!file) throw new Error(`The DOCX is missing ${part}.`);
  return parseXml(await file.async("string"), part);
}

async function supplementaryTextParts(zip: JSZip, styles: ReturnType<typeof styleCatalog>): Promise<Array<{ partName: string; paragraphs: Array<{ text: string; font: XmlProperties }> }>> {
  const parts = Object.values(zip.files).filter((file) => !file.dir && /^word\/(?:header|footer|footnotes|endnotes|comments)[^/]*\.xml$/i.test(file.name));
  const result: Array<{ partName: string; paragraphs: Array<{ text: string; font: XmlProperties }> }> = [];
  for (const part of parts) {
    const document = parseXml(await part.async("string"), part.name);
    const paragraphs = descendants(document, "p").map((paragraph) => ({ text: paragraphText(paragraph), font: inheritedFontProperties(paragraph, styles) })).filter(({ text }) => text.trim());
    if (paragraphs.length) result.push({ partName: part.name, paragraphs });
  }
  return result;
}

function paragraphText(paragraph: XmlDomNode): string {
  const read = (node: XmlDomNode): string => {
    if (node.nodeType !== 1) return "";
    const item = node as XmlDomElement;
    if (item.namespaceURI === WORD_NS) {
      if (item.localName === "t" || item.localName === "delText" || item.localName === "instrText") return item.textContent ?? "";
      if (item.localName === "tab") return "\t";
      if (item.localName === "br" || item.localName === "cr") return "\n";
      if (item.localName === "noBreakHyphen") return "‑";
      if (item.localName === "softHyphen") return "\u00ad";
    }
    return Array.from(node.childNodes).map(read).join("");
  };
  return read(paragraph).replace(/\r/g, "").trim();
}

function styleCatalog(styles: XmlDomDocument) {
  const defaults = descendants(styles, "rPrDefault")[0];
  const byId = new Map<string, XmlNode>();
  for (const style of descendants(styles, "style")) {
    const id = attr(style, "styleId");
    if (id) byId.set(id, style);
  }
  const chain = (styleId: string | undefined): XmlNode[] => {
    const result: XmlNode[] = [];
    const seen = new Set<string>();
    let current = styleId;
    while (current && !seen.has(current) && result.length < 12) {
      seen.add(current);
      const style = byId.get(current);
      if (!style) break;
      result.push(style);
      current = attr(first(style, "basedOn")!, "val");
    }
    return result;
  };
  return { defaults, byId, chain };
}

function nodeFontProperties(node: XmlDomNode | undefined): XmlProperties {
  const rPr = node && ((node as XmlDomElement).localName === "rPr" ? node : first(node, "rPr"));
  const fonts = first(rPr!, "rFonts");
  const size = first(rPr!, "sz");
  const color = first(rPr!, "color");
  return {
    fontFamily: attr(fonts, "ascii") ?? attr(fonts, "hAnsi") ?? attr(fonts, "cs") ?? attr(fonts, "eastAsia"),
    fontSizePt: ptFromHalfPoints(attr(size, "val")),
    bold: Boolean(first(rPr!, "b")), italic: Boolean(first(rPr!, "i")),
    color: attr(color, "val")?.toLowerCase(),
  };
}

function inheritedFontProperties(paragraph: XmlDomNode, styles: ReturnType<typeof styleCatalog>): XmlProperties {
  const pPr = first(paragraph, "pPr");
  const styleId = attr(first(pPr!, "pStyle"), "val");
  const run = descendants(paragraph, "r")[0];
  const direct = nodeFontProperties(first(run!, "rPr"));
  const resolved: XmlProperties = { bold: direct.bold, italic: direct.italic };
  const candidates = [direct, ...styles.chain(styleId).map((style) => nodeFontProperties(style)), nodeFontProperties(styles.defaults)];
  for (const candidate of candidates) {
    resolved.fontFamily ??= candidate.fontFamily;
    resolved.fontSizePt ??= candidate.fontSizePt;
    resolved.bold ||= candidate.bold;
    resolved.italic ||= candidate.italic;
    resolved.color ??= candidate.color;
  }
  return resolved;
}

function paragraphStyle(paragraph: XmlDomNode, styles: ReturnType<typeof styleCatalog>) {
  const pPr = first(paragraph, "pPr");
  const styleId = attr(first(pPr!, "pStyle"), "val");
  const direct = first(pPr!, "spacing");
  const indent = first(pPr!, "ind");
  const inherited = styles.chain(styleId).map((style) => first(first(style, "pPr")!, "spacing"));
  const inheritedIndent = styles.chain(styleId).map((style) => first(first(style, "pPr")!, "ind"));
  const spacing = direct ?? inherited.find(Boolean);
  const spacingBefore = ptFromTwips(attr(spacing, "before"));
  const spacingAfter = ptFromTwips(attr(spacing, "after"));
  const alignment = attr(first(pPr!, "jc"), "val") ?? styles.chain(styleId).map((style) => attr(first(first(style, "pPr")!, "jc"), "val")).find(Boolean);
  const effectiveIndent = indent ?? inheritedIndent.find(Boolean);
  return {
    alignment,
    ...(spacingBefore !== undefined ? { beforePt: spacingBefore } : {}),
    ...(spacingAfter !== undefined ? { afterPt: spacingAfter } : {}),
    ...(ptFromTwips(attr(effectiveIndent, "left")) !== undefined ? { leftIndentPt: ptFromTwips(attr(effectiveIndent, "left")) } : {}),
    ...(ptFromTwips(attr(effectiveIndent, "right")) !== undefined ? { rightIndentPt: ptFromTwips(attr(effectiveIndent, "right")) } : {}),
    ...(ptFromTwips(attr(effectiveIndent, "firstLine")) !== undefined ? { firstLineIndentPt: ptFromTwips(attr(effectiveIndent, "firstLine")) } : {}),
    numbered: Boolean(first(pPr!, "numPr")) || Boolean(attr(first(pPr!, "pStyle"), "val")?.toLowerCase().includes("bullet")),
  };
}

function styleHash(paragraph: XmlDomNode): string {
  const clone = paragraph.cloneNode(true) as XmlDomElement;
  for (const textNode of descendants(clone, "t")) while (textNode.firstChild) textNode.removeChild(textNode.firstChild);
  return hash(new XMLSerializer().serializeToString(clone));
}

function hasUnsupportedStructure(document: XmlDomDocument): string | undefined {
  const checks: Array<[string, string]> = [
    ["tbl", "This DOCX uses a table layout, which the current one-column source editor cannot preserve safely."],
    ["txbxContent", "This DOCX contains text boxes. Put the text in ordinary paragraphs or upload another source."],
    ["drawing", "This DOCX contains floating or inline graphics that can change the résumé layout."],
    ["pict", "This DOCX contains legacy graphics that can change the résumé layout."],
    ["altChunk", "This DOCX embeds external or alternate content that cannot be inspected safely."],
    ["sectPrChange", "This DOCX contains tracked section-layout changes. Accept or reject them before uploading."],
    ["ins", "This DOCX contains tracked changes. Accept or reject them before uploading."],
    ["del", "This DOCX contains tracked deletions. Accept or reject them before uploading."],
    ["instrText", "This DOCX contains field instructions that cannot be edited safely."],
  ];
  for (const [name, reason] of checks) if (descendants(document, name).length) return reason;
  const sectionProperties = descendants(document, "sectPr");
  if (sectionProperties.length !== 1) return "This DOCX has multiple sections. The current source editor supports one section only.";
  const columns = first(sectionProperties[0], "cols");
  if (Number(attr(columns, "num") ?? "1") > 2 || descendants(sectionProperties[0], "col").length > 2)
    return "This DOCX uses more than two columns. The source editor supports up to two text columns per page.";
  return undefined;
}

function safeTextNodeShape(paragraph: XmlDomNode): boolean {
  const runs = children(paragraph).filter((node) => node.namespaceURI === WORD_NS && node.localName === "r");
  if (runs.length !== 1) return false;
  const runChildren = children(runs[0]);
  const textNodes = runChildren.filter((node) => node.namespaceURI === WORD_NS && node.localName === "t");
  return textNodes.length === 1 && runChildren.every((node) => node.namespaceURI === WORD_NS && ["rPr", "t"].includes(node.localName ?? ""));
}

export async function parseDocxSource(bytes: Buffer, trustedName?: string): Promise<DocxSourceRepresentation> { return parseDocxSourceAsync(bytes, trustedName); }

export async function parseDocxSourceAsync(bytes: Buffer, trustedName?: string): Promise<DocxSourceRepresentation> {
  const sourceHash = bytesHash(bytes);
  const zip = await loadDocx(bytes);
  const document = await partXml(zip, "word/document.xml");
  const styles = styleCatalog(await partXml(zip, "word/styles.xml"));
  const body = descendants(document, "body")[0];
  if (!body) throw new Error("This DOCX has no document body. Save it again as a standard .docx file.");
  const supplementary = await supplementaryTextParts(zip, styles);
  let reason = await unsafePackageReason(zip) ?? hasUnsupportedStructure(document);
  const sectionProperties = descendants(document, "sectPr")[0];
  const pageSize = first(sectionProperties!, "pgSz");
  const pageMargins = first(sectionProperties!, "pgMar");
  const width = ptFromTwips(attr(pageSize, "w"));
  const height = ptFromTwips(attr(pageSize, "h"));
  if (!width || !height || !pageMargins) reason ??= "This DOCX does not declare a page size and margins that can be checked.";
  const paragraphs = descendants(body, "p");
  if (!paragraphs.length) throw new Error("This DOCX has no readable paragraphs. Add text or upload an editable résumé.");
  const records: Array<{ paragraphIndex: number; paragraph: XmlNode; text: string; style: ReturnType<typeof paragraphStyle>; font: XmlProperties; pStyle?: string; bullet: boolean }> = [];
  const fontFamilies = new Set<string>();
  const textLines: string[] = [];
  for (let sourceParagraphIndex = 0; sourceParagraphIndex < paragraphs.length; sourceParagraphIndex++) {
    const paragraph = paragraphs[sourceParagraphIndex];
    const text = paragraphText(paragraph);
    if (!text) continue;
    if (text.includes("\u0000")) continue;
    const style = paragraphStyle(paragraph, styles);
    const font = inheritedFontProperties(paragraph, styles);
    const styleId = attr(first(first(paragraph, "pPr")!, "pStyle"), "val");
    const styleName = styleId ? attr(first(styles.byId.get(styleId)!, "name"), "val") ?? styleId : "";
    const bullet = style.numbered || bulletText.test(text);
    records.push({ paragraphIndex: sourceParagraphIndex, paragraph, text: text.replace(bulletText, ""), style, font, pStyle: styleName, bullet });
    textLines.push(text.replace(bulletText, ""));
    if (font.fontFamily) fontFamilies.add(font.fontFamily);
    else reason ??= `Paragraph “${text.slice(0, 80)}” has no explicit font declaration; upload a DOCX with declared source fonts.`;
    if (!font.fontSizePt) reason ??= `Paragraph “${text.slice(0, 80)}” has no explicit font size that can be checked.`;
    if (font.italic) reason ??= `Paragraph “${text.slice(0, 80)}” uses an italic font face that is not included in the pinned source font set.`;
  }
  for (const part of supplementary) for (const { font } of part.paragraphs) {
    if (font.fontFamily) fontFamilies.add(font.fontFamily);
    else reason ??= `Repeated ${/\/header/i.test(part.partName) ? "header" : "footer"} text has no explicit font declaration; upload a DOCX with declared source fonts.`;
    if (!font.fontSizePt) reason ??= `Repeated ${/\/header/i.test(part.partName) ? "header" : "footer"} text has no explicit font size that can be checked.`;
    if (font.italic) reason ??= `Repeated ${/\/header/i.test(part.partName) ? "header" : "footer"} text uses an italic font face that is not included in the pinned source font set.`;
  }
  const unsupportedFonts = [...fontFamilies].filter((family) => !FONT_ALLOWLIST.has(family.toLowerCase()));
  if (unsupportedFonts.length) reason ??= `This DOCX uses ${unsupportedFonts.join(", ")}, which is not in the pinned supported font set (Noto Sans). Choose an available source font or upload another DOCX; the source font will not be substituted.`;
  const sections: DocxSourceRepresentation["sections"] = [];
  const anchors: DocxSourceAnchor[] = [];
  let activeSection: { id: string; heading: string; anchorIds: string[] } = { id: `section-${hash(`${sourceHash}:default`).slice(0, 12)}`, heading: "Résumé", anchorIds: [] };
  let currentEntryId = `entry-${hash(`${sourceHash}:preamble`).slice(0, 12)}`;
  let currentEntryHeading = "Résumé details";
  let entryHasBullet = false;
  for (let paragraphIndex = 0; paragraphIndex < records.length; paragraphIndex++) {
    const record = records[paragraphIndex];
    const semanticHeading = isResumeSectionHeading(record.text);
    const isHeading = semanticHeading || /^heading\s*\d/i.test(record.pStyle ?? "");
    const isBullet = record.bullet;
    if (isHeading) {
      activeSection = { id: `section-${hash(`${sourceHash}:${paragraphIndex}:${record.text}`).slice(0, 12)}`, heading: record.text.replace(/:$/, ""), anchorIds: [] };
      sections.push(activeSection);
      currentEntryId = `entry-${hash(`${activeSection.id}:intro`).slice(0, 12)}`;
      currentEntryHeading = activeSection.heading;
      entryHasBullet = false;
    } else if (!isBullet && (entryHasBullet || currentEntryHeading === "Résumé details" || currentEntryHeading === activeSection.heading)) {
      currentEntryId = `entry-${hash(`${activeSection.id}:${paragraphIndex}:${record.text}`).slice(0, 12)}`;
      currentEntryHeading = record.text;
      entryHasBullet = false;
    } else if (!isBullet && !entryHasBullet && currentEntryHeading !== "Résumé details" && currentEntryHeading !== activeSection.heading) {
      currentEntryHeading = `${currentEntryHeading} · ${record.text}`;
    }
    const kind: DocxSourceAnchor["kind"] = isHeading ? "section" : isBullet ? "bullet" : "entry";
    const candidateClaim = isSubstantiveSourceText(record.text, { isSection: semanticHeading, firstBodyParagraph: paragraphIndex === 0, trustedName });
    const editable = kind === "bullet" && safeTextNodeShape(record.paragraph) && record.font.fontFamily !== undefined && record.font.fontSizePt !== undefined;
    if (candidateClaim && kind === "bullet" && !editable) reason ??= `Claim paragraph “${record.text.slice(0, 80)}” uses mixed or complex inline formatting. Use one uniform text style per bullet or upload another DOCX.`;
    const paragraphFingerprint = styleHash(record.paragraph);
    const id = `docx:${sourceHash.slice(0, 12)}:word/document.xml:${record.paragraphIndex}:${hash(`${record.text}:${paragraphFingerprint}`).slice(0, 12)}`;
    const anchor: DocxSourceAnchor = {
      id, partName: "word/document.xml", paragraphIndex: record.paragraphIndex, text: record.text, sectionId: activeSection.id, sectionHeading: activeSection.heading,
      entryId: currentEntryId, entryHeading: currentEntryHeading, kind, candidateClaim, editable,
      styleHash: paragraphFingerprint, paragraphStyle: record.style,
      ...(record.font.fontFamily && record.font.fontSizePt ? { font: { family: record.font.fontFamily, sizePt: record.font.fontSizePt, bold: record.font.bold, italic: record.font.italic, ...(record.font.color ? { color: record.font.color } : {}) } } : {}),
    };
    anchors.push(anchor);
    activeSection.anchorIds.push(id);
    if (isBullet) entryHasBullet = true;
  }
  for (const part of supplementary) {
    const sectionId = `section-${hash(`${sourceHash}:${part.partName}`).slice(0, 12)}`;
    const section = { id: sectionId, heading: part.partName, anchorIds: [] as string[] };
    sections.push(section);
    for (let paragraphIndex = 0; paragraphIndex < part.paragraphs.length; paragraphIndex++) {
      const { text, font } = part.paragraphs[paragraphIndex];
      const entryId = `entry-${hash(`${sectionId}:${paragraphIndex}`).slice(0, 12)}`;
      const id = `docx:${sourceHash.slice(0, 12)}:${hash(`${part.partName}:${paragraphIndex}:${text}`).slice(0, 24)}`;
      const repeatedRole = /\/header[^/]*\.xml$/i.test(part.partName) ? "header" as const : /\/footer[^/]*\.xml$/i.test(part.partName) ? "footer" as const : undefined;
      anchors.push({ id, partName: part.partName, paragraphIndex, text, sectionId, sectionHeading: part.partName, entryId, entryHeading: part.partName,
        kind: "paragraph", candidateClaim: isSubstantiveSourceText(text, { firstBodyParagraph: paragraphIndex === 0, trustedName }), editable: false, ...(repeatedRole ? { repeatedRole } : {}), styleHash: hash(`${part.partName}:${paragraphIndex}:${text}`), paragraphStyle: { numbered: false },
        ...(font.fontFamily && font.fontSizePt ? { font: { family: font.fontFamily, sizePt: font.fontSizePt, bold: font.bold, italic: font.italic, ...(font.color ? { color: font.color } : {}) } } : {}) });
      section.anchorIds.push(id);
      textLines.push(text);
    }
  }
  if (!sections.length) sections.push(activeSection);
  if (!anchors.some((anchor) => anchor.candidateClaim)) reason ??= "This DOCX has no clearly separated résumé claim paragraphs to extract and preserve. Add ordinary experience, project, or education paragraphs before tailoring.";
  const completeText = textLines.join("\n").trim();
  if (!completeText) throw new Error("This DOCX has no readable text. Add facts manually in your profile.");
  if (completeText.length > MAX_SOURCE_TEXT) throw new Error(`This DOCX contains ${completeText.length.toLocaleString()} readable characters, above the ${MAX_SOURCE_TEXT.toLocaleString()}-character source-context limit. Shorten the résumé or upload a supported version; no text was dropped.`);
  return {
    version: 1, parser: "docx-ooxml-1", format: "docx", sourceHash, text: completeText,
    support: reason ? { status: "blocked", reason } : { status: "candidate" },
    layout: {
      columns: Number(attr(first(sectionProperties!, "cols"), "num") ?? "1"), sectionCount: descendants(document, "sectPr").length,
      pageSizePt: { width: width ?? 0, height: height ?? 0 },
      marginsPt: { top: ptFromTwips(attr(pageMargins, "top")) ?? 0, right: ptFromTwips(attr(pageMargins, "right")) ?? 0, bottom: ptFromTwips(attr(pageMargins, "bottom")) ?? 0, left: ptFromTwips(attr(pageMargins, "left")) ?? 0 },
      fontFamilies: [...fontFamilies].sort(),
    }, sections, anchors,
  };
}

export function suggestDocxFacts(source: DocxSourceRepresentation): DocxFactSuggestion[] {
  const suggestions: DocxFactSuggestion[] = [];
  for (const anchor of source.anchors.filter((item) => item.candidateClaim)) {
    const text = normalized([anchor.sectionHeading, anchor.entryHeading, anchor.text].filter(Boolean).join(" · "));
    if (text.length >= 25 && text.length <= 500) suggestions.push({ text, sourceAnchorId: anchor.id });
  }
  return suggestions;
}

export async function applyDocxEdits(bytes: Buffer, source: DocxSourceRepresentation, edits: ResumeSourceEdit[], facts: VerifiedFact[]): Promise<Buffer> {
  if (bytesHash(bytes) !== source.sourceHash || source.version !== 1 || source.format !== "docx") throw new Error("The original DOCX no longer matches its inspected source. Upload it again.");
  if (source.support.status !== "candidate") throw new Error(source.support.reason ?? "This DOCX layout is unsupported. Upload a DOCX with supported fonts and no more than two columns; the renderer checks its actual page count (up to eight pages).");
  if (!Array.isArray(edits) || edits.length > source.anchors.length) throw new Error("The source edit plan is invalid.");
  const byId = new Map(source.anchors.map((anchor) => [anchor.id, anchor]));
  const factsById = new Map(facts.filter((fact) => isUsableFact(fact)).map((fact) => [fact.id, fact]));
  const seen = new Set<string>();
  for (const edit of edits) {
    const target = byId.get(edit.anchorId);
    if (!target || target.partName !== "word/document.xml" || !target.editable || target.kind !== "bullet" || seen.has(edit.anchorId)) throw new Error("The source edit plan includes a nonexistent or unsupported target.");
    if (!edit.text.trim() || edit.text.length > 500 || /[\u0000\r]/.test(edit.text) || !edit.factIds.length || new Set(edit.factIds).size !== edit.factIds.length) throw new Error("A source edit needs readable text and unique confirmed evidence IDs.");
    for (const factId of edit.factIds) {
      const fact = factsById.get(factId);
      if (!fact) throw new Error("A source edit cites a fact that has not been confirmed.");
      if (fact.grounding && fact.grounding.sourceHash !== source.sourceHash) throw new Error("A source edit cites stale resume evidence.");
      for (const anchorId of factAnchorIds(fact)) {
        const evidenceAnchor = byId.get(anchorId);
        if (!evidenceAnchor || !evidenceBelongsToEntry(evidenceAnchor, target)) throw new Error("A source edit cites evidence from a different source entry.");
      }
    }
    seen.add(edit.anchorId);
  }
  const zip = await loadDocx(bytes);
  const document = await partXml(zip, "word/document.xml");
  const body = descendants(document, "body")[0];
  const paragraphs = descendants(body, "p");
  for (const edit of edits) {
    const target = byId.get(edit.anchorId)!;
    const paragraph = paragraphs[target.paragraphIndex];
    if (!paragraph || styleHash(paragraph) !== target.styleHash || normalized(paragraphText(paragraph).replace(bulletText, "")) !== normalized(target.text)) throw new Error("A source paragraph changed after inspection. Upload the original DOCX again.");
    const textNode = descendants(paragraph, "t")[0];
    if (!textNode) throw new Error("This source paragraph is no longer safely editable.");
    while (textNode.firstChild) textNode.removeChild(textNode.firstChild);
    textNode.appendChild(document.createTextNode(edit.text));
  }
  const xml = new XMLSerializer().serializeToString(document);
  zip.file("word/document.xml", xml);
  const result = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (result.length > 5 * 1024 * 1024) throw new Error("The tailored DOCX exceeds the 5 MB artifact limit. Shorten the edited wording and retry.");
  const inspectedResult = await parseDocxSource(result);
  if (inspectedResult.anchors.length !== source.anchors.length || inspectedResult.support.status !== "candidate") throw new Error("The tailored DOCX changed its source structure or no longer fits the supported profile.");
  const editByAnchor = new Map(edits.map((edit) => [edit.anchorId, edit]));
  for (const original of source.anchors) {
    const revised = inspectedResult.anchors.find((anchor) => anchor.partName === original.partName && anchor.paragraphIndex === original.paragraphIndex);
    const edit = editByAnchor.get(original.id);
    if (!revised || revised.styleHash !== original.styleHash || revised.kind !== original.kind || revised.sectionHeading !== original.sectionHeading || revised.entryHeading !== original.entryHeading ||
      revised.text !== (edit?.text ?? original.text)) throw new Error("The tailored DOCX changed text, styling, section order, or entry association outside the authorized edits.");
  }
  return result;
}
