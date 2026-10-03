"use client";

import { useState } from "react";
import type { ScreeningAnswer, VerifiedFact } from "@/lib/types";

export function EssayReview({ answer, facts, inputId, editable, blocked, onSave, onEditingChange }: {
  answer: ScreeningAnswer; facts: VerifiedFact[]; inputId: string;
  editable: boolean; blocked: boolean; onSave: (text: string) => Promise<unknown | null>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer.answer);
  const revision = answer.userRevision;
  const sourceIds = revision?.originalFactIds ?? answer.factIds;
  return <div className="essay-review">
    <textarea id={inputId} readOnly={!editing} disabled={blocked} value={editing ? text : answer.answer}
      maxLength={4000} rows={5} onChange={(event) => setText(event.target.value)} />
    <p className="essay-attribution">{revision ? "Edited by you · " : "AI essay · "}{answer.confirmedAt ? "confirmed by you" : "your confirmation needed"}</p>
    {editing ? <>
      <p className="muted">Use truthful wording. Your changes apply only to this answer and need fresh confirmation.</p>
      <div className="essay-actions">
        <button type="button" className="outline-action" disabled={blocked || !text.trim() || text.trim() === answer.answer}
          onClick={async () => { if (await onSave(text)) { setEditing(false); onEditingChange?.(false); } }}>Save essay revision</button>
        <button type="button" className="text-button" disabled={blocked} onClick={() => { setText(answer.answer); setEditing(false); onEditingChange?.(false); }}>Cancel editing</button>
      </div>
    </> : editable && <button type="button" className="text-button" disabled={blocked} onClick={() => { setText(answer.answer); setEditing(true); onEditingChange?.(true); }}>Edit wording</button>}
    <details className="essay-evidence">
      <summary aria-label={`${revision ? "Original draft and source facts" : "Source facts"} for: ${answer.question}`}>{revision ? "Original AI draft and source facts" : "Facts used in this essay"}</summary>
      {revision && <><p>{revision.originalAnswer}</p><p className="muted">These facts supported the original draft. Your revision is applicant-provided wording, not a newly verified claim.</p></>}
      {sourceIds.length ? <ul>{sourceIds.map((id) => <li key={id}>{facts.find((fact) => fact.id === id)?.text ?? "Source fact unavailable"}</li>)}</ul> : <p>No experience claims were used in this draft.</p>}
    </details>
  </div>;
}
