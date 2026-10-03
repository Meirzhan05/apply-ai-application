"use client";

import { useState } from "react";
import { WorkspaceDialog } from "@/app/workspace-dialog";
import type { VerifiedFact } from "@/lib/types";

export function FactCorrectionDialog({ claim, facts, busy, error, onCancel, onSave }: {
  claim: string; facts: VerifiedFact[]; busy: boolean; error: string;
  onCancel: () => void; onSave: (facts: VerifiedFact[]) => Promise<unknown>;
}) {
  const [drafts, setDrafts] = useState(() => structuredClone(facts));
  return <WorkspaceDialog labelledBy="correction-heading" onClose={() => { if (!busy) onCancel(); }}>
    <h2 id="correction-heading">Correct the source facts</h2>
    <p className="correction-claim">{claim}</p>
    <p>These facts belong to your reusable profile. Correct the wording, then confirm only what is accurate. Saving updates your profile and returns you to this application to rebuild its materials.</p>
    <div className="correction-facts">
      {drafts.map((fact, index) => <div className="fact-row" key={fact.id}>
        <textarea className="fact-correction-input" aria-label={`Correct source fact ${fact.id}`} maxLength={500} disabled={busy} value={fact.text}
          onChange={event => setDrafts(current => current.map((item, i) => i === index ? { ...item, text: event.target.value, verified: false, source: "user", sourceAnchorId: undefined } : item))} />
        <label className="checkline"><input type="checkbox" checked={fact.verified} disabled={busy} onChange={event => setDrafts(current => current.map((item, i) => i === index ? { ...item, verified: event.target.checked } : item))} />I confirm this fact is accurate</label>
      </div>)}
    </div>
    {drafts.length === 0 && <p role="alert">The source facts are no longer in your profile. Cancel and rebuild the materials from your current profile.</p>}
    <div className="action-row">
      <button className="dark-button" disabled={busy || !drafts.length || drafts.some(fact => !fact.text.trim())} onClick={() => onSave(drafts)}>{busy ? "Saving facts…" : "Save facts and return to application"}</button>
      <button className="text-button" disabled={busy} onClick={onCancel}>Cancel corrections</button>
    </div>
    {error && <p role="alert">{error} Your corrections are preserved. Try saving again or cancel to keep your saved facts.</p>}
  </WorkspaceDialog>;
}
