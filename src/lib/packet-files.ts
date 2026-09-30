import { createHash } from "node:crypto";
import { coverLetterPdf, resumePdf } from "@/lib/resume-pdf";
import type { ApplicationPacket, PacketFile, Profile } from "@/lib/types";

export type PacketFileKind = PacketFile["kind"];
const filename = (kind: PacketFileKind) => kind === "resume" ? "tailored-resume.pdf" : "cover-letter.pdf";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function render(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  if (kind === "resume") return resumePdf(profile, packet);
  if (!packet.coverLetter) throw new Error("This packet has no cover letter.");
  return coverLetterPdf(packet.coverLetter);
}

export async function withPacketFiles(profile: Profile, packet: ApplicationPacket): Promise<ApplicationPacket> {
  const kinds: PacketFileKind[] = packet.coverLetter ? ["resume", "cover-letter"] : ["resume"];
  const files = await Promise.all(kinds.map(async (kind): Promise<PacketFile> => {
    const bytes = await render(profile, packet, kind);
    return { kind, filename: filename(kind), mimeType: "application/pdf", sha256: digest(bytes), size: bytes.length,
      factIds: [...new Set(kind === "resume" ? packet.resumeLines.flatMap((line) => line.factIds) : packet.coverLetterFactIds ?? [])] };
  }));
  return { ...packet, schemaVersion: 1, files };
}

export async function reviewedPacketFile(profile: Profile, packet: ApplicationPacket, kind: PacketFileKind) {
  const bytes = await render(profile, packet, kind);
  const file = packet.files?.find((item) => item.kind === kind);
  // Legacy packets predate file manifests. Their consent semantics are kept;
  // every new or edited packet includes an explicit manifest.
  if ((!file && packet.schemaVersion !== undefined) || (file &&
    (file.sha256 !== digest(bytes) || file.size !== bytes.length || file.filename !== filename(kind) || file.mimeType !== "application/pdf"))) {
    throw new Error("The application file changed. Prepare and review a new packet before filling.");
  }
  return { bytes, filename: filename(kind), mimeType: "application/pdf" };
}
