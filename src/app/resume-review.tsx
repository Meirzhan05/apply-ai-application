import type { Profile, ResumeDocument, ResumeField } from "@/lib/types";

export function ResumeReview({ profile, document, applicationId, pdfHash, onCorrectClaim }: { profile: Profile; document: ResumeDocument; applicationId: string; pdfHash: string; onCorrectClaim?: (factIds: string[], claim: string) => void }) {
  const base = `/api/applications/${applicationId}/files`;
  const claim = (field: ResumeField) => field.text ? <div className="resume-claim">
    <span>{field.text}</span>
    <details className="resume-sources"><summary aria-label={`Source facts for: ${field.text}`}>Source facts</summary>
      {field.factIds.map((id) => <p key={id}>{profile.facts.find((fact) => fact.id === id)?.text ?? "Source unavailable; rebuild the resume."}</p>)}
      {onCorrectClaim && <button type="button" className="text-button" onClick={() => onCorrectClaim(field.factIds, field.text)}>Correct or unconfirm these facts</button>}
    </details>
  </div> : null;
  return <div className="structured-resume-review">
    <p className="muted">Review the rewritten claims and the one-page PDF. Approving the packet authorizes this exact resume for form filling.</p>
    <div className="resume-downloads">
      <a className="text-button" href={`${base}/resume?download=1`} target="_blank" rel="noreferrer">Download resume PDF ↗</a>
      <details><summary>Advanced download</summary><a className="text-button" href={`${base}/resume-source`}>Download LaTeX source</a></details>
    </div>
    <iframe className="resume-pdf-preview" src={`${base}/resume?v=${pdfHash}#view=FitH`} title="Compiled one-page resume PDF" />
    <div className="resume-preview">
      <strong>{profile.name}</strong>
      <small>{[profile.email, profile.phone].filter(Boolean).join(" · ")}</small>
      {document.links.map((link) => <div key={link.text}>{claim(link)}</div>)}
      {([ ["Education", document.education], ["Experience", document.experience], ["Projects", document.projects] ] as const).map(([title, entries]) => entries.length > 0 && <section key={title}>
        <h4>{title}</h4>
        {entries.map((entry) => <article className="resume-entry" key={entry.heading.text}>
          <div className="resume-entry-heading"><div className="resume-entry-title">{claim(entry.heading)}</div>{claim(entry.dates)}</div>
          {claim(entry.subheading)}{claim(entry.location)}
          {entry.bullets.length > 0 && <ul>{entry.bullets.map((bullet, i) => <li key={i}>{claim(bullet)}</li>)}</ul>}
        </article>)}
      </section>)}
      {document.skills.length > 0 && <section><h4>Skills</h4>{document.skills.map((skill) => <div key={skill.text}>{claim(skill)}</div>)}</section>}
    </div>
    {document.omitted.length > 0 && <details className="resume-omissions"><summary>Omitted content ({document.omitted.length})</summary>
      <p className="muted">Your profile still retains these facts. They were left out for job relevance or to keep the resume readable on one page.</p>
      <ul>{document.omitted.map((field, index) => <li key={index}>{claim(field)}<small>{field.reason === "page-length" ? "One-page limit" : "Job relevance"}</small></li>)}</ul>
    </details>}
  </div>;
}
