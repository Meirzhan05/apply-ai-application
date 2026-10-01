import type { Application } from "@/lib/types";

const importedOutcomeLabel: Record<NonNullable<Application["importedOutcome"]>["kind"], string> = {
  reachable: "Posting checked",
  attempted: "Submission attempted",
  blocked: "Application blocked",
  confirmed: "Submission confirmed",
  uncertain: "Outcome uncertain",
};

function evidenceLabel(app: Application): string {
  return app.importedOutcome?.synthetic || app.controlledTest ? "Controlled test evidence" : "Employer evidence";
}

export function autonomousOutcome(app: Application): string {
  if (app.queuedRun) return "Queued";
  if (app.importedOutcome?.kind === "blocked") return "Blocked";
  if (app.importedOutcome?.kind === "uncertain") return "Uncertain";
  if (app.importedOutcome?.kind === "confirmed") return "Submitted";
  return ({ needs_user_action: "Blocked", submitted: "Submitted", uncertain: "Uncertain", cancelled: "Cancelled", awaiting_verification: "Verification pending" } as Partial<Record<Application["status"], string>>)[app.status] ?? "Processing";
}

export function importedPreflightRecheckAvailable(app: Application): boolean {
  return !app.autonomousAuthorization && app.importedOutcome?.kind === "blocked" && Boolean(app.importedCompatibility) &&
    !app.importedPreflight && !app.browserSessionId && !app.browserReleasePending &&
    !app.submissionStartedAt && !app.submissionAttemptedAt && !app.submittedAt && !app.submissionReceipt &&
    !["submitted", "uncertain", "submitting", "awaiting_verification", "cancelled"].includes(app.status);
}

export function importedPreflightHandoff(app: Application): string {
  return importedPreflightRecheckAvailable(app)
    ? "The checked employer link is saved and the browser session is closed. Review the link, then check it again when ready."
    : "This saved employer check is waiting for its current hold or review state to be resolved.";
}

export function AutonomousApplicationStatus({ application: app, busy, checkResult }: { application: Application; busy: boolean; checkResult: () => void }) {
  const outcome = autonomousOutcome(app);
  const postAttempt = Boolean(app.submissionAttemptedAt || app.submissionReceipt || ["attempted", "confirmed", "uncertain"].includes(app.importedOutcome?.kind ?? ""));
  const confirmedCopy = app.importedOutcome?.synthetic ? "The controlled form confirmation was observed and saved." : "The employer’s confirmation was observed and saved.";
  return <section className="step-card" aria-label="Automatic application outcome" aria-live="polite">
    <h3>{outcome === "Processing" ? "Your application is running" : `Application ${outcome.toLowerCase()}`}</h3>
    <p>{outcome === "Processing" ? "Preparing truthful materials, filling known answers, and checking the employer’s response using your enabled settings." : outcome === "Blocked" ? app.importedOutcome ? "The employer posting check needs attention. Review the reason below, then check the employer link again when ready." : "The application paused before it could continue. Review the reason below, then resume this saved application when it is ready." : outcome === "Cancelled" ? "Your saved request was cancelled. The agent will not continue this application." : outcome === "Queued" ? "Your request is saved. It will continue when a worker and service budget are available." : outcome === "Verification pending" ? "The existing submission needs employer verification. Continue in the saved browser; checking its result never submits again." : outcome === "Submitted" ? confirmedCopy : postAttempt ? "The submission attempt is preserved for observation. Check the saved employer receipt; no additional Submit action will be made." : "Confirmation could not be established. Review the posting and saved form before continuing this application."}</p>
    {app.autonomousAuthorization && <p className="muted">Authorized settings version {app.autonomousAuthorization.profileVersion}</p>}
    {app.importedCompatibility && <div className="muted">
      <p>Imported posting: {app.importedCompatibility.status === "reachable" ? "checked" : app.importedCompatibility.status === "blocked" ? "needs review" : "uncertain"}; supported form check saved before automatic work.</p>
      {app.importedOutcome && <p>{importedOutcomeLabel[app.importedOutcome.kind]} · {evidenceLabel(app)}{app.importedOutcome.evidence ? ` · ${app.importedOutcome.evidence}` : ""}</p>}
    </div>}
    {app.blockers?.filter((blocker) => blocker.progress === "blocked" || blocker.progress === "resuming").length ? <ul>{app.blockers.filter((blocker) => blocker.progress === "blocked" || blocker.progress === "resuming").map((blocker) => <li key={blocker.id}>{blocker.message}</li>)}</ul> : app.form?.blockers?.length ? <ul>{app.form.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
    {(app.submissionMaterials?.files ?? app.packet?.files)?.length ? <details><summary>{app.submissionMaterials ? "View materials used for this attempt" : "View prepared materials"}</summary>
      <p>{(app.submissionMaterials?.resumeMode ?? app.packet?.resumeMode) === "original" ? "Original uploaded résumé" : "Tailored résumé"}{app.submissionMaterials ? ` · Cover letters: ${app.submissionMaterials.coverLetterMode ?? "saved preference"}` : ""}</p>
      <ul>{(app.submissionMaterials?.files ?? app.packet!.files!).map((file) => <li key={`${file.kind}:${file.sha256}`}><a href={`/api/applications/${app.id}/files/${file.kind}?download=1`}>{file.filename}</a><span className="muted"> · {file.mimeType === "application/pdf" ? "PDF" : "DOCX"} · {file.size.toLocaleString()} bytes</span><p className="muted">SHA-256: <code style={{ overflowWrap: "anywhere" }}>{file.sha256}</code></p></li>)}</ul>
      {app.submissionMaterials && !app.submissionMaterials.files.some((file) => file.kind === "cover-letter") ? <p>No cover letter was attached to this attempt.</p> : null}
    </details> : null}
    {app.form ? <details><summary>View saved form</summary><div className="form-fields">{app.form.fields.map((field, index) => <div key={index}><span>{field.label}</span><strong>{field.value || "No value entered"}</strong></div>)}</div></details> : null}
    {app.submissionReceipt && <details><summary>View employer response</summary><p>{app.submissionReceipt.text}</p></details>}
    {app.status === "uncertain" && app.browserSessionId && app.submissionVerification && <button className="outline-action" disabled={busy} onClick={checkResult}>Check existing submission result</button>}
  </section>;
}
