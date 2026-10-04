import { factEvidenceSnapshot } from "@/lib/fact-evidence";
import { hashJson } from "@/lib/crypto";
import { ResumeDraftError } from "@/lib/resume-document";
import { readOriginalResume, validateOriginalResume } from "@/lib/original-resume";
import { coverLetterPdf, resumePdf } from "@/lib/resume-pdf";
import { fitResume } from "@/lib/latex-compiler";
import { resumeFactIds, resumeFields, resumeInputHash, validateResumeDocument } from "@/lib/resume-document";
import { bytesHash, readArtifact, saveArtifact } from "@/lib/resume-artifacts";
import { renderDocxResume, type RenderedDocxResume } from "@/lib/docx-renderer";
import { renderPdfResume, type RenderedPdfResume } from "@/lib/pdf-renderer";
import { sourceProfileHash } from "@/lib/resume-source-draft";
import { pdfSourceLayout, sourceLayoutHash } from "@/lib/resume-source-layout";
import { planEvidencePolicy, validateSourcePlanEvidence } from "@/lib/source-plan-evidence";
import type { ApplicationPacket, PacketFile, Profile, ResumePageValidation, ResumeSourcePlan } from "@/lib/types";

export type PacketFileKind = PacketFile["kind"];
type ValidatedSourceRender =
  | { plan: ResumeSourcePlan; format: "pdf"; rendered: RenderedPdfResume }
  | { plan: ResumeSourcePlan; format: "docx"; rendered: RenderedDocxResume };
