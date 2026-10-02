import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { hashJson } from "@/lib/crypto";
import { bytesHash } from "@/lib/resume-artifacts";
import { originalResumeManifest, readOriginalResume } from "@/lib/original-resume";
import { applyDocxEdits } from "@/lib/docx-source";
import { ResumeDraftError } from "@/lib/resume-document";
import { sourceProfileHash } from "@/lib/resume-source-draft";
import type { DocxSourceRepresentation, Profile, ResumeSourcePlan, VerifiedFact } from "@/lib/types";

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
    throw new Error("LibreOffice could not render this DOCX. Check its layout and fonts, then upload a supported one-page DOCX; the existing packet is preserved.");
  }
  let pdf: Buffer;
  try { pdf = await readFile(path.join(outputDir, `${name}.pdf`)); }
  catch { throw new Error("LibreOffice did not produce a readable PDF. Upload a supported one-page DOCX and retry."); }
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
      const items = content.items.filter(isTextItem);
      const anchors = items.map((item) => {
        const a = item.transform[0];
        const b = item.transform[1];
        const x = item.transform[4];
        const y = item.transform[5];
        const fontSize = Math.hypot(a, b);
        if (Math.abs(b) > 0.01) throw new Error("Rotated text is outside the supported DOCX layout profile.");
        const style = content.styles[item.fontName];
        return { text: normalize(item.str), box: { left: x, top: viewport.height - y - item.height, right: x + item.width, bottom: viewport.height - y },
          fontFamilies: [style?.fontFamily ?? ""], fontSizes: [fontSize] };
      }).filter((item) => item.text);
      pages.push({ width: viewport.width, height: viewport.height, anchors });
      page.cleanup();
    }
    return pages;
  } finally { await loadingTask.destroy(); }
}

function locateAnchor(pages: PdfPageLayout[], anchorText: string): { page: PdfPageLayout; box: PdfBox; fontFamilies: string[]; fontSizes: number[] } {
  const needle = normalize(anchorText);
  const matches: Array<{ page: PdfPageLayout; box: PdfBox; fontFamilies: string[]; fontSizes: number[] }> = [];
  for (const page of pages) {
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
      if (selected.length) matches.push({ page, box: { left: Math.min(...selected.map((item) => item.box.left)), top: Math.min(...selected.map((item) => item.box.top)),
        right: Math.max(...selected.map((item) => item.box.right)), bottom: Math.max(...selected.map((item) => item.box.bottom)) },
        fontFamilies: [...new Set(selected.flatMap((item) => item.fontFamilies))], fontSizes: selected.map((item) => item.fontSizes[0]) });
      cursor = joined.indexOf(needle, end);
    }
  }
  if (matches.length !== 1) throw new Error(`The rendered DOCX text “${anchorText.slice(0, 70)}” could not be matched to one source paragraph. Remove duplicate or complex text and retry.`);
  return matches[0];
}

function near(left: number, right: number, tolerance: number) { return Math.abs(left - right) <= tolerance; }
function validatePageDimensions(source: DocxSourceRepresentation, baseline: PdfPageLayout[], final: PdfPageLayout[]) {
  if (baseline.length !== 1 || final.length !== 1) throw new Error(`This DOCX renders to ${final.length} pages. The current source-preserving profile supports exactly one page; shorten the source without removing original experience.`);
  const page = baseline[0];
  const finalPage = final[0];
  const expected = source.layout.pageSizePt;
  if (!near(page.width, expected.width, pageSizeTolerancePt) || !near(page.height, expected.height, pageSizeTolerancePt) || !near(finalPage.width, page.width, pageSizeTolerancePt) || !near(finalPage.height, page.height, pageSizeTolerancePt)) throw new Error("LibreOffice changed the source page dimensions beyond the 0.5 pt tolerance. Upload a DOCX with a supported page size and layout.");
}

function pixelIndex(x: number, y: number, width: number) { return (Math.floor(y) * width + Math.floor(x)) * 4; }
async function screenshot(parser: PDFParse) {
  const result = await parser.getScreenshot({ scale: 1, imageBuffer: true, imageDataUrl: false, first: 1 });
  const page = result.pages[0];
  if (!page) throw new Error("A rendered page image is unavailable.");
  const image = await loadImage(Buffer.from(page.data));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}
