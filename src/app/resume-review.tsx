"use client";

import { useId, useState } from "react";
import type { Profile, ResumeDocument, ResumeField } from "@/lib/types";

export function ResumeReview({ profile, document, applicationId, pdfHash, onCorrectClaim }: { profile: Profile; document: ResumeDocument; applicationId: string; pdfHash: string; onCorrectClaim?: (factIds: string[], claim: string) => void }) {
  const base = `/api/applications/${applicationId}/files`;
  const [view, setView] = useState<"claims" | "layout">("claims");
  const id = useId();
  const claim = (field: ResumeField) => field.text ? <div className="resume-claim">
    <span>{field.text}</span>
    <details className="resume-sources"><summary aria-label={`Source facts for: ${field.text}`}>Source facts</summary>
      {field.factIds.map((id) => <p key={id}>{profile.facts.find((fact) => fact.id === id)?.text ?? "Source unavailable; rebuild the resume."}</p>)}
      {onCorrectClaim && <button type="button" className="text-button" onClick={() => onCorrectClaim(field.factIds, field.text)}>Correct or unconfirm these facts</button>}
    </details>
  </div> : null;
  const sources = (fields: ResumeField[], title: string) => {
    const used = fields.filter(field => field.text);
    const factIds = [...new Set(used.flatMap(field => field.factIds))];
    return <details className="resume-sources"><summary aria-label={`Source facts for: ${title}`}>Check source facts</summary>
      {factIds.map(factId => <p key={factId}>{profile.facts.find(fact => fact.id === factId)?.text ?? "Source unavailable; rebuild the resume."}</p>)}
      {onCorrectClaim && <button type="button" className="text-button" onClick={() => onCorrectClaim(factIds, title)}>Correct or unconfirm these facts</button>}
      <details className="individual-claims"><summary>Inspect individual claims</summary>{used.map((field, i) => <div key={i}>{claim(field)}</div>)}</details>
    </details>;
  };
  return <div className="structured-resume-review">
    <p className="muted">Check the claims and their sources, then use PDF layout to inspect the document the employer receives.</p>
    <div className="resume-view-controls" role="group" aria-label="Resume review view">
      <button type="button" aria-pressed={view === "claims"} aria-controls={`${id}-claims`} onClick={() => setView("claims")}>Claims and sources</button>
      <button type="button" aria-pressed={view === "layout"} aria-controls={`${id}-layout`} onClick={() => setView("layout")}>PDF layout</button>
    </div>
    <div className="resume-downloads">
      <a className="text-button" href={`${base}/resume?download=1`} target="_blank" rel="noreferrer">Download resume PDF ↗</a>
      <details><summary>Advanced download</summary><a className="text-button" href={`${base}/resume-source`}>Download LaTeX source</a></details>
    </div>
    <div id={`${id}-layout`} hidden={view !== "layout"}>
      {view === "layout" && <iframe className="resume-pdf-preview" src={`${base}/resume?v=${pdfHash}#view=FitH`} title="Compiled one-page resume PDF" />}
      <p className="muted">If your browser cannot display the preview, <a href={`${base}/resume?v=${pdfHash}`} target="_blank" rel="noreferrer">open the resume PDF in a new tab</a> or download it above. Claims and sources remain available for text review.</p>
    </div>
    <div id={`${id}-claims`} hidden={view !== "claims"}>
    <div className="resume-preview">
      <strong>{profile.name}</strong>
      <small>{[profile.email, profile.phone].filter(Boolean).join(" · ")}</small>
      {document.links.map((link) => <div key={link.text}>{link.text}</div>)}
      {document.links.length > 0 && sources(document.links, "Contact links")}
      {([ ["Education", document.education], ["Experience", document.experience], ["Projects", document.projects] ] as const).map(([title, entries]) => entries.length > 0 && <section key={title}>
        <h4>{title}</h4>
        {entries.map((entry) => <article className="resume-entry" key={entry.heading.text}>
          <div className="resume-entry-heading"><div className="resume-entry-title">{entry.heading.text}</div><span>{entry.dates.text}</span></div>
          {entry.subheading.text && <div>{entry.subheading.text}</div>}{entry.location.text && <div>{entry.location.text}</div>}
          {entry.bullets.length > 0 && <ul>{entry.bullets.map((bullet, i) => <li key={i}>{bullet.text}</li>)}</ul>}
          {sources([entry.heading, entry.dates, entry.subheading, entry.location, ...entry.bullets], entry.heading.text)}
        </article>)}
      </section>)}
      {document.skills.length > 0 && <section><h4>Skills</h4>{document.skills.map((skill) => <div key={skill.text}>{skill.text}</div>)}{sources(document.skills, "Skills")}</section>}
    </div>
    {document.omitted.length > 0 && <details className="resume-omissions"><summary>Omitted content ({document.omitted.length})</summary>
      <p className="muted">Your profile still retains these facts. They were left out for job relevance or to keep the resume readable on one page.</p>
      <ul>{document.omitted.map((field, index) => <li key={index}>{claim(field)}<small>{field.reason === "page-length" ? "One-page limit" : "Job relevance"}</small></li>)}</ul>
    </details>}
    </div>
  </div>;
}
