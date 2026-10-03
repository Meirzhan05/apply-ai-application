"use client";

import { useState } from "react";

export function isAccountDeletionConfirmed(value: string): boolean {
  return value === "DELETE";
}

export function AccountDeletionPanel({ demo }: { demo: boolean }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (demo || busy || !isAccountDeletionConfirmed(confirmation)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/account/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error(result.error || "Account removal could not be completed. Retry to continue safely.");
      window.location.assign(new URL("/login", window.location.origin).href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account removal could not be completed. Retry to continue safely.");
      setBusy(false);
    }
  }

  return <section className="profile-card account-deletion" aria-labelledby="account-deletion-heading">
    <h3 id="account-deletion-heading">Delete your account</h3>
    <p className="muted">This permanently removes your profile, uploaded resumes, generated documents and screenshots, saved application history, and account usage records. Applications already sent to employers remain with those employers.</p>
    {demo ? <p className="muted" role="status">Account deletion is unavailable in demo mode.</p> : <>
      <label>
        Type DELETE to confirm
        <input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy} />
      </label>
      <button className="subtle-danger" type="button" onClick={() => void submit()} disabled={busy || !isAccountDeletionConfirmed(confirmation)}>
        {busy ? "Removing account…" : "Permanently delete my account"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </>}
  </section>;
}