async function validateVisualDifference(baselinePdf: Buffer, finalPdf: Buffer, source: DocxSourceRepresentation, changedIds: Set<string>, baselineLayout: PdfPageLayout[]) {
  const baselineParser = new PDFParse({ data: baselinePdf });
  const finalParser = new PDFParse({ data: finalPdf });
  try {
    const [original, revised] = await Promise.all([screenshot(baselineParser), screenshot(finalParser)]);
    if (original.width !== revised.width || original.height !== revised.height) throw new Error("The rendered page image dimensions changed.");
    const masks = source.anchors.filter((anchor) => changedIds.has(anchor.id)).map((anchor) => {
      const baseline = locateAnchor(baselineLayout, anchor.text);
      const left = Math.max(0, baseline.box.left - 2);
      const top = Math.max(0, baseline.box.top - 2);
      const right = Math.min(original.width, baselineLayout[0].width - source.layout.marginsPt.right);
      const bottom = Math.min(original.height, baseline.box.bottom + 2);
      return { left, top, right, bottom };
    });
    let changedOutside = 0;
    let comparedOutside = 0;
    for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
      if (masks.some((mask) => x >= mask.left && x <= mask.right && y >= mask.top && y <= mask.bottom)) continue;
      comparedOutside++;
      const index = pixelIndex(x, y, original.width);
      if (Math.abs(original.data[index] - revised.data[index]) > 8 || Math.abs(original.data[index + 1] - revised.data[index + 1]) > 8 || Math.abs(original.data[index + 2] - revised.data[index + 2]) > 8) changedOutside++;
    }
    const fraction = comparedOutside ? changedOutside / comparedOutside : 1;
    if (fraction > OUTSIDE_PIXEL_DIFFERENCE_LIMIT) throw new Error(`The rendered page changed outside edited lines (${(fraction * 100).toFixed(3)}%; limit 0.100%). This layout is unsupported; shorten the wording or upload another DOCX.`);
    return fraction;
  } finally { await baselineParser.destroy(); await finalParser.destroy(); }
}

