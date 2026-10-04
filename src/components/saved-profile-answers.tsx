"use client";
import { useState } from "react";
import type { Profile } from "@/lib/types";

export function SavedProfileAnswers({ profile, disabled, onSave }: { profile: Profile; disabled: boolean; onSave: (key: string, expectedValue: string, value: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState<{ key: string; original: string; value: string } | null>(null);
  return <details className="saved-profile-answers">
    <summary>Saved personal answers{profile.savedAnswers?.length ? ` (${profile.savedAnswers.length})` : ""}</summary>
    <p className="muted">When you supply a missing personal detail during an application, it is saved here for future forms. Employer-specific and screening answers stay with that application.</p>
    {!profile.savedAnswers?.length && <p className="muted">No additional answers saved yet.</p>}
    {profile.savedAnswers?.map(answer => <div className="saved-profile-answer" key={answer.key}>
      {editing?.key === answer.key ? <>
        <label>{answer.question}<input value={editing.value} maxLength={500} onChange={event => setEditing({ ...editing, value: event.target.value })} /></label>
        <div className="fact-actions"><button type="button" className="outline-action" disabled={disabled || !editing.value.trim()} onClick={async () => { const result = await onSave(answer.key, editing.original, editing.value); if (result) setEditing(null); }}>Save answer</button><button type="button" className="text-button" onClick={() => setEditing(null)}>Cancel</button></div>
      </> : <>
        <strong>{answer.question}</strong><p>{answer.value}</p>
        <div className="fact-actions"><button type="button" className="text-button" disabled={disabled} onClick={() => setEditing({ key: answer.key, original: answer.value, value: answer.value })}>Edit</button><button type="button" className="text-button" disabled={disabled} onClick={() => onSave(answer.key, answer.value, "")}>Forget</button></div>
      </>}
    </div>)}
  </details>;
}