const legacyResumeInputHash = (profile: Profile, packet: ApplicationPacket) => hashJson({ kind: "resume", profile: { name: profile.name, email: profile.email, phone: profile.phone, school: profile.school, graduationYear: profile.graduationYear, skills: profile.skills }, lines: packet.resumeLines });
const coverInputHash = (packet: ApplicationPacket) => hashJson({ kind: "cover-letter", text: packet.coverLetter });
const docxLayoutPolicy = "docx-single-column-one-page-v1" as const;
const pdfLayoutPolicy = "pdf-single-column-one-page-v1" as const;
const docxPageLayoutPolicy = "docx-page-regions-v2" as const;
const pdfPageLayoutPolicy = "pdf-page-regions-v2" as const;
function policyFor(plan: ResumeSourcePlan) {
  return plan.format === "pdf" ? pdfPolicyFor(plan) : docxPolicyFor(plan);
}
function pdfPolicyFor(plan: ResumeSourcePlan): typeof pdfLayoutPolicy | typeof pdfPageLayoutPolicy { return plan.layoutHash && plan.sourceLayout ? pdfPageLayoutPolicy : pdfLayoutPolicy; }
function docxPolicyFor(plan: ResumeSourcePlan): typeof docxLayoutPolicy | typeof docxPageLayoutPolicy { return plan.layoutHash && plan.sourceLayout ? docxPageLayoutPolicy : docxLayoutPolicy; }
function docxInputHash(plan: ResumeSourcePlan) {
  return hashJson({ kind: "source-preserving-docx", sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
    profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: policyFor(plan), ...(plan.layoutHash ? { layoutHash: plan.layoutHash } : {}), ...(plan.evidencePolicyVersion === 2 ? { evidencePolicyVersion: 2 } : {}), ...(plan.jobHashPolicyVersion === 2 ? { jobHashPolicyVersion: 2 } : {}), claims: plan.claims, edits: plan.edits, grounding: plan.grounding });
}
function pdfInputHash(plan: ResumeSourcePlan) {
  return hashJson({ kind: "source-preserving-pdf", sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
    profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: policyFor(plan), ...(plan.layoutHash ? { layoutHash: plan.layoutHash } : {}), ...(plan.evidencePolicyVersion === 2 ? { evidencePolicyVersion: 2 } : {}), ...(plan.jobHashPolicyVersion === 2 ? { jobHashPolicyVersion: 2 } : {}), claims: plan.claims, edits: plan.edits, grounding: plan.grounding });
}
function sourceInputHash(plan: ResumeSourcePlan) { return plan.format === "pdf" ? pdfInputHash(plan) : docxInputHash(plan); }
const filename = (kind: PacketFileKind) => kind === "resume" ? "tailored-resume.pdf" : "cover-letter.pdf";
function pageRecords(pages: ResumePageValidation[] | undefined) {
  return pages?.map((page) => {
    const record = { ...page };
    delete record.visualOutsideEditDifference;
    delete record.visualOutsideEditDifferenceAt144Dpi;
    delete record.visualOutsideEditDifferenceAt300Dpi;
    return record;
  });
}
function sourceLayoutMatchesPlan(plan: ResumeSourcePlan, source: NonNullable<Profile["resumeSourceDocument"]>) {
  if (!plan.sourceLayout && !plan.layoutHash) return !(source.format === "pdf" && source.version >= 2);
  if (!plan.sourceLayout || !plan.layoutHash || sourceLayoutHash(plan.sourceLayout) !== plan.layoutHash) return false;
  const { pages, anchors } = plan.sourceLayout;
  if (pages.length < 1 || pages.length > 8 || pages.some((page, index) => page.pageNumber !== index + 1 || page.rotation !== 0 ||
    !Number.isFinite(page.widthPt) || page.widthPt <= 0 || !Number.isFinite(page.heightPt) || page.heightPt <= 0 || page.regions.length < 1 ||
    new Set(page.regions.map((region) => region.id)).size !== page.regions.length || page.regions.some((region) => region.pageIndex !== index || !region.id ||
      !Number.isFinite(region.bounds.left) || !Number.isFinite(region.bounds.top) || !Number.isFinite(region.bounds.right) || !Number.isFinite(region.bounds.bottom) ||
      region.bounds.right <= region.bounds.left || region.bounds.bottom <= region.bounds.top))) return false;
  const sourceAnchors = new Map(source.anchors.map((anchor) => [anchor.id, anchor]));
  if (anchors.some((anchor) => !sourceAnchors.has(anchor.anchorId) || !Number.isInteger(anchor.pageNumber) || anchor.pageNumber < 1 || anchor.pageNumber > pages.length ||
    !pages[anchor.pageNumber - 1].regions.some((region) => region.id === anchor.regionId) || !Number.isInteger(anchor.readingOrder) || anchor.readingOrder < 0 ||
    ![anchor.boundsPt.left, anchor.boundsPt.top, anchor.boundsPt.right, anchor.boundsPt.bottom].every(Number.isFinite) ||
    anchor.boundsPt.right <= anchor.boundsPt.left || anchor.boundsPt.bottom <= anchor.boundsPt.top)) return false;
  if (source.anchors.some((anchor) => {
    const mapped = anchors.filter((layout) => layout.anchorId === anchor.id);
    // PDF parsing already creates a distinct source anchor for each repeated
    // header/footer occurrence. DOCX keeps one OOXML anchor and maps it once
    // per rendered page, so only the DOCX adapter expects repeated mappings.
    const repeated = source.format === "docx" && "repeatedRole" in anchor && (anchor.repeatedRole === "header" || anchor.repeatedRole === "footer");
    return repeated ? mapped.length !== pages.length : mapped.length !== 1;
  })) return false;
  if (new Set(anchors.map((anchor) => `${anchor.anchorId}:${anchor.pageNumber}`)).size !== anchors.length) return false;
  if (source.format === "pdf") {
    const expected = pdfSourceLayout(source);
    return Boolean(expected && sourceLayoutHash(expected) === plan.layoutHash);
  }
  return true;
}
async function render(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  if (kind === "resume") return resumePdf(profile, packet);
  if (!packet.coverLetter) throw new Error("This packet has no cover letter.");
  return coverLetterPdf(packet.coverLetter);
}
export function validateResumeArtifact(profile: Profile, packet: ApplicationPacket): void {
  const artifact = packet.resumeArtifact;
  const file = packet.files?.find((item) => item.kind === "resume");
  if (!artifact || !file) throw new Error("Prepare the application files before review.");
  if (artifact.format === "pdf") {
    const source = profile.resumeSourceDocument;
    const plan = packet.resumeSourcePlan;
    if (packet.schemaVersion !== 3 || !source || source.format !== "pdf" || source.support.status !== "candidate" || !plan || plan.format !== "pdf" ||
      !profile.resumeSource || profile.resumeSource.mimeType !== "application/pdf" || profile.resumeSource.sha256 !== source.sourceHash)
      throw new Error("The inspected PDF source is no longer available. Rebuild the packet from the confirmed original PDF.");
    const factsHash = hashJson(factEvidenceSnapshot(profile.facts));
    const evidenceValid = validateSourcePlanEvidence({ source, profile, claims: plan.claims, edits: plan.edits, grounding: plan.grounding, evidencePolicyVersion: planEvidencePolicy(plan) });
    const expectedPageCount = plan.sourceLayout?.pages.length ?? 1;
    const expectedLayoutPolicy = policyFor(plan);
    if (plan.version !== 1 || plan.sourceHash !== source.sourceHash || plan.representationVersion !== source.version ||
      !sourceLayoutMatchesPlan(plan, source) ||
      plan.profileHash !== sourceProfileHash(profile) || plan.factsHash !== factsHash || plan.settingsHash !== hashJson(profile.automationSettings ?? null) ||
      !/^[a-f0-9]{64}$/.test(plan.jobHash) || !evidenceValid)
      throw new Error("The PDF source plan is stale or does not preserve the complete reviewed source.");
    const inputHash = pdfInputHash(plan);
    const valid = (key: string | undefined, hash: string, size: number) => /^[a-f0-9]{64}$/.test(hash) && Number.isInteger(size) && size > 0 && size <= 5 * 1024 * 1024 && key === `${profile.id}/${inputHash}/${hash}.pdf`;
    const layout = artifact.layoutValidation;
    const artifactPages = pageRecords(layout?.pages);
    if (artifact.inputHash !== inputHash || artifact.pageCount !== expectedPageCount || artifact.renderer !== "apache-pdfbox" || artifact.rendererVersion !== "3.0.8" ||
      !/^\d+(?:\.\d+){1,3}(?:\+\S+)?$/.test(artifact.javaVersion) || !/^(?:linux|darwin)-(?:x64|arm64)$/.test(artifact.runtimeArchitecture) ||
      artifact.sourceHash !== source.sourceHash || artifact.representationVersion !== source.version || artifact.profileHash !== plan.profileHash || artifact.factsHash !== plan.factsHash ||
      artifact.settingsHash !== plan.settingsHash || artifact.jobHash !== plan.jobHash || artifact.layoutPolicy !== expectedLayoutPolicy || layout?.outcome !== "passed" ||
      artifact.layoutValidation.layoutHash !== plan.layoutHash || (plan.sourceLayout && hashJson(artifactPages) !== hashJson(plan.sourceLayout.pages)) ||
      layout.unchangedAnchorTolerancePt !== 0.5 || layout.pageSizeTolerancePt !== 0.5 || layout.visualMaskPaddingPt !== (plan.layoutHash && plan.sourceLayout ? 2.5 : 1.5) || layout.visualOutsideEditTolerance !== 0 ||
      layout.visualOutsideEditDifferenceAt144Dpi !== 0 || layout.visualOutsideEditDifferenceAt300Dpi !== 0 || !/^[a-f0-9]{64}$/.test(layout.baselinePdfHash) ||
      !Number.isFinite(layout.pageWidthPt) || layout.pageWidthPt <= 0 || !Number.isFinite(layout.pageHeightPt) || layout.pageHeightPt <= 0 ||
      artifact.baseline.mimeType !== "application/pdf" || artifact.baseline.sha256 !== layout.baselinePdfHash || artifact.baseline.sha256 !== source.sourceHash ||
      artifact.baseline.size !== profile.resumeSource.size || !valid(artifact.baseline.storageKey, artifact.baseline.sha256, artifact.baseline.size) ||
      artifact.source.mimeType !== "application/pdf" || artifact.source.sha256 !== source.sourceHash || artifact.source.size !== profile.resumeSource.size ||
      artifact.source.storageKey === profile.resumeSource.storageKey || !valid(artifact.source.storageKey, artifact.source.sha256, artifact.source.size) ||
      !valid(file.storageKey, file.sha256, file.size) || file.mimeType !== "application/pdf" || file.filename !== filename("resume"))
      throw new Error("The saved PDF résumé does not match its reviewed source and layout checks. Rebuild the packet.");
    if (hashJson(file.factIds) !== hashJson([...new Set(plan.claims.flatMap((claim) => claim.factIds))])) throw new Error("The saved PDF résumé cites facts outside its reviewed source plan.");
    return;
  }
  if (artifact.format === "docx") {
    const source = profile.resumeSourceDocument;
    const plan = packet.resumeSourcePlan;
    if (packet.schemaVersion !== 3 || !source || source.support.status !== "candidate" || !plan || !profile.resumeSource) throw new Error("The inspected DOCX source is no longer available. Rebuild the packet.");
    const factsHash = hashJson(factEvidenceSnapshot(profile.facts));
    const evidenceValid = validateSourcePlanEvidence({ source, profile, claims: plan.claims, edits: plan.edits, grounding: plan.grounding, evidencePolicyVersion: planEvidencePolicy(plan) });
    if (plan.version !== 1 || plan.format !== "docx" || plan.sourceHash !== source.sourceHash || plan.representationVersion !== source.version ||
      plan.profileHash !== sourceProfileHash(profile) || plan.factsHash !== factsHash || plan.settingsHash !== hashJson(profile.automationSettings ?? null) ||
      !/^[a-f0-9]{64}$/.test(plan.jobHash) || !evidenceValid) throw new Error("The DOCX source plan is stale or does not preserve the complete reviewed source.");
    const inputHash = docxInputHash(plan);
    const valid = (key: string | undefined, hash: string, size: number, extension: string) =>
      /^[a-f0-9]{64}$/.test(hash) && Number.isInteger(size) && size > 0 && size <= 5 * 1024 * 1024 && key === `${profile.id}/${inputHash}/${hash}.${extension}`;
    const expectedRendererVersion = process.env.DOCX_RENDERER_VERSION ?? "26.8.0.3";
    const rendererName = expectedRendererVersion.includes("alpha") ? "LibreOfficeDev" : "LibreOffice";
    const expectedPageCount = plan.sourceLayout?.pages.length ?? 1;
    const expectedLayoutPolicy = docxPolicyFor(plan);
    const artifactPages = pageRecords(artifact.layoutValidation.pages);
    const pageValidationMatches = plan.sourceLayout
      ? artifact.layoutValidation.layoutHash === plan.layoutHash && hashJson(artifactPages) === hashJson(plan.sourceLayout.pages) && artifact.layoutValidation.pages?.length === expectedPageCount
      : artifact.layoutValidation.layoutHash === undefined && artifact.layoutValidation.pages === undefined;
    if (artifact.inputHash !== inputHash || artifact.pageCount !== expectedPageCount || artifact.renderer !== `libreoffice-${expectedRendererVersion}` || !artifact.rendererVersion.startsWith(`${rendererName} ${expectedRendererVersion}`) || artifact.sourceHash !== source.sourceHash ||
      artifact.representationVersion !== source.version || artifact.profileHash !== plan.profileHash || artifact.factsHash !== plan.factsHash || artifact.settingsHash !== plan.settingsHash ||
      artifact.jobHash !== plan.jobHash || artifact.layoutPolicy !== expectedLayoutPolicy || !sourceLayoutMatchesPlan(plan, source) || !pageValidationMatches || artifact.layoutValidation?.outcome !== "passed" ||
      artifact.layoutValidation?.unchangedAnchorTolerancePt !== 1 || artifact.layoutValidation?.pageSizeTolerancePt !== 0.5 || artifact.layoutValidation?.visualOutsideEditTolerance !== 0.001 ||
      !Number.isFinite(artifact.layoutValidation?.visualOutsideEditDifference) || artifact.layoutValidation.visualOutsideEditDifference < 0 || artifact.layoutValidation.visualOutsideEditDifference > 0.001 ||
      !/^[a-f0-9]{64}$/.test(artifact.layoutValidation?.baselinePdfHash ?? "") || artifact.layoutValidation.pageWidthPt <= 0 || artifact.layoutValidation.pageHeightPt <= 0 ||
      artifact.source.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || artifact.source.storageKey === profile.resumeSource.storageKey ||
      !artifact.baseline || artifact.baseline.mimeType !== "application/pdf" || artifact.baseline.sha256 !== artifact.layoutValidation.baselinePdfHash ||
      !valid(artifact.baseline.storageKey, artifact.baseline.sha256, artifact.baseline.size, "pdf") ||
      !valid(file.storageKey, file.sha256, file.size, "pdf") || file.mimeType !== "application/pdf" || file.filename !== "tailored-resume.pdf" ||
      !valid(artifact.source.storageKey, artifact.source.sha256, artifact.source.size, "docx")) throw new Error("The saved DOCX résumé does not match its reviewed source and layout checks. Rebuild the packet.");
    if (hashJson(file.factIds) !== hashJson([...new Set(plan.claims.flatMap((claim) => claim.factIds))])) throw new Error("The saved DOCX résumé cites facts outside its reviewed source plan.");
    return;
  }
  const doc = packet.resumeDocument;
  if (!doc) throw new Error("Prepare the LaTeX application files before review.");
  validateResumeDocument(profile, doc);
  const inputHash = resumeInputHash(profile, doc);
  const valid = (key: string | undefined, hash: string, size: number, extension: string) =>
    /^[a-f0-9]{64}$/.test(hash) && Number.isInteger(size) && size > 0 && size <= 5 * 1024 * 1024 && key === `${profile.id}/${inputHash}/${hash}.${extension}`;
  if (artifact.inputHash !== inputHash || artifact.pageCount !== 1 || artifact.compiler !== "tectonic-0.17.0" ||
    !valid(file.storageKey, file.sha256, file.size, "pdf") || !valid(artifact.source.storageKey, artifact.source.sha256, artifact.source.size, "tex")) throw new Error("The saved resume does not match its reviewed content. Rebuild the packet.");
}
export async function withPacketFiles(profile: Profile, original: ApplicationPacket, deadline = Date.now() + 90_000, beforeRender?: () => Promise<void>, validatedSourceRender?: ValidatedSourceRender): Promise<ApplicationPacket> {
  let packet = { ...original };
  let resumeFile: PacketFile;
  if (packet.resumeMode === "original") {
    if (!packet.originalResume) throw new Error("The confirmed original résumé is missing.");
    await readOriginalResume(profile.id, packet.originalResume);
    resumeFile = { kind: "resume", ...packet.originalResume, storageBucket: "resumes", factIds: [] };
  } else if (packet.schemaVersion === 2) {
    if (!packet.resumeDocument) throw new Error("The structured resume is missing. Rebuild the packet.");
    validateResumeDocument(profile, packet.resumeDocument);
    if (packet.resumeArtifact) {
      validateResumeArtifact(profile, packet);
      resumeFile = packet.files!.find((file) => file.kind === "resume")!;
      // Only the saved artifact is used on answer/essay/cover-letter revisions.
      await readArtifact(profile.id, resumeFile.storageKey!, resumeFile.sha256, resumeFile.size);
    } else {
      let fitted: Awaited<ReturnType<typeof fitResume>>;
      try { fitted = await fitResume(profile, packet.resumeDocument, deadline); }
      catch (error) {
        const grounding = packet.resumeDocument.grounding;
        const message = error instanceof Error && /^(?:compiler unavailable|Resume compilation timed out|Resume compilation is temporarily unavailable|The resume contains|The resume cannot fit|LaTeX compilation failed)/i.test(error.message)
          ? error.message : "The resume file could not be prepared. Retry the draft; your last valid packet is preserved.";
        throw new ResumeDraftError({ version: 1, outcome: "technical_failure", writerAttempts: grounding?.writerAttempts ?? 0, checkerAttempts: grounding?.checkerAttempts ?? 0,
          repairAttempts: grounding?.repairAttempts ?? 0, findings: [], requiredInformation: [], technicalFailure: "renderer" }, message);
      }
      validateResumeDocument(profile, fitted.document);
      const inputHash = resumeInputHash(profile, fitted.document);
      const pdf = await saveArtifact(profile.id, inputHash, fitted.pdf, "pdf");
      const source = await saveArtifact(profile.id, inputHash, Buffer.from(fitted.source), "tex");
      packet = { ...packet, resumeDocument: fitted.document, resumeLines: resumeFields(fitted.document).map(({ text, factIds }) => ({ text, factIds })),
        resumeArtifact: { inputHash, pageCount: 1, compiler: "tectonic-0.17.0", source } };
      resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", ...pdf, factIds: resumeFactIds(fitted.document) };
    }
  } else if (packet.schemaVersion === 3) {
    const plan = packet.resumeSourcePlan;
    if (!plan) throw new Error("The anchored source résumé plan is missing. Rebuild the packet.");
    if (packet.resumeArtifact) {
      if (packet.resumeArtifact.format !== plan.format) throw new Error("This source-preserving packet has an unsupported artifact format.");
      validateResumeArtifact(profile, packet);
      resumeFile = packet.files!.find((file) => file.kind === "resume")!;
      await readArtifact(profile.id, resumeFile.storageKey!, resumeFile.sha256, resumeFile.size);
      await readArtifact(profile.id, packet.resumeArtifact.baseline.storageKey, packet.resumeArtifact.baseline.sha256, packet.resumeArtifact.baseline.size);
      await readArtifact(profile.id, packet.resumeArtifact.source.storageKey, packet.resumeArtifact.source.sha256, packet.resumeArtifact.source.size);
    } else {
      validateResumeArtifactInputs(profile, packet);
      if (plan.format === "pdf") {
        let rendered: Awaited<ReturnType<typeof renderPdfResume>>;
        try { rendered = validatedSourceRender?.plan === plan && validatedSourceRender.format === "pdf" ? validatedSourceRender.rendered : await renderPdfResume(profile, plan, deadline, beforeRender); }
        catch (error) {
          if (error instanceof ResumeDraftError) throw error;
          throw new ResumeDraftError({ version: 1, outcome: "technical_failure", writerAttempts: plan.grounding.writerAttempts, checkerAttempts: plan.grounding.checkerAttempts,
            repairAttempts: plan.grounding.repairAttempts, findings: [], requiredInformation: [], technicalFailure: "renderer" }, error instanceof Error ? error.message : "The PDF layout could not be checked. Your last valid packet is preserved.");
        }
        const inputHash = pdfInputHash(plan);
        const pdf = await saveArtifact(profile.id, inputHash, rendered.pdf, "pdf");
        const baseline = await saveArtifact(profile.id, inputHash, rendered.baselinePdf, "pdf");
        const source = await saveArtifact(profile.id, inputHash, rendered.sourcePdf, "pdf");
        packet = { ...packet, resumeArtifact: { format: "pdf", inputHash, pageCount: rendered.pages.length, renderer: rendered.renderer, rendererVersion: rendered.rendererVersion,
          javaVersion: rendered.javaVersion, runtimeArchitecture: rendered.runtimeArchitecture, sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
          profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash, layoutPolicy: pdfPolicyFor(plan),
          layoutValidation: { outcome: "passed", pageWidthPt: rendered.pageWidthPt, pageHeightPt: rendered.pageHeightPt, unchangedAnchorTolerancePt: 0.5,
            pageSizeTolerancePt: 0.5, visualMaskPaddingPt: 2.5, visualOutsideEditTolerance: 0, visualOutsideEditDifferenceAt144Dpi: 0,
            visualOutsideEditDifferenceAt300Dpi: 0, baselinePdfHash: rendered.baselinePdfHash, pages: rendered.pages, ...(plan.layoutHash ? { layoutHash: plan.layoutHash } : {}) },
          baseline: { ...baseline, mimeType: "application/pdf" }, source: { ...source, mimeType: "application/pdf" } } };
        resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", ...pdf, factIds: [...new Set(plan.claims.flatMap((claim) => claim.factIds))] };
      } else {
        let rendered: Awaited<ReturnType<typeof renderDocxResume>>;
        try { rendered = validatedSourceRender?.plan === plan && validatedSourceRender.format === "docx" ? validatedSourceRender.rendered : await renderDocxResume(profile, plan, deadline, beforeRender); }
        catch (error) {
          if (error instanceof ResumeDraftError) throw error;
          throw new ResumeDraftError({ version: 1, outcome: "technical_failure", writerAttempts: plan.grounding.writerAttempts, checkerAttempts: plan.grounding.checkerAttempts,
            repairAttempts: plan.grounding.repairAttempts, findings: [], requiredInformation: [], technicalFailure: "renderer" }, error instanceof Error ? error.message : "The DOCX layout could not be checked. Your last valid packet is preserved.");
        }
        const inputHash = docxInputHash(plan);
        const pdf = await saveArtifact(profile.id, inputHash, rendered.pdf, "pdf");
        const baseline = await saveArtifact(profile.id, inputHash, rendered.baselinePdf, "pdf");
        const source = await saveArtifact(profile.id, inputHash, rendered.docx, "docx");
        packet = { ...packet, resumeArtifact: { format: "docx", inputHash, pageCount: rendered.pageCount, renderer: rendered.renderer, rendererVersion: rendered.rendererVersion, sourceHash: plan.sourceHash,
          representationVersion: 1, profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
          layoutPolicy: docxPolicyFor(plan), layoutValidation: { outcome: "passed", pageWidthPt: rendered.pageWidthPt, pageHeightPt: rendered.pageHeightPt, pages: rendered.pages, layoutHash: rendered.layoutHash,
            unchangedAnchorTolerancePt: 1, pageSizeTolerancePt: 0.5, visualOutsideEditTolerance: 0.001, visualOutsideEditDifference: rendered.visualOutsideEditDifference, baselinePdfHash: rendered.baselinePdfHash },
          baseline: { ...baseline, mimeType: "application/pdf" },
          source: { ...source, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } } };
        resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", ...pdf, factIds: [...new Set(plan.claims.flatMap((claim) => claim.factIds))] };
      }
    }
  } else {
    const inputHash = legacyResumeInputHash(profile, packet);
    const saved = packet.files?.find((file) => file.kind === "resume");
    if (saved?.storageKey?.startsWith(`${profile.id}/${inputHash}/`)) {
      await readArtifact(profile.id, saved.storageKey, saved.sha256, saved.size); resumeFile = saved;
    } else {
      const bytes = await render(profile, packet, "resume");
      const artifact = await saveArtifact(profile.id, inputHash, bytes, "pdf");
      resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", ...artifact, storageBucket: "application-files", factIds: [...new Set(packet.resumeLines.flatMap((line) => line.factIds))] };
    }
  }
  const files = [resumeFile];
  if (packet.coverLetter) {
    const inputHash = coverInputHash(packet);
    const saved = packet.files?.find((file) => file.kind === "cover-letter");
    if (saved?.storageKey?.startsWith(`${profile.id}/${inputHash}/`)) {
      await readArtifact(profile.id, saved.storageKey, saved.sha256, saved.size); files.push(saved);
    } else {
      const bytes = await render(profile, packet, "cover-letter");
      const artifact = await saveArtifact(profile.id, inputHash, bytes, "pdf");
      files.push({ kind: "cover-letter", filename: filename("cover-letter"), mimeType: "application/pdf", ...artifact, storageBucket: "application-files", factIds: [...new Set(packet.coverLetterFactIds ?? [])] });
    }
  }
  return { ...packet, schemaVersion: packet.schemaVersion ?? 1, files };
}
export async function reviewedPacketFile(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  const file = packet.files?.find((item) => item.kind === kind);
  if (kind === "resume" && packet.resumeMode === "original") {
    if (!packet.originalResume || !file) throw new Error("The confirmed original résumé is missing.");
    validateOriginalResume(profile.id, packet.originalResume);
    if (file.filename !== packet.originalResume.filename || file.mimeType !== packet.originalResume.mimeType || file.storageKey !== packet.originalResume.storageKey || file.sha256 !== packet.originalResume.sha256 || file.size !== packet.originalResume.size) throw new Error("The original résumé attachment changed.");
    return { bytes: await readOriginalResume(profile.id, packet.originalResume), filename: file.filename, mimeType: file.mimeType };
  }
  if (kind === "resume" && packet.schemaVersion === 2) {
    validateResumeArtifact(profile, packet);
    const bytes = await readArtifact(profile.id, file!.storageKey!, file!.sha256, file!.size);
    return { bytes, filename: filename(kind), mimeType: "application/pdf" };
  }
  if (kind === "resume" && packet.schemaVersion === 3) {
    validateResumeArtifact(profile, packet);
    const bytes = await readArtifact(profile.id, file!.storageKey!, file!.sha256, file!.size);
    return { bytes, filename: filename(kind), mimeType: "application/pdf" };
  }
  if (file?.storageKey) {
    const inputHash = kind === "resume" ? legacyResumeInputHash(profile, packet) : coverInputHash(packet);
    if (file.filename !== filename(kind) || file.mimeType !== "application/pdf" || file.storageKey !== `${profile.id}/${inputHash}/${file.sha256}.pdf`) throw new Error("The application file changed or no longer matches its current content.");
    const bytes = await readArtifact(profile.id, file.storageKey, file.sha256, file.size);
    return { bytes, filename: file.filename, mimeType: file.mimeType };
  }
  const bytes = await render(profile, packet, kind);
  if ((!file && packet.schemaVersion !== undefined) || (file &&
    (file.sha256 !== bytesHash(bytes) || file.size !== bytes.length || file.filename !== filename(kind) || file.mimeType !== "application/pdf"))) throw new Error("The application file changed. Prepare and review a new packet before filling.");
  return { bytes, filename: filename(kind), mimeType: "application/pdf" };
}

