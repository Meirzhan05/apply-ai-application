import { hashJson } from "@/lib/crypto";
import { ResumeDraftError } from "@/lib/resume-document";
import { readOriginalResume, validateOriginalResume } from "@/lib/original-resume";
import { coverLetterPdf, resumePdf } from "@/lib/resume-pdf";
import { fitResume } from "@/lib/latex-compiler";
import { resumeFactIds, resumeFields, resumeInputHash, validateResumeDocument } from "@/lib/resume-document";
import { bytesHash, readArtifact, saveArtifact } from "@/lib/resume-artifacts";
import type { ApplicationPacket, PacketFile, Profile } from "@/lib/types";

export type PacketFileKind = PacketFile["kind"];
const legacyResumeInputHash = (profile: Profile, packet: ApplicationPacket) => hashJson({ kind: "resume", profile: { name: profile.name, email: profile.email, phone: profile.phone, school: profile.school, graduationYear: profile.graduationYear, skills: profile.skills }, lines: packet.resumeLines });
const coverInputHash = (packet: ApplicationPacket) => hashJson({ kind: "cover-letter", text: packet.coverLetter });
const filename = (kind: PacketFileKind) => kind === "resume" ? "tailored-resume.pdf" : "cover-letter.pdf";
async function render(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  if (kind === "resume") return resumePdf(profile, packet);
  if (!packet.coverLetter) throw new Error("This packet has no cover letter.");
  return coverLetterPdf(packet.coverLetter);
}
export function validateResumeArtifact(profile: Profile, packet: ApplicationPacket): void {
  const doc = packet.resumeDocument;
  const artifact = packet.resumeArtifact;
  const file = packet.files?.find((item) => item.kind === "resume");
  if (!doc || !artifact || !file) throw new Error("Prepare the LaTeX application files before review.");
  validateResumeDocument(profile, doc);
  const inputHash = resumeInputHash(profile, doc);
  const valid = (key: string | undefined, hash: string, size: number, extension: string) =>
    /^[a-f0-9]{64}$/.test(hash) && Number.isInteger(size) && size > 0 && size <= 5 * 1024 * 1024 && key === `${profile.id}/${inputHash}/${hash}.${extension}`;
  if (artifact.inputHash !== inputHash || artifact.pageCount !== 1 || artifact.compiler !== "tectonic-0.17.0" ||
    !valid(file.storageKey, file.sha256, file.size, "pdf") || !valid(artifact.source.storageKey, artifact.source.sha256, artifact.source.size, "tex")) throw new Error("The saved resume does not match its reviewed content. Rebuild the packet.");
}
export async function withPacketFiles(profile: Profile, original: ApplicationPacket, deadline = Date.now() + 90_000): Promise<ApplicationPacket> {
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
  if (packet.schemaVersion !== 2) throw new Error("This legacy packet has no LaTeX source. Rebuild the resume first.");
  validateResumeArtifact(profile, packet);
  const source = packet.resumeArtifact!.source;
  return { bytes: await readArtifact(profile.id, source.storageKey, source.sha256, source.size), filename: "tailored-resume.tex", mimeType: "text/plain; charset=utf-8" };
}

// Historical inspection verifies the bytes recorded at the durable claim. It
// cannot authorize a new upload and does not reinterpret later profile changes.
export async function historicalPacketFile(owner: string, file: PacketFile) {
  const bytes = file.storageBucket === "resumes" ? await readOriginalResume(owner, file)
    : file.storageKey ? await readArtifact(owner, file.storageKey, file.sha256, file.size) : undefined;
  if (!bytes || bytes.length !== file.size || bytesHash(bytes) !== file.sha256) throw new Error("The historical material is unavailable or changed.");
  return { bytes, filename: file.filename, mimeType: file.mimeType };
}
