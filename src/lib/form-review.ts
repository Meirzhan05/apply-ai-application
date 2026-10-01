import type { Application, FormFieldSnapshot } from "@/lib/types";

export function formFieldValue(field: FormFieldSnapshot): string {
  if (["radio", "checkbox"].includes(field.kind)) {
    const option = field.value && field.value !== "on" ? `${field.value} · ` : "";
    return `${option}${field.checked ? "Selected" : "Not selected"}`;
  }
  return field.value || (field.kind === "file" ? "No file" : "Blank");
}

export function canReopenManualAttempt(app: Application): boolean {
  return app.status === "uncertain" && Boolean(app.packet && app.packetHash) &&
    app.manualSubmissionReport?.source === "owner" && !app.manualSubmissionReport.resolution &&
    !app.submissionStartedAt && !app.submissionAttemptedAt && !app.submissionWorkerClaimedAt &&
    !app.submittedAt && !app.submissionReceipt && !app.queuedRun &&
    !app.approvals.some((approval) => approval.kind === "submit");
}

// Present a recorded employer block without changing submission state or
// granting retry permission. An older receipt must not describe a new attempt.
export function employerSubmissionBlock(app: Application): string | undefined {
  const receipt = app.submissionReceipt;
  if (app.status !== "uncertain" || !receipt || !app.submissionAttemptedAt) return undefined;
  const captured = Date.parse(receipt.capturedAt);
  const attempted = Date.parse(app.submissionAttemptedAt);
  if (!Number.isFinite(captured) || !Number.isFinite(attempted) || captured < attempted) return undefined;
  const text = receipt.text.replace(/[’‘]/g, "'");
  if (/^(?:application (?:received|submitted)|thank you for applying|your application has been sent)\b/im.test(text)) return undefined;
  if (/^We couldn't submit your application\s*$/im.test(text) &&
    /^Your application submission was flagged as possible spam\./im.test(text))
    return "The employer reports that your application submission was flagged as possible spam.";
  return undefined;
}
