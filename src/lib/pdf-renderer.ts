import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bytesHash } from "@/lib/resume-artifacts";
import { readOriginalResume } from "@/lib/original-resume";
import { sourceProfileHash } from "@/lib/resume-source-draft";
import { ResumeLayoutFeedbackError } from "@/lib/resume-layout-feedback";
import { ResumeRendererDiagnosticError } from "@/lib/resume-renderer-diagnostics";
import { planEvidencePolicy, sourceEvidenceAnchors, sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";
import type { PdfSourceAnchor, PdfSourceRepresentation, Profile, ResumePageValidation, ResumeSourcePlan } from "@/lib/types";

const execute = promisify(execFileCallback);
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const EXPECTED_PDFBOX_VERSION = "3.0.8";
const EXPECTED_JAVA_MAJOR = 21;
function safePdfWorkerError(error: unknown): Error | undefined {
  if (!error || typeof error !== "object" || !("stderr" in error) || typeof error.stderr !== "string") return undefined;
  const stderr = error.stderr;
  if (/No glyph for U\+[0-9A-F]{4,6}\b[^\r\n]{0,180}\bin font\b/i.test(stderr))
    return new ResumeRendererDiagnosticError({ code: "unsupported_glyph" });
  if (/The source font for an edited résumé bullet is not embedded as a supported outline font\./.test(stderr)) return new ResumeRendererDiagnosticError({ code: "unembedded_font" });
  if (/The PDF source font changed after inspection\./.test(stderr)) return new ResumeRendererDiagnosticError({ code: "changed_source_font" });
  if (stderr.includes("The PDF renderer changed page dimensions after editing."))
    return new ResumeRendererDiagnosticError({ code: "page_dimensions" });
  if (stderr.includes("The PDF rewrite changed the original page count; no content may be added or removed."))
    return new ResumeRendererDiagnosticError({ code: "page_count" });

  const pageDimensions = stderr.match(/The PDF rewrite changed page (\d{1,2}) dimensions beyond 0\.5 pt\./);
  if (pageDimensions) return new ResumeRendererDiagnosticError({ code: "page_dimensions", page: Number(pageDimensions[1]) });
  const outsidePixels = stderr.match(/The PDF render changed page (\d{1,2}) pixels outside edited text boxes \(144 dpi: ([\d.]+), 300 dpi: ([\d.]+)\)\. No font substitution or overlay will be used\./);
  if (outsidePixels) return new ResumeRendererDiagnosticError({ code: "outside_edit_pixels", page: Number(outsidePixels[1]), at144Dpi: outsidePixels[2], at300Dpi: outsidePixels[3] });
  return undefined;
}

export interface RenderedPdfResume {
  pdf: Buffer;
  baselinePdf: Buffer;
  sourcePdf: Buffer;
  renderer: "apache-pdfbox";
  rendererVersion: string;
  javaVersion: string;
  runtimeArchitecture: string;
  baselinePdfHash: string;
  pages: ResumePageValidation[];
  pageWidthPt: number;
  pageHeightPt: number;
  visualOutsideEditDifferenceAt144Dpi: number;
  visualOutsideEditDifferenceAt300Dpi: number;
}

function resolveRuntime() {
  const root = process.env.PDFBOX_RUNTIME_ROOT || path.join(process.cwd(), ".runtime", "pdf");
  return { root, jar: path.join(root, `pdfbox-app-${EXPECTED_PDFBOX_VERSION}.jar`), classes: path.join(root, "classes"), java: process.env.PDFBOX_JAVA_BIN || path.join(root, "jre", "bin", "java") };
}

function boundedTimeout(deadline: number, requested = 30_000) {
  const remaining = Math.min(requested, deadline - Date.now());
  if (remaining < 1_000) throw new Error("PDF rendering exceeded its bounded runtime. Retry the draft; the last valid packet is preserved.");
  return remaining;
}

function childEnvironment(directory: string): NodeJS.ProcessEnv {
  const runtime = resolveRuntime();
  const javaHome = process.env.PDFBOX_JAVA_HOME || (runtime.java.startsWith(runtime.root) ? path.join(runtime.root, "jre") : undefined);
  return {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: `${path.dirname(runtime.java)}:/usr/bin:/bin`,
    HOME: directory,
    TMPDIR: directory,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

function encode(value: string) { return Buffer.from(value, "utf8").toString("base64url"); }

function anchorForEdit(source: PdfSourceRepresentation, edit: ResumeSourcePlan["edits"][number]): PdfSourceAnchor {
  const anchor = source.anchors.find((item) => item.id === edit.anchorId);
  if (!anchor || anchor.kind !== "bullet" || !anchor.candidateClaim || !anchor.editable) throw new Error("A planned PDF edit no longer targets one supported source bullet. Reinspect the original résumé before drafting again.");
  return anchor;
}

function editManifest(source: PdfSourceRepresentation, plan: ResumeSourcePlan) {
  return plan.edits.map((edit) => {
    const anchor = anchorForEdit(source, edit);
    const replacement = `${anchor.bulletPrefix}${edit.text}`;
    const fields = [encode(anchor.id), String(anchor.pageNumber), encode(anchor.sourceText), encode(replacement), encode(anchor.font.family),
      String(anchor.boundsPt.left), String(anchor.boundsPt.top), String(anchor.boundsPt.right), String(anchor.boundsPt.bottom)];
    return fields.join("\t");
  }).join("\n") + (plan.edits.length ? "\n" : "");
}

function parseMetrics(output: string) {
  const fieldsFor = (line: string) => Object.fromEntries(line.trim().split("\t").map((field) => field.split("=", 2)));
  const lines = output.trim().split(/\r?\n/);
  const fields = fieldsFor(lines[0] ?? "");
  const pageCount = Number(fields.pages);
  const pdfbox = fields.pdfbox;
  const pageMetrics = lines.slice(1).map(fieldsFor).map((page) => ({
    pageNumber: Number(page.page), widthPt: Number(page.pageWidthPt), heightPt: Number(page.pageHeightPt),
    visualOutsideEditDifferenceAt144Dpi: Number(page.outsideDifferenceAt144Dpi), visualOutsideEditDifferenceAt300Dpi: Number(page.outsideDifferenceAt300Dpi),
  }));
  const pageWidthPt = Number(fields.pageWidthPt);
  const pageHeightPt = Number(fields.pageHeightPt);
  const visualOutsideEditDifferenceAt144Dpi = Number(fields.outsideDifferenceAt144Dpi);
  const visualOutsideEditDifferenceAt300Dpi = Number(fields.outsideDifferenceAt300Dpi);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 8 || pageMetrics.length !== pageCount || pageMetrics.some((page, index) =>
    page.pageNumber !== index + 1 || !(page.widthPt > 0) || !(page.heightPt > 0) || page.visualOutsideEditDifferenceAt144Dpi !== 0 || page.visualOutsideEditDifferenceAt300Dpi !== 0) ||
    pdfbox !== EXPECTED_PDFBOX_VERSION || !(pageWidthPt > 0) || !(pageHeightPt > 0) || visualOutsideEditDifferenceAt144Dpi !== 0 || visualOutsideEditDifferenceAt300Dpi !== 0)
    throw new Error("The PDFBox worker returned incomplete page or fidelity validation results.");
  return { pageCount, pageMetrics, pageWidthPt, pageHeightPt, visualOutsideEditDifferenceAt144Dpi, visualOutsideEditDifferenceAt300Dpi };
}

async function assertRuntime(directory: string, deadline: number) {
  const runtime = resolveRuntime();
  try {
    const { stdout } = await execute(runtime.java, ["-Djava.awt.headless=true", "-Xms32m", "-Xmx768m", "-Djava.io.tmpdir=" + directory, "-cp", `${runtime.classes}${path.delimiter}${runtime.jar}`, "PdfSourceRewrite", "--version"], {
      cwd: directory, env: childEnvironment(directory), timeout: boundedTimeout(deadline, 12_000), killSignal: "SIGKILL", maxBuffer: 4096,
    });
    const match = stdout.match(/^pdfbox=([^\t\r\n]+)\tjava=([^\t\r\n]+)/);
    if (!match || match[1] !== EXPECTED_PDFBOX_VERSION) throw new Error("The pinned Apache PDFBox 3.0.8 runtime is not installed.");
    const major = Number(match[2].match(/^\d+/)?.[0]);
    const expectedMajor = process.env.NODE_ENV === "production" ? EXPECTED_JAVA_MAJOR : Number(process.env.PDFBOX_JAVA_MAJOR ?? EXPECTED_JAVA_MAJOR);
    if (major !== expectedMajor) throw new Error(`The pinned PDF worker requires Java ${expectedMajor}.`);
    return { runtime, version: match[1], javaVersion: match[2] };
  } catch (error) {
    if (error instanceof Error && /pinned Apache|requires Java/.test(error.message)) throw error;
    throw new Error("The pinned PDFBox worker runtime is unavailable. Retry after the native runtime is repaired.");
  }
}

function sourcePages(source: PdfSourceRepresentation, metrics: ReturnType<typeof parseMetrics>): ResumePageValidation[] {
  if (metrics.pageCount !== source.layout.pageCount) throw new Error("The PDF rewrite changed the original page count; no content may be added or removed.");
  const sourcePages = source.layout.pages;
  if (!sourcePages || sourcePages.length !== metrics.pageCount) throw new Error("The inspected PDF is missing a complete source page/region map; re-upload the source PDF before tailoring.");
  return sourcePages.map((page, index) => {
    const result = metrics.pageMetrics[index];
    if (page.pageNumber !== index + 1 || Math.abs(page.widthPt - result.widthPt) > 0.5 || Math.abs(page.heightPt - result.heightPt) > 0.5)
      throw new Error(`The PDF rewrite changed source page ${index + 1} dimensions or mapping beyond 0.5 pt.`);
    return { ...page, visualOutsideEditDifferenceAt144Dpi: result.visualOutsideEditDifferenceAt144Dpi,
      visualOutsideEditDifferenceAt300Dpi: result.visualOutsideEditDifferenceAt300Dpi };
  });
}

function validatePlan(sourceBytes: Buffer, source: PdfSourceRepresentation, plan: ResumeSourcePlan, trustedName?: string) {
  if (source.format !== "pdf" || source.support.status !== "candidate" || source.sourceHash !== bytesHash(sourceBytes) || plan.format !== "pdf" || plan.sourceHash !== source.sourceHash || plan.representationVersion !== source.version)
    throw new Error(source.support.reason ?? "The inspected PDF source is missing, stale, or unsupported. Upload and inspect the original again.");
  const expectedClaims = new Set(sourceEvidenceAnchors(source, planEvidencePolicy(plan), trustedName).map((anchor) => anchor.id));
  const actualClaims = new Set(plan.claims.map((claim) => claim.anchorId));
  if (expectedClaims.size !== actualClaims.size || [...expectedClaims].some((id) => !actualClaims.has(id))) throw new Error("The PDF plan does not preserve every original résumé claim.");
  const claimById = new Map(plan.claims.map((claim) => [claim.anchorId, claim]));
  const edits = new Map(plan.edits.map((edit) => [edit.anchorId, edit]));
  if (edits.size !== plan.edits.length || plan.edits.some((edit) => {
    const anchor = source.anchors.find((candidate) => candidate.id === edit.anchorId);
    const claim = claimById.get(edit.anchorId);
    return !anchor || anchor.kind !== "bullet" || !anchor.editable || !claim || edit.text !== claim.text || JSON.stringify(edit.factIds) !== JSON.stringify(claim.factIds) || edit.text === anchor.text;
  })) throw new Error("The PDF edit plan contains a duplicate, unsupported, or ungrounded source operation.");
}

export async function renderPdfSourceBytes(sourceBytes: Buffer, sourceInput: PdfSourceRepresentation, plan: ResumeSourcePlan, deadline = Date.now() + 90_000, beforeProcess?: () => Promise<void>, trustedName?: string): Promise<RenderedPdfResume> {
  const source = planEvidencePolicy(plan) === 2 ? sourceWithCurrentEvidenceClaims(sourceInput, trustedName) : sourceInput;
  validatePlan(sourceBytes, source, plan, trustedName);
  if (sourceBytes.length < 1 || sourceBytes.length > MAX_PDF_BYTES) throw new Error("The source PDF exceeds the 5 MB worker limit.");
  const directory = await mkdtemp(path.join(os.tmpdir(), "resume-pdf-")).catch(() => { throw new Error("The PDF worker could not create an isolated temporary directory."); });
  try {
    const { runtime, version, javaVersion } = await assertRuntime(directory, deadline);
    const input = path.join(directory, "source.pdf");
    const output = path.join(directory, "tailored.pdf");
    const manifest = path.join(directory, "edits.tsv");
    await writeFile(input, sourceBytes, { mode: 0o600, flag: "wx" });
    await writeFile(manifest, editManifest(source, plan), { mode: 0o600, flag: "wx" });
    await beforeProcess?.();
    let stdout: string;
    try {
      const result = await execute(runtime.java, ["-Djava.awt.headless=true", "-Xms32m", "-Xmx768m", "-Djava.io.tmpdir=" + directory,
        "-cp", `${runtime.classes}${path.delimiter}${runtime.jar}`, "PdfSourceRewrite", input, output, manifest], {
        cwd: directory, env: childEnvironment(directory), timeout: boundedTimeout(deadline, 60_000), killSignal: "SIGKILL", maxBuffer: 32 * 1024,
      });
      stdout = result.stdout;
    } catch (error) {
      const safeWorkerError = safePdfWorkerError(error);
      if (safeWorkerError) throw safeWorkerError;
      const fit = error instanceof Error ? error.message.match(/LAYOUT_FIT anchorId=([^\s]+) page=(\d+) reason=width/) : null;
      if (fit) {
        const anchor = source.anchors.find((candidate) => candidate.id === fit[1]);
        const pageNumber = Number(fit[2]);
        const mapping = plan.sourceLayout?.anchors.find((candidate) => candidate.anchorId === fit[1] && candidate.pageNumber === pageNumber);
        if (anchor?.candidateClaim && anchor.kind === "bullet" && anchor.editable && mapping)
          throw new ResumeLayoutFeedbackError({ anchorId: anchor.id, pageNumber, regionId: mapping.regionId, reason: "The rewritten wording is wider than its original embedded-font text line." });
      }
      if (error instanceof Error && /one unique PDF text operator|split across PDF|source font|glyph|needs more width|page dimensions|pixels outside|multiple pages|digital signature|encrypted|Form XObject|interactive form|clipping|marked-content/i.test(error.message)) throw error;
      throw new Error("The PDF could not be safely rewritten by the pinned PDFBox worker. The last valid packet is preserved; use an editable DOCX or retry after reviewing the source PDF.");
    }
    const pdf = await readFile(output).catch(() => { throw new Error("The PDFBox worker did not save a tailored PDF. The existing packet is preserved."); });
    if (pdf.length < 1 || pdf.length > MAX_PDF_BYTES || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The tailored PDF is invalid or exceeds the 5 MB artifact limit.");
    if (plan.edits.length && bytesHash(pdf) === bytesHash(sourceBytes)) throw new Error("The PDF worker returned the unchanged source instead of applying the approved edit.");
    const metrics = parseMetrics(stdout);
    const pages = sourcePages(source, metrics);
    return { pdf, baselinePdf: sourceBytes, sourcePdf: sourceBytes, renderer: "apache-pdfbox", rendererVersion: version, javaVersion, pages,
      runtimeArchitecture: `${process.platform}-${process.arch}`,
      baselinePdfHash: bytesHash(sourceBytes), ...metrics };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function renderPdfResume(profile: Profile, plan: ResumeSourcePlan, deadline = Date.now() + 90_000, beforeProcess?: () => Promise<void>) {
  const source = profile.resumeSourceDocument;
  if (!source || source.format !== "pdf" || !profile.resumeSource || source.sourceHash !== profile.resumeSource.sha256)
    throw new Error("The inspected PDF source is no longer available or has changed. Upload and inspect the original again.");
  if (plan.profileHash !== sourceProfileHash(profile)) throw new Error("The PDF edit plan is stale. Prepare a new draft after reviewing your source and facts.");
  const sourceBytes = await readOriginalResume(profile.id, { ...profile.resumeSource, filename: profile.resumeFileName ?? "source.pdf" });
  return renderPdfSourceBytes(sourceBytes, source, plan, deadline, beforeProcess, profile.name);
}