export interface ResumeComparisonFile { bytes: Buffer; filename: string; mimeType: "application/pdf" }
export interface ResumeComparisonFiles {
  baseline: ResumeComparisonFile;
  tailored: ResumeComparisonFile;
  stale: boolean;
  staleReasons?: string[];
}

/**
 * Reads the immutable source-layout baseline and exact résumé attachment for
 * inspection. Persisted hashes and owner-scoped keys are checked against the
 * saved packet, while current input mismatches are reported separately so an
 * old version can be identified without presenting it as current.
 */
export async function reviewedResumeComparisonFiles(profile: Profile, packet: ApplicationPacket): Promise<ResumeComparisonFiles> {
  const plan = packet.resumeSourcePlan;
  const artifact = packet.resumeArtifact;
  const file = packet.files?.find((item) => item.kind === "resume");
  if (packet.schemaVersion !== 3 || !plan || !artifact || (plan.format !== "docx" && plan.format !== "pdf") || artifact.format !== plan.format || !file || packet.resumeMode === "original")
    throw new Error("This packet has no source-preserving résumé comparison.");

  const inputHash = sourceInputHash(plan);
  const validStoredFile = (key: string | undefined, hash: string, size: number, extension: "pdf" | "docx") =>
    /^[a-f0-9]{64}$/.test(hash) && Number.isInteger(size) && size > 0 && size <= 5 * 1024 * 1024 &&
    key === `${profile.id}/${inputHash}/${hash}.${extension}`;
  const layout = artifact.layoutValidation;
  const expectedPageCount = plan.sourceLayout?.pages.length ?? 1;
  const expectedLayoutPolicy = policyFor(plan);
  const artifactPages = pageRecords(layout?.pages);
  const layoutMatches = artifact.format === "pdf"
    ? artifact.renderer === "apache-pdfbox" && artifact.rendererVersion === "3.0.8" && /^\d+(?:\.\d+){1,3}(?:\+\S+)?$/.test(artifact.javaVersion) &&
      /^(?:linux|darwin)-(?:x64|arm64)$/.test(artifact.runtimeArchitecture) && artifact.layoutPolicy === expectedLayoutPolicy && layout?.outcome === "passed" &&
      layout.unchangedAnchorTolerancePt === 0.5 && layout.pageSizeTolerancePt === 0.5 && layout.visualMaskPaddingPt === (plan.layoutHash && plan.sourceLayout ? 2.5 : 1.5) && layout.visualOutsideEditTolerance === 0 &&
      layout.visualOutsideEditDifferenceAt144Dpi === 0 && layout.visualOutsideEditDifferenceAt300Dpi === 0 &&
      layout.layoutHash === plan.layoutHash && (!plan.sourceLayout || hashJson(artifactPages) === hashJson(plan.sourceLayout.pages)) &&
      Number.isFinite(layout.pageWidthPt) && layout.pageWidthPt > 0 && Number.isFinite(layout.pageHeightPt) && layout.pageHeightPt > 0
    : artifact.renderer === `libreoffice-${process.env.DOCX_RENDERER_VERSION ?? "26.8.0.3"}` && artifact.layoutPolicy === expectedLayoutPolicy && layout?.outcome === "passed" &&
      layout.unchangedAnchorTolerancePt === 1 && layout.pageSizeTolerancePt === 0.5 && layout.visualOutsideEditTolerance === 0.001 &&
      layout.layoutHash === plan.layoutHash && (plan.sourceLayout ? layout.pages?.length === expectedPageCount && hashJson(artifactPages) === hashJson(plan.sourceLayout.pages) : layout.pages === undefined && layout.layoutHash === undefined) &&
      Number.isFinite(layout.visualOutsideEditDifference) && layout.visualOutsideEditDifference >= 0 && layout.visualOutsideEditDifference <= 0.001 &&
      Number.isFinite(layout.pageWidthPt) && layout.pageWidthPt > 0 && Number.isFinite(layout.pageHeightPt) && layout.pageHeightPt > 0;
  const sourceExtension = plan.format === "pdf" ? "pdf" : "docx";
  const sourceMimeType = plan.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const sourceConsistent = artifact.format !== "pdf" || (artifact.source.sha256 === plan.sourceHash && artifact.baseline.sha256 === plan.sourceHash &&
    artifact.source.size === artifact.baseline.size && layout?.baselinePdfHash === plan.sourceHash);
  if (plan.version !== 1 || !/^[a-f0-9]{64}$/.test(plan.sourceHash) || !/^[a-f0-9]{64}$/.test(plan.profileHash) ||
      !/^[a-f0-9]{64}$/.test(plan.factsHash) || !/^[a-f0-9]{64}$/.test(plan.settingsHash) || !/^[a-f0-9]{64}$/.test(plan.jobHash) ||
      artifact.inputHash !== inputHash || artifact.pageCount !== expectedPageCount || artifact.sourceHash !== plan.sourceHash || artifact.representationVersion !== plan.representationVersion ||
      artifact.profileHash !== plan.profileHash || artifact.factsHash !== plan.factsHash || artifact.settingsHash !== plan.settingsHash || artifact.jobHash !== plan.jobHash ||
      !layoutMatches || !sourceConsistent || !/^[a-f0-9]{64}$/.test(layout.baselinePdfHash) ||
      artifact.baseline.mimeType !== "application/pdf" || artifact.baseline.sha256 !== layout.baselinePdfHash ||
      artifact.source.mimeType !== sourceMimeType || artifact.source.storageKey === profile.resumeSource?.storageKey ||
      !validStoredFile(artifact.baseline.storageKey, artifact.baseline.sha256, artifact.baseline.size, "pdf") ||
      !validStoredFile(artifact.source.storageKey, artifact.source.sha256, artifact.source.size, sourceExtension) ||
      !validStoredFile(file.storageKey, file.sha256, file.size, "pdf") || file.mimeType !== "application/pdf" || file.filename !== filename("resume") ||
      hashJson(packet.resumeLines) !== hashJson(plan.claims.map(({ text, factIds }) => ({ text, factIds }))) ||
      hashJson(file.factIds) !== hashJson([...new Set(plan.claims.flatMap((claim) => claim.factIds))]) ||
      plan.grounding.findings.length !== plan.claims.length || plan.grounding.findings.some((finding) => finding.outcome !== "supported"))
    throw new Error("The saved résumé comparison baseline, tailored file, or layout records do not match its persisted plan and artifact metadata.");

  const baselineBytes = await readArtifact(profile.id, artifact.baseline.storageKey, artifact.baseline.sha256, artifact.baseline.size);
  const tailoredBytes = await readArtifact(profile.id, file.storageKey!, file.sha256, file.size);
  const staleReasons: string[] = [];
  const source = profile.resumeSourceDocument;
  if (!source || source.support.status !== "candidate" || source.sourceHash !== plan.sourceHash || profile.resumeSource?.sha256 !== plan.sourceHash) staleReasons.push("source");
  if (!source || source.format !== plan.format || source.version !== plan.representationVersion) staleReasons.push("representation");
  if (!source || !sourceLayoutMatchesPlan(plan, source)) staleReasons.push("layout");
  const factsHash = hashJson(factEvidenceSnapshot(profile.facts));
  if (factsHash !== plan.factsHash) staleReasons.push("facts");
  if (hashJson(profile.automationSettings ?? null) !== plan.settingsHash) staleReasons.push("settings");
  if (sourceProfileHash(profile) !== plan.profileHash) staleReasons.push("profile");
  if (staleReasons.length === 0) validateResumeArtifact(profile, packet);

  return {
    baseline: { bytes: baselineBytes, filename: "original-layout-preview.pdf", mimeType: "application/pdf" },
    tailored: { bytes: tailoredBytes, filename: file.filename, mimeType: "application/pdf" },
    stale: staleReasons.length > 0,
    ...(staleReasons.length ? { staleReasons } : {}),
  };
}

