import type { Application } from "@/lib/types";

export function autonomousOutcome(app: Application): string {
  if (app.queuedRun) return "Queued";
  return ({ needs_user_action: "Blocked", submitted: "Submitted", uncertain: "Uncertain", cancelled: "Cancelled", awaiting_verification: "Verification pending" } as Partial<Record<Application["status"], string>>)[app.status] ?? "Processing";
}

export function AutonomousApplicationStatus({ application: app, busy, checkResult }: { application: Application; busy: boolean; checkResult: () => void }) {
  const outcome = autonomousOutcome(app);
  return <section className="step-card" aria-label="Automatic application outcome" aria-live="polite">
    <h3>{outcome === "Processing" ? "Your application is running" : `Application ${outcome.toLowerCase()}`}</h3>
    <p>{outcome === "Processing" ? "Preparing truthful materials, filling known answers, and checking the employer’s response using your enabled settings." : outcome === "Blocked" ? "The application stopped before it could continue. Review the reason below; no new submission will be attempted." : outcome === "Cancelled" ? "Your saved request was cancelled. The agent will not continue this application." : outcome === "Queued" ? "Your request is saved. It will continue when a worker and service budget are available." : outcome === "Verification pending" ? "The existing submission needs employer verification. Continue in the saved browser; checking its result never submits again." : outcome === "Submitted" ? "The employer’s confirmation was observed and saved." : "Confirmation could not be established. Check the employer receipt; the agent will not submit again."}</p>
    <p className="muted">Authorized settings version {app.autonomousAuthorization?.profileVersion}</p>
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
