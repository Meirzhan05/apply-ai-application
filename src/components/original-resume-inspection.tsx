import type { ApplicationPacket } from "@/lib/types";

interface OriginalResumeInspectionProps {
  applicationId: string;
  packet: ApplicationPacket;
}

export function OriginalResumeInspection({ applicationId, packet }: OriginalResumeInspectionProps) {
  const original = packet.originalResume;
  if (!original) {
    return <p className="muted">The original résumé details are unavailable.</p>;
  }

  const typeLabel = original.mimeType === "application/pdf" ? "PDF" : "DOCX";
  return (
    <div className="original-resume-inspection">
      <p className="muted">This application uses your uploaded original résumé.</p>
      <div className="resume-preview">
        <strong>Original résumé used</strong>
        <small>{original.filename} · {typeLabel} file</small>
      </div>
      <a
        className="text-button"
        href={`/api/applications/${applicationId}/files/resume?download=1`}
      >
        Download original résumé ({typeLabel}) ↓
      </a>
    </div>
  );
}
