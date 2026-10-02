import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "@/lib/pdfjs-runtime";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { hashJson } from "@/lib/crypto";
import { bytesHash } from "@/lib/resume-artifacts";
import { readablePdfFontFamily } from "@/lib/pdf-fonts";
import { parsePdfSource } from "@/lib/pdf-source";
import { mapDocxSourceToPdfLayout } from "@/lib/docx-source-layout";
import { sourceLayoutHash } from "@/lib/resume-source-layout";
import { ResumeLayoutFeedbackError } from "@/lib/resume-layout-feedback";
import { originalResumeManifest, readOriginalResume } from "@/lib/original-resume";
import { applyDocxEdits, parseDocxSource } from "@/lib/docx-source";
import { ResumeDraftError } from "@/lib/resume-document";
import { sourceProfileHash } from "@/lib/resume-source-draft";
import { planEvidencePolicy, sourceEvidenceAnchors } from "@/lib/source-plan-evidence";
import type { DocxSourceRepresentation, Profile, ResumePageValidation, ResumeSourceLayoutMap, ResumeSourcePlan, VerifiedFact } from "@/lib/types";

const execute = promisify(execFile);
const PDF_BYTES_LIMIT = 5 * 1024 * 1024;
const OUTSIDE_PIXEL_DIFFERENCE_LIMIT = 0.001;
const unchangedGeometryTolerancePt = 1;
const pageSizeTolerancePt = 0.5;
const expectedVersion = () => process.env.DOCX_RENDERER_VERSION || "26.8.0.3";
const rendererName = () => `libreoffice-${expectedVersion()}`;
type PdfBox = { left: number; top: number; right: number; bottom: number };
type PdfTextAnchor = { text: string; box: PdfBox; fontFamilies: string[]; fontSizes: number[] };
type PdfPageLayout = { width: number; height: number; anchors: PdfTextAnchor[] };

export interface PreparedDocxResumeBaseline {
  sourceHash: string;
  layoutHash: string;
  sourceLayout: ResumeSourceLayoutMap;
  baselinePdf: Buffer;
  rendererVersion: string;
}

function timeoutMs(deadline: number, perProcess = 30_000) {
  const remaining = Math.min(perProcess, deadline - Date.now());
  if (remaining < 1_000) throw new Error("DOCX rendering timed out. Retry the draft; the last valid packet is preserved.");
  return remaining;
}

function runtimePath() { return process.env.SOFFICE_BIN || "/usr/bin/soffice"; }
function minimalEnvironment(directory: string): NodeJS.ProcessEnv {
  return { NODE_ENV: process.env.NODE_ENV ?? "production", PATH: "/usr/bin:/bin", HOME: directory, TMPDIR: directory, XDG_CACHE_HOME: path.join(directory, "cache"),
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", ...(process.env.FONTCONFIG_PATH ? { FONTCONFIG_PATH: process.env.FONTCONFIG_PATH } : process.platform === "linux" ? { FONTCONFIG_PATH: "/etc/fonts" } : {}),
    ...(process.env.FONTCONFIG_FILE ? { FONTCONFIG_FILE: process.env.FONTCONFIG_FILE } : process.platform === "linux" ? { FONTCONFIG_FILE: "/etc/fonts/fonts.conf" } : {}) };
}

async function assertPinnedRuntime(directory: string, deadline: number) {
  const env = minimalEnvironment(directory);
  try {
    const { stdout } = await execute(runtimePath(), ["--version"], { env, timeout: timeoutMs(deadline, 8_000), killSignal: "SIGKILL", maxBuffer: 8192 });
    const expected = expectedVersion();
    const executableVersionPrefix = expected.includes("alpha") ? "LibreOfficeDev" : "LibreOffice";
    if (!new RegExp(`^${executableVersionPrefix} ${expected.replaceAll(".", "\\.")}(?:\\s|$)`).test(stdout.trim())) throw new Error("The pinned LibreOffice version is not installed.");
    if (process.platform === "linux") {
      const { stdout: font } = await execute("/usr/bin/fc-match", ["--format", "%{family}\\n", "Noto Sans"], { env, timeout: timeoutMs(deadline, 5_000), killSignal: "SIGKILL", maxBuffer: 8192 });
      if (!font.trim().split(",").map((family) => family.trim().toLowerCase()).includes("noto sans")) throw new Error("The pinned Noto Sans font is not installed.");
    }
    return stdout.trim().split("\n")[0].trim();
  } catch (error) {
    if (error instanceof Error && /pinned LibreOffice|pinned Noto Sans/.test(error.message)) throw error;
    throw new Error("The pinned DOCX renderer is unavailable. Retry after the worker runtime is repaired.");
  }
}