export async function reviewedResumeSource(profile: Profile, packet: ApplicationPacket) {
  if (packet.schemaVersion === 3 && packet.resumeArtifact?.format === "docx") {
    validateResumeArtifact(profile, packet);
    const source = packet.resumeArtifact.source;
    return { bytes: await readArtifact(profile.id, source.storageKey, source.sha256, source.size), filename: "tailored-resume.docx", mimeType: source.mimeType };
  }
  if (packet.schemaVersion === 3 && packet.resumeArtifact?.format === "pdf") {
    validateResumeArtifact(profile, packet);
    const source = packet.resumeArtifact.source;
    return { bytes: await readArtifact(profile.id, source.storageKey, source.sha256, source.size), filename: "original-source.pdf", mimeType: source.mimeType };
  }
  if (packet.schemaVersion !== 2) throw new Error("This legacy packet has no editable source. Rebuild the resume first.");
  validateResumeArtifact(profile, packet);
  const source = packet.resumeArtifact!.source;
  return { bytes: await readArtifact(profile.id, source.storageKey, source.sha256, source.size), filename: "tailored-resume.tex", mimeType: "text/plain; charset=utf-8" };
}

function validateResumeArtifactInputs(profile: Profile, packet: ApplicationPacket): void {
  const plan = packet.resumeSourcePlan;
  const source = profile.resumeSourceDocument;
  const formatLabel = plan?.format === "pdf" ? "PDF" : "DOCX";
  if (!plan || !source || source.format !== plan.format || source.support.status !== "candidate" || plan.profileHash !== sourceProfileHash(profile) || plan.sourceHash !== source.sourceHash ||
    plan.factsHash !== hashJson(factEvidenceSnapshot(profile.facts)) ||
    plan.settingsHash !== hashJson(profile.automationSettings ?? null)) throw new Error(`The inspected ${formatLabel} source is unavailable or stale. Re-upload and confirm it before tailoring.`);
  if (!sourceLayoutMatchesPlan(plan, source)) throw new Error(`The inspected ${formatLabel} page/region map is missing, stale, or invalid. Re-upload and confirm it before tailoring.`);
  if (!validateSourcePlanEvidence({ source, profile, claims: plan.claims, edits: plan.edits, grounding: plan.grounding, evidencePolicyVersion: planEvidencePolicy(plan) }) ||
      hashJson(packet.resumeLines) !== hashJson(plan.claims.map(({ text, factIds }) => ({ text, factIds })))) throw new Error(`The ${formatLabel} source plan does not cover the complete reviewed résumé.`);
}

// Historical inspection verifies the bytes recorded at the durable claim. It
// cannot authorize a new upload and does not reinterpret later profile changes.
export async function historicalPacketFile(owner: string, file: PacketFile) {
  const bytes = file.storageBucket === "resumes" ? await readOriginalResume(owner, file)
    : file.storageKey ? await readArtifact(owner, file.storageKey, file.sha256, file.size) : undefined;
  if (!bytes || bytes.length !== file.size || bytesHash(bytes) !== file.sha256) throw new Error("The historical material is unavailable or changed.");
  return { bytes, filename: file.filename, mimeType: file.mimeType };
}
