import { coverLetterPdf, resumePdf } from "@/lib/resume-pdf";
import { fitResume } from "@/lib/latex-compiler";
import { resumeFactIds, resumeFields, resumeInputHash, validateResumeDocument } from "@/lib/resume-document";
import { bytesHash, readArtifact, saveArtifact } from "@/lib/resume-artifacts";
import type { ApplicationPacket, PacketFile, Profile } from "@/lib/types";

export type PacketFileKind = PacketFile["kind"];
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
  if (packet.schemaVersion === 2) {
    if (!packet.resumeDocument) throw new Error("The structured resume is missing. Rebuild the packet.");
    validateResumeDocument(profile, packet.resumeDocument);
    if (packet.resumeArtifact) {
      validateResumeArtifact(profile, packet);
      resumeFile = packet.files!.find((file) => file.kind === "resume")!;
      // Only the saved artifact is used on answer/essay/cover-letter revisions.
      await readArtifact(profile.id, resumeFile.storageKey!, resumeFile.sha256, resumeFile.size);
    } else {
      const fitted = await fitResume(profile, packet.resumeDocument, deadline);
      validateResumeDocument(profile, fitted.document);
      const inputHash = resumeInputHash(profile, fitted.document);
      const pdf = await saveArtifact(profile.id, inputHash, fitted.pdf, "pdf");
      const source = await saveArtifact(profile.id, inputHash, Buffer.from(fitted.source), "tex");
      packet = { ...packet, resumeDocument: fitted.document, resumeLines: resumeFields(fitted.document).map(({ text, factIds }) => ({ text, factIds })),
        resumeArtifact: { inputHash, pageCount: 1, compiler: "tectonic-0.17.0", source } };
      resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", ...pdf, factIds: resumeFactIds(fitted.document) };
    }
  } else {
    const bytes = await render(profile, packet, "resume");
    resumeFile = { kind: "resume", filename: filename("resume"), mimeType: "application/pdf", sha256: bytesHash(bytes), size: bytes.length, factIds: [...new Set(packet.resumeLines.flatMap((line) => line.factIds))] };
  }
  const files = [resumeFile];
  if (packet.coverLetter) {
    const bytes = await render(profile, packet, "cover-letter");
    files.push({ kind: "cover-letter", filename: filename("cover-letter"), mimeType: "application/pdf", sha256: bytesHash(bytes), size: bytes.length, factIds: [...new Set(packet.coverLetterFactIds ?? [])] });
  }
  return { ...packet, schemaVersion: packet.schemaVersion ?? 1, files };
}
export async function reviewedPacketFile(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  const file = packet.files?.find((item) => item.kind === kind);
  if (kind === "resume" && packet.schemaVersion === 2) {
    validateResumeArtifact(profile, packet);
    const bytes = await readArtifact(profile.id, file!.storageKey!, file!.sha256, file!.size);
    return { bytes, filename: filename(kind), mimeType: "application/pdf" };
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