async function convertDocx(directory: string, docx: Buffer, name: string, deadline: number): Promise<Buffer> {
  const input = path.join(directory, `${name}.docx`);
  const outputDir = path.join(directory, "pdf");
  const profileDir = path.join(directory, "lo-profile");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(input, docx, { mode: 0o600, flag: "wx" });
  const profileUrl = `file://${profileDir}`;
  try {
    await execute(runtimePath(), ["--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--nolockcheck", `-env:UserInstallation=${profileUrl}`,
      "--convert-to", "pdf:writer_pdf_Export", "--outdir", outputDir, input], {
      cwd: directory, env: minimalEnvironment(directory), timeout: timeoutMs(deadline), killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("LibreOffice could not render this DOCX. Check its layout and fonts, then upload a supported DOCX with no more than eight pages; the existing packet is preserved.");
  }
  let pdf: Buffer;
  try { pdf = await readFile(path.join(outputDir, `${name}.pdf`)); }
  catch { throw new Error("LibreOffice did not produce a readable PDF. Upload a supported DOCX with no more than eight pages and retry."); }
  if (pdf.length < 100 || pdf.length > PDF_BYTES_LIMIT || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The rendered résumé exceeds the PDF limit or is not a valid PDF.");
  return pdf;
}

function normalize(value: string) { return value.normalize("NFKC").replace(/[\u00a0\u200b]/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }
function isTextItem(item: unknown): item is TextItem { return Boolean(item && typeof item === "object" && "str" in item && "transform" in item && "fontName" in item); }

async function readPdfLayout(pdfBytes: Buffer): Promise<PdfPageLayout[]> {
  const loadingTask = getDocument({ data: new Uint8Array(pdfBytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: false, stopAtErrors: true });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  try {
    pdf = await loadingTask.promise;
    const pages: PdfPageLayout[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      if (page.rotate !== 0) throw new Error("Rotated page text is outside the supported DOCX layout profile.");
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ includeMarkedContent: false });
      await page.getOperatorList({ intent: "display" });
      const commonObjects = (page as unknown as { commonObjs: { get(name: string): { name?: string } } }).commonObjs;
      const items = content.items.filter(isTextItem);
      const anchors = items.map((item) => {
        const a = item.transform[0];
        const b = item.transform[1];
        const x = item.transform[4];
        const y = item.transform[5];
        const fontSize = Math.hypot(a, b);
        if (Math.abs(b) > 0.01) throw new Error("Rotated text is outside the supported DOCX layout profile.");
        const style = content.styles[item.fontName];
        let embeddedFontName = "";
        try { embeddedFontName = commonObjects.get(item.fontName).name ?? ""; }
        catch { /* The strict family comparison below rejects an unresolved descriptor. */ }
        const resolvedFamily = embeddedFontName ? readablePdfFontFamily(embeddedFontName) : "";
        return { text: normalize(item.str), box: { left: x, top: viewport.height - y - item.height, right: x + item.width, bottom: viewport.height - y },
          fontFamilies: [resolvedFamily || style?.fontFamily || ""], fontSizes: [fontSize] };
      }).filter((item) => item.text);
      pages.push({ width: viewport.width, height: viewport.height, anchors });
      page.cleanup();
    }
    return pages;
  } finally { await loadingTask.destroy(); }
}

function locateAnchor(pages: PdfPageLayout[], anchorText: string, pageNumber?: number): { page: PdfPageLayout; pageNumber: number; box: PdfBox; fontFamilies: string[]; fontSizes: number[] } {
  const needle = normalize(anchorText);
  const matches: Array<{ page: PdfPageLayout; pageNumber: number; box: PdfBox; fontFamilies: string[]; fontSizes: number[] }> = [];
  for (const [index, page] of pages.entries()) {
    if (pageNumber !== undefined && pageNumber !== index + 1) continue;
    const ranges: Array<{ item: PdfTextAnchor; start: number; end: number }> = [];
    let joined = "";
    for (const item of page.anchors) {
      if (joined) joined += " ";
      const start = joined.length;
      joined += item.text;
      ranges.push({ item, start, end: joined.length });
    }
    let cursor = joined.indexOf(needle);
    while (cursor !== -1) {
      const end = cursor + needle.length;
      const selected = ranges.filter((range) => range.end > cursor && range.start < end).map((range) => range.item);
      if (selected.length) matches.push({ page, pageNumber: index + 1, box: { left: Math.min(...selected.map((item) => item.box.left)), top: Math.min(...selected.map((item) => item.box.top)),
        right: Math.max(...selected.map((item) => item.box.right)), bottom: Math.max(...selected.map((item) => item.box.bottom)) },
        fontFamilies: [...new Set(selected.flatMap((item) => item.fontFamilies))], fontSizes: selected.map((item) => item.fontSizes[0]) });
      cursor = joined.indexOf(needle, end);
    }
  }
  if (matches.length !== 1) throw new Error(`The rendered DOCX text “${anchorText.slice(0, 70)}” could not be matched to one source paragraph. Remove duplicate or complex text and retry.`);
  return matches[0];
}

function near(left: number, right: number, tolerance: number) { return Math.abs(left - right) <= tolerance; }
function layoutFeedback(plan: ResumeSourcePlan, sourceLayout: ResumeSourceLayoutMap, reason: string, pageNumber?: number, regionId?: string): ResumeLayoutFeedbackError | undefined {
  const edits = plan.edits.filter((candidate) => sourceLayout.anchors.some((anchor) => anchor.anchorId === candidate.anchorId &&
    (pageNumber === undefined || anchor.pageNumber === pageNumber) && (regionId === undefined || anchor.regionId === regionId)));
  if (edits.length !== 1) return undefined;
  const edit = edits[0];
  if (!edit) return undefined;
  const anchor = sourceLayout.anchors.find((candidate) => candidate.anchorId === edit.anchorId &&
    (pageNumber === undefined || candidate.pageNumber === pageNumber) && (regionId === undefined || candidate.regionId === regionId));
  return anchor ? new ResumeLayoutFeedbackError({ anchorId: edit.anchorId, pageNumber: anchor.pageNumber, regionId: anchor.regionId, reason }) : undefined;
}

function validatePageDimensions(sourceLayout: ResumeSourceLayoutMap, baseline: PdfPageLayout[], final: PdfPageLayout[], plan: ResumeSourcePlan) {
  if (baseline.length !== sourceLayout.pages.length) throw new Error("The untouched DOCX baseline does not match its complete source page map. Re-upload the DOCX after checking its page breaks.");
  if (final.length !== baseline.length) {
    const feedback = layoutFeedback(plan, sourceLayout, `The revised DOCX renders to ${final.length} pages instead of the original ${baseline.length}.`, Math.min(final.length, baseline.length));
    if (feedback) throw feedback;
    throw new Error(`The revised DOCX renders to ${final.length} pages instead of the original ${baseline.length}. Shorten the edited wording or restore the original page breaks.`);
  }
  for (const [index, page] of baseline.entries()) {
    const expected = sourceLayout.pages[index];
    const finalPage = final[index];
    if (!near(page.width, expected.widthPt, pageSizeTolerancePt) || !near(page.height, expected.heightPt, pageSizeTolerancePt))
      throw new Error(`LibreOffice baseline page ${index + 1} differs from the inspected source page geometry. Re-upload a stable DOCX layout.`);
    if (!near(finalPage.width, page.width, pageSizeTolerancePt) || !near(finalPage.height, page.height, pageSizeTolerancePt)) {
      const feedback = layoutFeedback(plan, sourceLayout, `The edited document changed page ${index + 1} dimensions.`, index + 1);
      if (feedback) throw feedback;
      throw new Error(`LibreOffice changed page ${index + 1} dimensions beyond the 0.5 pt tolerance.`);
    }
  }
}

function pixelIndex(x: number, y: number, width: number) { return (Math.floor(y) * width + Math.floor(x)) * 4; }
async function screenshots(parser: PDFParse, pageCount: number) {
  const result = await parser.getScreenshot({ scale: 1, imageBuffer: true, imageDataUrl: false, first: 1, last: pageCount });
  return Promise.all(result.pages.map(async (page) => {
    const image = await loadImage(Buffer.from(page.data));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return { pageNumber: page.pageNumber, width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
  }));
}
async function validateVisualDifference(baselinePdf: Buffer, finalPdf: Buffer, source: DocxSourceRepresentation, sourceLayout: ResumeSourceLayoutMap, changedIds: Set<string>, baselineLayout: PdfPageLayout[], plan: ResumeSourcePlan): Promise<ResumePageValidation[]> {
  const baselineParser = new PDFParse({ data: baselinePdf });
  const finalParser = new PDFParse({ data: finalPdf });
  try {
    const [originalPages, revisedPages] = await Promise.all([screenshots(baselineParser, sourceLayout.pages.length), screenshots(finalParser, sourceLayout.pages.length)]);
    if (originalPages.length !== sourceLayout.pages.length || revisedPages.length !== sourceLayout.pages.length) throw new Error("A rendered page image is missing from the all-page comparison.");
    const validations: ResumePageValidation[] = [];
    for (const [index, original] of originalPages.entries()) {
      const revised = revisedPages[index];
      const page = sourceLayout.pages[index];
      if (original.pageNumber !== page.pageNumber || revised.pageNumber !== page.pageNumber || original.width !== revised.width || original.height !== revised.height)
        throw new Error(`Rendered page ${index + 1} image dimensions changed.`);
      const masks = sourceLayout.anchors.filter((anchor) => changedIds.has(anchor.anchorId) && anchor.pageNumber === page.pageNumber).map((mapping) => {
        const sourceAnchor = source.anchors.find((anchor) => anchor.id === mapping.anchorId);
        const region = page.regions.find((item) => item.id === mapping.regionId);
        if (!sourceAnchor || !region) throw new Error("An edited DOCX paragraph is missing its source region.");
        const baseline = locateAnchor(baselineLayout, sourceAnchor.text, page.pageNumber);
        return { left: Math.max(0, baseline.box.left - 2), top: Math.max(0, baseline.box.top - 2),
          right: Math.min(original.width, region.bounds.right), bottom: Math.min(original.height, baseline.box.bottom + 2) };
      });
      let changedOutside = 0;
      let comparedOutside = 0;
      for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
        if (masks.some((mask) => x >= mask.left && x <= mask.right && y >= mask.top && y <= mask.bottom)) continue;
        comparedOutside++;
        const pixel = pixelIndex(x, y, original.width);
        if (Math.abs(original.data[pixel] - revised.data[pixel]) > 8 || Math.abs(original.data[pixel + 1] - revised.data[pixel + 1]) > 8 || Math.abs(original.data[pixel + 2] - revised.data[pixel + 2]) > 8) changedOutside++;
      }
      const fraction = comparedOutside ? changedOutside / comparedOutside : 1;
      if (fraction > OUTSIDE_PIXEL_DIFFERENCE_LIMIT) {
        const feedback = layoutFeedback(plan, sourceLayout, "The revised paragraph changed visual content outside its original page region.", page.pageNumber);
        if (feedback) throw feedback;
        throw new Error(`The rendered page ${page.pageNumber} changed outside edited lines (${(fraction * 100).toFixed(3)}%; limit 0.100%).`);
      }
      validations.push({ ...page, visualOutsideEditDifference: fraction });
    }
    return validations;
  } finally { await baselineParser.destroy(); await finalParser.destroy(); }
}

function validateAnchorGeometry(source: DocxSourceRepresentation, sourceLayout: ResumeSourceLayoutMap, baseline: PdfPageLayout[], final: PdfPageLayout[], plan: ResumeSourcePlan) {
  const editById = new Map(plan.edits.map((edit) => [edit.anchorId, edit]));
  const changed = new Set<string>();
  for (const anchor of source.anchors) {
    const replacement = editById.get(anchor.id);
    const mappings = sourceLayout.anchors.filter((mapping) => mapping.anchorId === anchor.id);
    const repeated = "repeatedRole" in anchor && (anchor.repeatedRole === "header" || anchor.repeatedRole === "footer");
    if (!mappings.length || (repeated ? mappings.length !== sourceLayout.pages.length : mappings.length !== 1)) throw new Error("A DOCX source paragraph is missing a unique all-page location.");
    for (const mapping of mappings) {
      const region = sourceLayout.pages[mapping.pageNumber - 1]?.regions.find((item) => item.id === mapping.regionId);
      if (!region) throw new Error("A DOCX source paragraph maps to a missing page region.");
      const before = locateAnchor(baseline, anchor.text, mapping.pageNumber);
      let after: ReturnType<typeof locateAnchor>;
      try { after = locateAnchor(final, replacement?.text ?? anchor.text, mapping.pageNumber); }
      catch {
        if (replacement) throw new ResumeLayoutFeedbackError({ anchorId: anchor.id, pageNumber: mapping.pageNumber, regionId: mapping.regionId, reason: "The revised wording no longer fits on its original page." });
        throw new Error(`Unchanged source paragraph “${anchor.text.slice(0, 70)}” moved from page ${mapping.pageNumber}.`);
      }
      const insideRegion = (box: PdfBox) => box.left >= region.bounds.left - 0.5 && box.right <= region.bounds.right + 0.5 &&
        box.top >= region.bounds.top - 0.5 && box.bottom <= region.bounds.bottom + 0.5;
      if (!insideRegion(before.box)) throw new Error(`Baseline paragraph “${anchor.text.slice(0, 70)}” falls outside its mapped page region.`);
      const beforeFont = anchor.font?.family.toLowerCase();
      const afterFonts = after.fontFamilies.map((family) => family.toLowerCase());
      if (!beforeFont || afterFonts.some((family) => family !== beforeFont)) throw new Error(`The rendered paragraph “${anchor.text.slice(0, 70)}” uses ${afterFonts.join(", ") || "an unknown font"} instead of source font ${beforeFont || "unknown"}. Upload a DOCX using the pinned Noto Sans source font.`);
      if (after.fontSizes.some((size) => Math.abs(size - (anchor.font?.sizePt ?? 0)) > 0.5)) throw new Error(`The rendered paragraph “${anchor.text.slice(0, 70)}” changed font size by more than 0.5 pt.`);
      if (!insideRegion(after.box)) {
        if (replacement) throw new ResumeLayoutFeedbackError({ anchorId: anchor.id, pageNumber: mapping.pageNumber, regionId: mapping.regionId, reason: "The revised wording crosses its original page or column region." });
        throw new Error(`Unchanged source paragraph “${anchor.text.slice(0, 70)}” moved outside its original page region.`);
      }
      if (!replacement) {
        if (!near(before.box.left, after.box.left, unchangedGeometryTolerancePt) || !near(before.box.top, after.box.top, unchangedGeometryTolerancePt) ||
          !near(before.box.right, after.box.right, unchangedGeometryTolerancePt) || !near(before.box.bottom, after.box.bottom, unchangedGeometryTolerancePt) ||
          before.fontFamilies.join("\0") !== after.fontFamilies.join("\0") || before.fontSizes.some((size, index) => !near(size, after.fontSizes[index] ?? 0, 0.1))) {
          const feedback = layoutFeedback(plan, sourceLayout, "An unchanged paragraph shifted after the revised wording.", mapping.pageNumber, mapping.regionId);
          if (feedback) throw feedback;
          throw new Error(`Unchanged source paragraph “${anchor.text.slice(0, 70)}” moved or changed typography beyond the 1 pt layout tolerance.`);
        }
      } else {
        if (after.box.left < before.box.left - 1 || after.box.top < before.box.top - 1 || after.box.bottom > before.box.bottom + 1)
          throw new ResumeLayoutFeedbackError({ anchorId: anchor.id, pageNumber: mapping.pageNumber, regionId: mapping.regionId, reason: `The wording does not fit the original paragraph bounds under “${anchor.entryHeading}”.` });
        changed.add(anchor.id);
      }
    }
  }
  return changed;
}

export interface RenderedDocxResume {
  pdf: Buffer;
  baselinePdf: Buffer;
  docx: Buffer;
  renderer: string;
  rendererVersion: string;
  baselinePdfHash: string;
  pageWidthPt: number;
  pageHeightPt: number;
  pageCount: number;
  pages: ResumePageValidation[];
  sourceLayout: ResumeSourceLayoutMap;
  layoutHash: string;
  visualOutsideEditDifference: number;
}

export async function prepareDocxResumeBaseline(originalBytes: Buffer, source: DocxSourceRepresentation, deadline = Date.now() + 90_000, beforeProcess?: () => Promise<void>, trustedName?: string): Promise<PreparedDocxResumeBaseline> {
  if (bytesHash(originalBytes) !== source.sourceHash || source.support.status !== "candidate") throw new Error("The inspected DOCX source is stale or unsupported. Upload and inspect the original again.");
  const currentSource = await parseDocxSource(originalBytes, trustedName);
  if (currentSource.support.status !== "candidate") throw new Error(currentSource.support.reason ?? "The inspected DOCX source is unsupported. Upload and inspect the original again.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "apply-docx-baseline-"));
  try {
    const rendererVersion = await assertPinnedRuntime(directory, deadline);
    await beforeProcess?.();
    const baselinePdf = await convertDocx(directory, originalBytes, "baseline", deadline);
    const parsedBaseline = await parsePdfSource(baselinePdf, trustedName);
    if (parsedBaseline.support.status !== "candidate") throw new Error(parsedBaseline.support.reason ?? "The rendered baseline PDF is outside the supported page and region profile.");
    const mapped = mapDocxSourceToPdfLayout(currentSource, parsedBaseline);
    if (mapped.status !== "supported") throw new Error(mapped.reason);
    if (mapped.layout.pages.length < 1 || mapped.layout.pages.length > 8) throw new Error("The DOCX baseline exceeds the eight-page source-preserving limit.");
    const sourceLayout = mapped.layout as ResumeSourceLayoutMap;
    return { sourceHash: source.sourceHash, sourceLayout, layoutHash: sourceLayoutHash(sourceLayout), baselinePdf, rendererVersion };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function renderDocxSourceBytes(originalBytes: Buffer, source: DocxSourceRepresentation, plan: ResumeSourcePlan, deadline = Date.now() + 90_000, beforeProcess?: () => Promise<void>, preparedBaseline?: PreparedDocxResumeBaseline, trustedName?: string): Promise<RenderedDocxResume> {
  if (bytesHash(originalBytes) !== source.sourceHash || source.support.status !== "candidate" || plan.sourceHash !== source.sourceHash || plan.representationVersion !== source.version) throw new Error("The inspected DOCX source and render plan do not match.");
  if (planEvidencePolicy(plan) === 2) source = await parseDocxSource(originalBytes, trustedName);
  if (!plan.sourceLayout || !plan.layoutHash || !preparedBaseline || preparedBaseline.sourceHash !== source.sourceHash || preparedBaseline.layoutHash !== plan.layoutHash ||
    hashJson(preparedBaseline.sourceLayout) !== hashJson(plan.sourceLayout)) throw new Error("The DOCX plan is not bound to its untouched, all-page rendered baseline. Rebuild the draft from the inspected source.");
  const claimIds = new Set(plan.claims.map((claim) => claim.anchorId));
  const evidenceAnchors = sourceEvidenceAnchors(source, planEvidencePolicy(plan), trustedName);
  if (claimIds.size !== evidenceAnchors.length || evidenceAnchors.some((anchor) => !claimIds.has(anchor.id))) throw new Error("The render plan does not cover every source claim.");
  const sourceFacts: VerifiedFact[] = plan.claims.flatMap((claim) => claim.factIds.map((id) => ({ id, text: claim.text, source: "resume", sourceAnchorId: claim.anchorId, verified: true })));
  const docx = plan.edits.length ? await applyDocxEdits(originalBytes, source, plan.edits, sourceFacts) : originalBytes;
  const directory = await mkdtemp(path.join(os.tmpdir(), "apply-docx-"));
  try {
    await assertPinnedRuntime(directory, deadline);
    if (plan.edits.length) await beforeProcess?.();
    const finalPdf = plan.edits.length ? await convertDocx(directory, docx, "final", deadline) : preparedBaseline.baselinePdf;
    const [baselineLayout, finalLayout] = await Promise.all([readPdfLayout(preparedBaseline.baselinePdf), readPdfLayout(finalPdf)]);
    validatePageDimensions(plan.sourceLayout, baselineLayout, finalLayout, plan);
    const changedIds = validateAnchorGeometry(source, plan.sourceLayout, baselineLayout, finalLayout, plan);
    const pages = await validateVisualDifference(preparedBaseline.baselinePdf, finalPdf, source, plan.sourceLayout, changedIds, baselineLayout, plan);
    return { pdf: finalPdf, baselinePdf: preparedBaseline.baselinePdf, docx, renderer: rendererName(), rendererVersion: preparedBaseline.rendererVersion,
      baselinePdfHash: bytesHash(preparedBaseline.baselinePdf), pageWidthPt: finalLayout[0].width, pageHeightPt: finalLayout[0].height,
      pageCount: finalLayout.length, pages, sourceLayout: plan.sourceLayout, layoutHash: plan.layoutHash, visualOutsideEditDifference: Math.max(...pages.map((page) => page.visualOutsideEditDifference ?? 1)) };
  } catch (error) {
    if (error instanceof ResumeLayoutFeedbackError) throw error;
    if (error instanceof Error && /^(?:This DOCX|The DOCX|The rendered|Unchanged source|Edited wording|LibreOffice|Rotated text|The pinned DOCX)/.test(error.message)) throw error;
    throw new ResumeDraftError({ version: 1, outcome: "technical_failure", writerAttempts: plan.grounding.writerAttempts, checkerAttempts: plan.grounding.checkerAttempts,
      repairAttempts: plan.grounding.repairAttempts, findings: [], requiredInformation: [], technicalFailure: "renderer" }, "The DOCX layout could not be checked by the pinned renderer. The last valid packet is preserved; retry after reviewing the source DOCX.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function renderDocxResume(profile: Profile, plan: ResumeSourcePlan, deadline = Date.now() + 90_000, beforeRender?: () => Promise<void>, preparedBaseline?: PreparedDocxResumeBaseline): Promise<RenderedDocxResume> {
  const source = profile.resumeSourceDocument;
  if (!source || source.format !== "docx" || source.support.status !== "candidate" || source.sourceHash !== profile.resumeSource?.sha256) throw new Error(source?.support.reason ?? "The inspected DOCX source is no longer available. Upload and inspect it again.");
  if (plan.profileHash !== sourceProfileHash(profile) || plan.factsHash !== hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))) || plan.settingsHash !== hashJson(profile.automationSettings ?? null)) throw new Error("The DOCX edit plan is stale. Prepare a new draft after reviewing your source and facts.");
  await beforeRender?.();
  const originalBytes = await readOriginalResume(profile.id, originalResumeManifest(profile));
    const baseline = preparedBaseline ?? await prepareDocxResumeBaseline(originalBytes, source, deadline, beforeRender, profile.name);
  return renderDocxSourceBytes(originalBytes, source, plan, deadline, beforeRender, baseline, profile.name);
}
