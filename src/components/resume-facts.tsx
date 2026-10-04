"use client";

import { useState } from "react";
import { FileText, Pencil, X } from "lucide-react";
import { ResumeSourceSupportNotice } from "@/components/resume-comparison";
import { isUsableFact } from "@/lib/fact-evidence";
import type { Profile, ResumeFactCategory, VerifiedFact } from "@/lib/types";

const groups: Array<{ category: ResumeFactCategory; label: string }> = [
  { category: "experience", label: "Experience" }, { category: "project", label: "Projects" },
  { category: "education", label: "Education" }, { category: "skill", label: "Skills" },
  { category: "certification", label: "Certifications" }, { category: "publication", label: "Publications and research" },
  { category: "other", label: "Additional facts" },
];
const messages = { queued: "Reading your resume…", extracting: "Extracting your details and experience…", checking: "Checking facts against your resume…", ready: "Your resume details and facts are ready.", failed: "Resume extraction couldn't finish.", budget_limited: "Resume extraction is paused." };

export function ResumeFacts({ profile, busy, onUploaded, onSave }: {
  profile: Profile; busy: boolean; onUploaded: () => Promise<unknown>;
  onSave: (facts: VerifiedFact[], expectedFacts: VerifiedFact[]) => Promise<unknown>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ fact: VerifiedFact; text: string } | null>(null);
  const [newFact, setNewFact] = useState("");
  const extraction = profile.resumeExtraction;
  const pending = Boolean(extraction && ["queued", "extracting", "checking"].includes(extraction.status));
  const disabled = busy || uploading;
  const save = async (facts: VerifiedFact[], expected = profile.facts) => {
    const result = await onSave(facts, expected);
    if (result) { setEditing(null); setNewFact(""); }
  };
  const retry = async () => {
    setUploading(true); setError("");
    try {
      const response = await fetch("/api/resume", { method: "PATCH" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      await onUploaded();
    } catch (err) { setError(err instanceof Error ? err.message : "Retry failed. Try again."); }
    finally { setUploading(false); }
  };
  return <section className="profile-card resume-facts-panel" aria-labelledby="confirmed-resume-facts">
    <h3 id="confirmed-resume-facts" tabIndex={-1}>Resume and experience</h3>
    <p className="muted">Upload your resume. The agent extracts facts and checks them against the source automatically. You can edit them anytime.</p>
    <label className="upload-box">
      <FileText size={24} aria-hidden="true" />
      <span>{uploading ? "Reading your resume…" : extraction?.filename || profile.resumeFileName || "Upload PDF or DOCX · 5 MB max"}</span>
      <input type="file" accept=".pdf,.docx" disabled={disabled} aria-label="Upload resume"
        onChange={async event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setUploading(true); setError("");
          try {
            const form = new FormData(); form.set("file", file);
            const response = await fetch("/api/resume", { method: "POST", body: form });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);
            await onUploaded();
          } catch (err) { setError(err instanceof Error ? err.message : "Upload failed. Try another PDF or DOCX."); }
          finally { setUploading(false); }
        }} />
    </label>
    {extraction && <div className="resume-extraction-status" role="status" aria-live="polite">
      <p>{messages[extraction.status]}</p>
      {pending && profile.resumeFileName && <p className="muted">Your previous resume remains active until this one is ready.</p>}
      {extraction.error && <p className="muted">{extraction.error}</p>}
      {["failed", "budget_limited"].includes(extraction.status) && <button type="button" className="outline-action" disabled={disabled} onClick={retry}>Retry extraction</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {profile.resumeSourceDocument && <ResumeSourceSupportNotice source={profile.resumeSourceDocument} />}
    {profile.resumeText && <details className="resume-text"><summary>View extracted resume text</summary><pre>{profile.resumeText}</pre></details>}
    {!profile.facts.length && !pending && <p className="muted">Your experience will appear here after extraction. You can also add a fact below.</p>}
    {groups.map(group => {
      const facts = profile.facts.filter(fact => (fact.category ?? "other") === group.category);
      if (!facts.length) return null;
      return <div className="resume-fact-group" key={group.category}>
        <h4>{group.label}</h4>
        <ul className="resume-fact-list">{facts.map(fact => <li key={fact.id}>
          <div className="resume-fact-content">
            {editing?.fact.id === fact.id ? <>
              <label htmlFor="resume-fact-edit">Edit fact</label>
              <textarea id="resume-fact-edit" maxLength={500} value={editing.text} disabled={disabled} onChange={event => setEditing({ ...editing, text: event.target.value })} />
              <div className="action-row">
                <button className="outline-action" disabled={disabled || !editing.text.trim()} onClick={() => {
                  const edited = { ...editing.fact, text: editing.text.trim(), verified: true };
                  void save(profile.facts.map(item => item.id === fact.id ? edited : item), profile.facts.map(item => item.id === fact.id ? editing.fact : item));
                }}>Save change</button>
                <button className="text-button" disabled={disabled} onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </> : <p>{fact.text}</p>}
            {!isUsableFact(fact) && <small className="muted">Waiting for automatic extraction.</small>}
            {fact.grounding && <details className="resume-fact-source"><summary>View source</summary>{fact.grounding.evidence.map(item => <blockquote key={item.anchorId}>{item.quote}</blockquote>)}</details>}
          </div>
          <div className="resume-fact-actions">
            <button type="button" className="icon-button" disabled={disabled} aria-label={`Edit ${fact.text}`} onClick={() => setEditing({ fact: structuredClone(fact), text: fact.text })}><Pencil size={16} /></button>
            <button type="button" className="icon-button" disabled={disabled} aria-label={`Remove ${fact.text}`} onClick={() => save(profile.facts.filter(item => item.id !== fact.id))}><X size={16} /></button>
          </div>
        </li>)}</ul>
      </div>;
    })}
    <label htmlFor="additional-resume-fact">Add an experience or project fact</label>
    <div className="add-fact">
      <input id="additional-resume-fact" maxLength={500} value={newFact} disabled={disabled} onChange={event => setNewFact(event.target.value)} placeholder="For example, built a Python API for a class project" />
      <button type="button" disabled={disabled || !newFact.trim() || profile.facts.length >= 80} onClick={() => save([...profile.facts, { id: crypto.randomUUID(), text: newFact.trim(), source: "user", verified: true }])}>Add fact</button>
    </div>
  </section>;
}