function validateAnchorGeometry(source: DocxSourceRepresentation, baseline: PdfPageLayout[], final: PdfPageLayout[], edits: ResumeSourcePlan["edits"]) {
  const editById = new Map(edits.map((edit) => [edit.anchorId, edit]));
  const changed = new Set<string>();
  for (const anchor of source.anchors) {
    const replacement = editById.get(anchor.id);
    const before = locateAnchor(baseline, anchor.text);
    const after = locateAnchor(final, replacement?.text ?? anchor.text);
    if (before.page !== baseline[0] || after.page !== final[0]) throw new Error("The DOCX moved content to another page.");
    const beforeFont = anchor.font?.family.toLowerCase();
    const afterFonts = after.fontFamilies.map((family) => family.toLowerCase());
    const localPdfFontAlias = process.env.NODE_ENV === "test" && process.platform === "darwin" && beforeFont === "noto sans" && afterFonts.length > 0 && afterFonts.every((family) => family === "sans-serif");
    if (!beforeFont || afterFonts.some((family) => family !== beforeFont) && !localPdfFontAlias) throw new Error(`The rendered paragraph “${anchor.text.slice(0, 70)}” uses ${afterFonts.join(", ") || "an unknown font"} instead of source font ${beforeFont || "unknown"}. Upload a DOCX using the pinned Noto Sans source font.`);
    if (after.fontSizes.some((size) => Math.abs(size - (anchor.font?.sizePt ?? 0)) > 0.5)) throw new Error(`The rendered paragraph “${anchor.text.slice(0, 70)}” changed font size by more than 0.5 pt.`);
    if (!replacement) {
      if (!near(before.box.left, after.box.left, unchangedGeometryTolerancePt) || !near(before.box.top, after.box.top, unchangedGeometryTolerancePt) ||
        !near(before.box.right, after.box.right, unchangedGeometryTolerancePt) || !near(before.box.bottom, after.box.bottom, unchangedGeometryTolerancePt) ||
        before.fontFamilies.join("\0") !== after.fontFamilies.join("\0") || before.fontSizes.some((size, index) => !near(size, after.fontSizes[index] ?? 0, 0.1))) throw new Error(`Unchanged source paragraph “${anchor.text.slice(0, 70)}” moved or changed typography beyond the 1 pt layout tolerance.`);
    } else {
      const pageRight = before.page.width - source.layout.marginsPt.right;
      if (after.box.left < before.box.left - 1 || after.box.right > pageRight + 1 || after.box.top < before.box.top - 1 || after.box.bottom > before.box.bottom + 1) throw new Error(`Edited wording at “${anchor.entryHeading}” does not fit its original line and source page region. Shorten the edit; original experience was kept.`);
      changed.add(anchor.id);
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
  visualOutsideEditDifference: number;
}

export async function renderDocxSourceBytes(originalBytes: Buffer, source: DocxSourceRepresentation, plan: ResumeSourcePlan, deadline = Date.now() + 90_000, beforeProcess?: () => Promise<void>): Promise<RenderedDocxResume> {
  if (bytesHash(originalBytes) !== source.sourceHash || source.support.status !== "candidate" || plan.sourceHash !== source.sourceHash || plan.representationVersion !== source.version) throw new Error("The inspected DOCX source and render plan do not match.");
  const claimIds = new Set(plan.claims.map((claim) => claim.anchorId));
  if (claimIds.size !== source.anchors.filter((anchor) => anchor.candidateClaim).length || source.anchors.filter((anchor) => anchor.candidateClaim).some((anchor) => !claimIds.has(anchor.id))) throw new Error("The render plan does not cover every source claim.");
  const sourceFacts: VerifiedFact[] = plan.claims.flatMap((claim) => claim.factIds.map((id) => ({ id, text: claim.text, source: "resume", sourceAnchorId: claim.anchorId, verified: true })));
  const docx = plan.edits.length ? await applyDocxEdits(originalBytes, source, plan.edits, sourceFacts) : originalBytes;
  const directory = await mkdtemp(path.join(os.tmpdir(), "apply-docx-"));
  try {
    const rendererVersion = await assertPinnedRuntime(directory, deadline);
    await beforeProcess?.();
    const baselinePdf = await convertDocx(directory, originalBytes, "baseline", deadline);
    if (plan.edits.length) await beforeProcess?.();
    const finalPdf = plan.edits.length ? await convertDocx(directory, docx, "final", deadline) : baselinePdf;
    const [baselineLayout, finalLayout] = await Promise.all([readPdfLayout(baselinePdf), readPdfLayout(finalPdf)]);
    validatePageDimensions(source, baselineLayout, finalLayout);
    const changedIds = validateAnchorGeometry(source, baselineLayout, finalLayout, plan.edits);
    const visualOutsideEditDifference = await validateVisualDifference(baselinePdf, finalPdf, source, changedIds, baselineLayout);
    return { pdf: finalPdf, baselinePdf, docx, renderer: rendererName(), rendererVersion, baselinePdfHash: bytesHash(baselinePdf), pageWidthPt: finalLayout[0].width, pageHeightPt: finalLayout[0].height, visualOutsideEditDifference };
  } catch (error) {
    if (error instanceof Error && /^(?:This DOCX|The DOCX|The rendered|Unchanged source|Edited wording|LibreOffice|Rotated text|The pinned DOCX)/.test(error.message)) throw error;
    throw new ResumeDraftError({ version: 1, outcome: "technical_failure", writerAttempts: plan.grounding.writerAttempts, checkerAttempts: plan.grounding.checkerAttempts,
      repairAttempts: plan.grounding.repairAttempts, findings: [], requiredInformation: [], technicalFailure: "renderer" }, "The DOCX layout could not be checked by the pinned renderer. The last valid packet is preserved; retry after reviewing the source DOCX.");
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function renderDocxResume(profile: Profile, plan: ResumeSourcePlan, deadline = Date.now() + 90_000, beforeRender?: () => Promise<void>): Promise<RenderedDocxResume> {
  const source = profile.resumeSourceDocument;
  if (!source || source.support.status !== "candidate" || source.sourceHash !== profile.resumeSource?.sha256) throw new Error(source?.support.reason ?? "The inspected DOCX source is no longer available. Upload and inspect it again.");
  if (plan.profileHash !== sourceProfileHash(profile) || plan.factsHash !== hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))) || plan.settingsHash !== hashJson(profile.automationSettings ?? null)) throw new Error("The DOCX edit plan is stale. Prepare a new draft after reviewing your source and facts.");
  await beforeRender?.();
  const originalBytes = await readOriginalResume(profile.id, originalResumeManifest(profile));
  return renderDocxSourceBytes(originalBytes, source, plan, deadline, beforeRender);
}
