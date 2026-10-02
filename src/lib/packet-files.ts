import { hashJson } from "@/lib/crypto";
import { ResumeDraftError } from "@/lib/resume-document";
import { readOriginalResume, validateOriginalResume } from "@/lib/original-resume";
import { coverLetterPdf, resumePdf } from "@/lib/resume-pdf";
import { fitResume } from "@/lib/latex-compiler";
import { resumeFactIds, resumeFields, resumeInputHash, validateResumeDocument } from "@/lib/resume-document";
import { bytesHash, readArtifact, saveArtifact } from "@/lib/resume-artifacts";
import { renderDocxResume } from "@/lib/docx-renderer";
import { sourceProfileHash } from "@/lib/resume-source-draft";
import type { ApplicationPacket, PacketFile, Profile, ResumeSourcePlan } from "@/lib/types";

export type PacketFileKind = PacketFile["kind"];
const legacyResumeInputHash = (profile: Profile, packet: ApplicationPacket) => hashJson({ kind: "resume", profile: { name: profile.name, email: profile.email, phone: profile.phone, school: profile.school, graduationYear: profile.graduationYear, skills: profile.skills }, lines: packet.resumeLines });
const coverInputHash = (packet: ApplicationPacket) => hashJson({ kind: "cover-letter", text: packet.coverLetter });
const docxLayoutPolicy = "docx-single-column-one-page-v1" as const;
function docxInputHash(plan: ResumeSourcePlan) {
  return hashJson({ kind: "source-preserving-docx", sourceHash: plan.sourceHash, representationVersion: plan.representationVersion,
    profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: docxLayoutPolicy, claims: plan.claims, edits: plan.edits, grounding: plan.grounding });
}
const filename = (kind: PacketFileKind) => kind === "resume" ? "tailored-resume.pdf" : "cover-letter.pdf";
async function render(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  if (kind === "resume") return resumePdf(profile, packet);
  if (!packet.coverLetter) throw new Error("This packet has no cover letter.");
  return coverLetterPdf(packet.coverLetter);
}
export function validateResumeArtifact(profile: Profile, packet: ApplicationPacket): void {
  const artifact = packet.resumeArtifact;
  const file = packet.files?.find((item) => item.kind === "resume");
  if (!artifact || !file) throw new Error("Prepare the application files before review.");
  if (artifact.format === "docx") {
    const source = profile.resumeSourceDocument;
    const plan = packet.resumeSourcePlan;
    if (packet.schemaVersion !== 3 || !source || source.support.status !== "candidate" || !plan || !profile.resumeSource) throw new Error("The inspected DOCX source is no longer available. Rebuild the packet.");
    const factsHash = hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) })));
    const candidateAnchors = source.anchors.filter((anchor) => anchor.candidateClaim);
    const claimIds = new Set(plan.claims.map((claim) => claim.anchorId));
    const editMap = new Map(plan.edits.map((edit) => [edit.anchorId, edit]));
    const verified = new Map(profile.facts.filter((fact) => fact.verified).map((fact) => [fact.id, fact]));
    if (plan.version !== 1 || plan.format !== "docx" || plan.sourceHash !== source.sourceHash || plan.representationVersion !== source.version ||
      plan.profileHash !== sourceProfileHash(profile) || plan.factsHash !== factsHash || plan.settingsHash !== hashJson(profile.automationSettings ?? null) ||
      !/^[a-f0-9]{64}$/.test(plan.jobHash) || candidateAnchors.length !== plan.claims.length || candidateAnchors.some((anchor) => !claimIds.has(anchor.id)) ||
      plan.claims.some((claim) => {
        const anchor = source.anchors.find((item) => item.id === claim.anchorId);
        const edit = editMap.get(claim.anchorId);
        return !anchor || !claim.factIds.length || claim.factIds.some((id) => !verified.has(id)) ||
          (anchor.kind !== "bullet" && claim.text !== anchor.text) ||
          (claim.text !== anchor.text && (!anchor.editable || !edit || edit.text !== claim.text || hashJson(edit.factIds) !== hashJson(claim.factIds))) ||
          (claim.text === anchor.text && edit !== undefined);
      }) || plan.edits.length !== [...editMap.keys()].length || plan.edits.some((edit) => !claimIds.has(edit.anchorId)) ||
      plan.grounding.findings.length !== plan.claims.length || plan.grounding.findings.some((finding) => finding.outcome !== "supported") ||
      plan.grounding.writerAttempts < 1 || plan.grounding.writerAttempts > 3 || plan.grounding.checkerAttempts < 1 || plan.grounding.checkerAttempts > 3 || plan.grounding.repairAttempts > 2) throw new Error("The DOCX source plan is stale or does not preserve the complete reviewed source.");
    const inputHash = docxInputHash(plan);
    const valid = (key: string | undefined, hash: string, size: number, extension: string) =>
      /^[a-f0-9]{64}$/.test(hash) && Number.isInteger(size) && size > 0 && size <= 5 * 1024 * 1024 && key === `${profile.id}/${inputHash}/${hash}.${extension}`;
    const expectedRendererVersion = process.env.DOCX_RENDERER_VERSION ?? "26.8.0.3";
    const rendererName = expectedRendererVersion.includes("alpha") ? "LibreOfficeDev" : "LibreOffice";
    if (artifact.inputHash !== inputHash || artifact.pageCount !== 1 || artifact.renderer !== `libreoffice-${expectedRendererVersion}` || !artifact.rendererVersion.startsWith(`${rendererName} ${expectedRendererVersion}`) || artifact.sourceHash !== source.sourceHash ||
      artifact.representationVersion !== source.version || artifact.profileHash !== plan.profileHash || artifact.factsHash !== plan.factsHash || artifact.settingsHash !== plan.settingsHash ||
      artifact.jobHash !== plan.jobHash || artifact.layoutPolicy !== docxLayoutPolicy || artifact.layoutValidation?.outcome !== "passed" ||
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
export async function withPacketFiles(profile: Profile, original: ApplicationPacket, deadline = Date.now() + 90_000, beforeRender?: () => Promise<void>): Promise<ApplicationPacket> {
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
    if (!plan) throw new Error("The anchored DOCX source plan is missing. Rebuild the packet.");
    if (packet.resumeArtifact) {
      if (packet.resumeArtifact.format !== "docx") throw new Error("This source-preserving packet has an unsupported artifact format.");
      validateResumeArtifact(profile, packet);
      resumeFile = packet.files!.find((file) => file.kind === "resume")!;
      await readArtifact(profile.id, resumeFile.storageKey!, resumeFile.sha256, resumeFile.size);
      await readArtifact(profile.id, packet.resumeArtifact.baseline.storageKey, packet.resumeArtifact.baseline.sha256, packet.resumeArtifact.baseline.size);
    } else {
      validateResumeArtifactInputs(profile, packet);
      let rendered: Awaited<ReturnType<typeof renderDocxResume>>;
      try { rendered = await renderDocxResume(profile, plan, deadline, beforeRender); }
      catch (error) {
        if (error instanceof ResumeDraftError) throw error;
        throw new ResumeDraftError({ version: 1, outcome: "technical_failure", writerAttempts: plan.grounding.writerAttempts, checkerAttempts: plan.grounding.checkerAttempts,
          repairAttempts: plan.grounding.repairAttempts, findings: [], requiredInformation: [], technicalFailure: "renderer" }, error instanceof Error ? error.message : "The DOCX layout could not be checked. Your last valid packet is preserved.");
      }
      const inputHash = docxInputHash(plan);
      const pdf = await saveArtifact(profile.id, inputHash, rendered.pdf, "pdf");
      const baseline = await saveArtifact(profile.id, inputHash, rendered.baselinePdf, "pdf");
      const source = await saveArtifact(profile.id, inputHash, rendered.docx, "docx");
      packet = { ...packet, resumeArtifact: { format: "docx", inputHash, pageCount: 1, renderer: rendered.renderer, rendererVersion: rendered.rendererVersion, sourceHash: plan.sourceHash,
        representationVersion: plan.representationVersion, profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
        layoutPolicy: docxLayoutPolicy, layoutValidation: { outcome: "passed", pageWidthPt: rendered.pageWidthPt, pageHeightPt: rendered.pageHeightPt,
          unchangedAnchorTolerancePt: 1, pageSizeTolerancePt: 0.5, visualOutsideEditTolerance: 0.001, visualOutsideEditDifference: rendered.visualOutsideEditDifference, baselinePdfHash: rendered.baselinePdfHash },
        baseline: { ...baseline, mimeType: "application/pdf" },
        source: { ...source, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } } };
      resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", ...pdf, factIds: [...new Set(plan.claims.flatMap((claim) => claim.factIds))] };
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
export async function reviewedResumeSource(profile: Profile, packet: ApplicationPacket) {
  if (packet.schemaVersion === 3 && packet.resumeArtifact?.format === "docx") {
    validateResumeArtifact(profile, packet);
    const source = packet.resumeArtifact.source;
    return { bytes: await readArtifact(profile.id, source.storageKey, source.sha256, source.size), filename: "tailored-resume.docx", mimeType: source.mimeType };
  }
  if (packet.schemaVersion !== 2) throw new Error("This legacy packet has no editable source. Rebuild the resume first.");
  validateResumeArtifact(profile, packet);
  const source = packet.resumeArtifact!.source;
  return { bytes: await readArtifact(profile.id, source.storageKey, source.sha256, source.size), filename: "tailored-resume.tex", mimeType: "text/plain; charset=utf-8" };
}

function validateResumeArtifactInputs(profile: Profile, packet: ApplicationPacket): void {
  const plan = packet.resumeSourcePlan;
  const source = profile.resumeSourceDocument;
  if (!plan || !source || source.support.status !== "candidate" || plan.profileHash !== sourceProfileHash(profile) || plan.sourceHash !== source.sourceHash ||
    plan.factsHash !== hashJson(profile.facts.filter((fact) => fact.verified).map(({ id, text, source, sourceAnchorId }) => ({ id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))) ||
    plan.settingsHash !== hashJson(profile.automationSettings ?? null)) throw new Error("The DOCX source plan is stale. Review the source and confirmed facts before drafting again.");
  const claims = new Map(plan.claims.map((claim) => [claim.anchorId, claim]));
  const anchors = source.anchors.filter((anchor) => anchor.candidateClaim);
  if (claims.size !== anchors.length || anchors.some((anchor) => !claims.has(anchor.id)) ||
    hashJson(packet.resumeLines) !== hashJson(plan.claims.map(({ text, factIds }) => ({ text, factIds })))) throw new Error("The DOCX source plan does not cover the complete reviewed résumé.");
}

// Historical inspection verifies the bytes recorded at the durable claim. It
// cannot authorize a new upload and does not reinterpret later profile changes.
export async function historicalPacketFile(owner: string, file: PacketFile) {
  const bytes = file.storageBucket === "resumes" ? await readOriginalResume(owner, file)
    : file.storageKey ? await readArtifact(owner, file.storageKey, file.sha256, file.size) : undefined;
  if (!bytes || bytes.length !== file.size || bytesHash(bytes) !== file.sha256) throw new Error("The historical material is unavailable or changed.");
  return { bytes, filename: file.filename, mimeType: file.mimeType };
}
