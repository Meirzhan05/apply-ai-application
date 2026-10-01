"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download, RefreshCw, ShieldCheck } from "lucide-react";
import styles from "./pilot.module.css";
import { PILOT_CONSENT_TEXT, PILOT_CONSENT_VERSION } from "@/lib/pilot-constants";

type PilotView = {
  pilot?: { activeEpisodeId?: string; episodes?: Array<{ consentedAt: string; withdrawnAt?: string }> };
  automation?: { enabled: boolean; paused: boolean };
};
type PilotReport = {
  status: string;
  reasons: string[];
  cutoffAt: string;
  totals: { realInitiated: number; confirmed: number; unattendedConfirmed: number; interventions: number; controlled: number; unknown: number; unknownCosts: number };
  cohorts: Record<string, { initiated: number; confirmed: number }>;
  attempts: Array<{
    id: string; ownerId: string; applicationId: string; origin: string; cohort: string; initiatedAt: string;
    postingSnapshot: { title: string; company: string; canonicalUrl: string };
    events: Array<{ kind: string; detail?: string; outcome?: string; blockerReason?: string }>;
    reviews: Array<{ suitability: string; factualAccuracy: string; notes: string }>;
    currentEvidenceDigest?: string;
    controlledExclusion?: { afterCutoff: boolean };
    costEvidence: { status: string; estimatedUsd?: number; measuredUsd?: number; reconciledUsd?: number };
  }>;
};

const reasonLabel: Record<string, string> = {
  "fewer-than-20-real-initiated": "At least 20 real initiated applications are still needed.",
  "cohorts-missing": "Both internship and new-grad roles need real initiated evidence.",
  "unattended-rate-below-80-percent": "Unattended confirmed completion is below the 80% target.",
  "confirmed-attempt-review-incomplete": "Confirmed attempts still need suitability and factual-accuracy review.",
  "confirmed-attempt-review-failed": "A confirmed attempt failed suitability or factual-accuracy review.",
};

export default function PilotPage() {
  const [state, setState] = useState<PilotView | null>(null);
  const [report, setReport] = useState<PilotReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [operator, setOperator] = useState(false);
  const [reviewDraft, setReviewDraft] = useState<Record<string, { suitability: string; factualAccuracy: string; notes: string }>>({});

  const load = useCallback(async () => {
    setError("");
    const [stateResponse, reportResponse] = await Promise.all([fetch("/api/state", { cache: "no-store" }), fetch("/api/pilot", { cache: "no-store" })]);
    const stateBody = await stateResponse.json();
    if (!stateResponse.ok) throw new Error(stateBody.error || "Your workspace could not be loaded.");
    setState(stateBody);
    setOperator(reportResponse.headers.get("X-Pilot-Viewer") === "operator");
    if (reportResponse.ok) setReport(await reportResponse.json());
    else if (reportResponse.status === 404) setReport(null);
    else { const body = await reportResponse.json().catch(() => ({})); throw new Error(body.error || "The pilot report could not be loaded."); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Your workspace could not be loaded.")); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const refresh = () => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Your workspace could not be loaded.")); };

  const act = async (action: "enrollPilot" | "withdrawPilot") => {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload: action === "enrollPilot" ? { confirmed: true, consentVersion: PILOT_CONSENT_VERSION } : {} }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Pilot participation could not be updated.");
      setMessage(action === "enrollPilot" ? "You are enrolled for future pilot initiations." : "You have withdrawn from future pilot initiations. Existing evidence remains available.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Pilot participation could not be updated."); }
    finally { setBusy(false); }
  };

  const submitReview = async (attempt: PilotReport["attempts"][number]) => {
    const draft = reviewDraft[attempt.id];
    if (!draft || !attempt.currentEvidenceDigest) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/pilot/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerId: attempt.ownerId, applicationId: attempt.applicationId, evidenceDigest: attempt.currentEvidenceDigest, suitability: draft.suitability, factualAccuracy: draft.factualAccuracy, notes: draft.notes }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Review could not be saved.");
      const capture = await fetch("/api/pilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const captureBody = await capture.json().catch(() => ({}));
      if (!capture.ok) throw new Error(captureBody.error || "Review saved, but the updated report could not be captured.");
      setMessage("Review saved and a new report was captured.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Review could not be saved."); }
    finally { setBusy(false); }
  };

  const captureReport = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/pilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "The pilot report could not be captured.");
      setMessage("A new pilot report was captured from the current persisted state.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The pilot report could not be captured."); }
    finally { setBusy(false); }
  };

  const enrolled = Boolean(state?.pilot?.activeEpisodeId);
  const automationText = state?.automation?.enabled ? "Automation is enabled separately." : state?.automation?.paused ? "Automation is paused separately." : "Automation is not enabled.";
  return <main className={styles.page}>
    <nav className={styles.nav}><Link href="/"><ArrowLeft size={16} /> Workspace</Link><button className={styles.refresh} onClick={refresh}><RefreshCw size={15} /> Refresh</button></nav>
    <header className={styles.header}><div><h1>Autonomy pilot</h1><p>Measure real application work with clear evidence for interruptions, outcomes, suitability, accuracy, and cost.</p></div><ShieldCheck size={36} strokeWidth={1.5} /></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {message && <p role="status" className={styles.message}>{message}</p>}
    <section className={styles.enrollment} aria-labelledby="enrollment-heading"><div><h2 id="enrollment-heading">{enrolled ? "You are enrolled" : "Join the invited pilot"}</h2><p>{enrolled ? "New applications you start from this point may be included in the pilot. This does not enable automation or change your saved preferences." : "Participation starts after onboarding and applies only to applications initiated after you consent."}</p><p className={styles.secondary}>{automationText}</p></div>{enrolled ? <button className={styles.secondaryButton} disabled={busy} onClick={() => void act("withdrawPilot")}>Withdraw from future initiations</button> : <button className={styles.primaryButton} disabled={busy || !state} onClick={() => void act("enrollPilot")}>{busy ? "Saving…" : "Join pilot"}</button>}</section>
    {!enrolled && <section className={styles.consent} aria-labelledby="consent-heading"><h2 id="consent-heading">What you are agreeing to</h2><p>{PILOT_CONSENT_TEXT}</p><small>Consent version {PILOT_CONSENT_VERSION}</small></section>}
    <section className={styles.report} aria-labelledby="report-heading"><div className={styles.reportHeading}><div><h2 id="report-heading">Pilot report</h2><p>{report ? `Captured through ${new Date(report.cutoffAt).toLocaleString()}.` : "No report has been captured yet."}</p></div><div className={styles.reportActions}>{operator && <button className={styles.secondaryButton} disabled={busy} onClick={() => void captureReport()}>{busy ? "Capturing…" : "Capture current report"}</button>}{report && <a className={styles.download} href="/api/pilot?format=csv"><Download size={15} /> Download CSV</a>}</div></div>{report ? <><div className={styles.metrics}><div><strong>{report.totals.realInitiated}</strong><span>real initiated</span></div><div><strong>{report.totals.confirmed}</strong><span>confirmed receipts</span></div><div><strong>{report.totals.unattendedConfirmed}</strong><span>unattended confirmed</span></div><div><strong>{report.totals.interventions}</strong><span>interventions</span></div><div><strong>{report.totals.controlled}</strong><span>controlled</span></div><div><strong>{report.totals.unknown}</strong><span>unknown origin</span></div><div><strong>{report.totals.unknownCosts}</strong><span>costs incomplete</span></div></div><p className={report.status === "passed" ? styles.pass : styles.gate}>{report.status === "passed" ? "Pilot gate passed." : report.status.replaceAll("-", " ")}</p>{report.reasons.length > 0 && <ul className={styles.reasons}>{report.reasons.map((reason) => <li key={reason}>{reasonLabel[reason] || reason}</li>)}</ul>}<div className={styles.cohorts}><div><span>Internship</span><strong>{report.cohorts.internship?.initiated ?? 0}</strong><small>initiated · {report.cohorts.internship?.confirmed ?? 0} confirmed</small></div><div><span>New-grad</span><strong>{report.cohorts["new-grad"]?.initiated ?? 0}</strong><small>initiated · {report.cohorts["new-grad"]?.confirmed ?? 0} confirmed</small></div><div><span>Unclassified</span><strong>{report.cohorts.unclassified?.initiated ?? 0}</strong><small>visible, not a qualifying cohort</small></div></div><div className={styles.attempts}><h3>{operator ? "Operator review queue" : "Your pilot attempts"}</h3>{report.attempts.map((attempt) => { const latest = attempt.events.at(-1); const review = attempt.reviews.at(-1); const draft = reviewDraft[attempt.id] ?? { suitability: review?.suitability ?? "insufficient", factualAccuracy: review?.factualAccuracy ?? "insufficient", notes: review?.notes ?? "" }; return <article className={styles.attempt} key={attempt.id}><div className={styles.attemptHeading}><div><strong>{attempt.postingSnapshot.title}</strong><span>{attempt.postingSnapshot.company} · {attempt.cohort} · {attempt.origin}{attempt.controlledExclusion?.afterCutoff ? " · excluded by later controlled marker" : ""}</span></div><a className={styles.download} href={`/api/pilot/evidence/${encodeURIComponent(attempt.ownerId)}/${encodeURIComponent(attempt.applicationId)}/application`} target="_blank" rel="noreferrer">Inspect submitted evidence</a></div><p>{latest?.kind ?? "initiated"}: {latest?.detail ?? "No later lifecycle event recorded."}</p><small>Cost: {attempt.costEvidence.status}{attempt.costEvidence.estimatedUsd !== undefined ? ` · estimate $${attempt.costEvidence.estimatedUsd.toFixed(2)}` : ""}{attempt.costEvidence.measuredUsd !== undefined ? ` · measured $${attempt.costEvidence.measuredUsd.toFixed(2)}` : ""}{attempt.costEvidence.reconciledUsd !== undefined ? ` · reconciled $${attempt.costEvidence.reconciledUsd.toFixed(2)}` : ""}</small>{operator && <div className={styles.reviewForm}><label>Suitability<select value={draft.suitability} onChange={(event) => setReviewDraft({ ...reviewDraft, [attempt.id]: { ...draft, suitability: event.target.value } })}><option value="pass">Pass</option><option value="fail">Fail</option><option value="insufficient">Insufficient</option></select></label><label>Factual accuracy<select value={draft.factualAccuracy} onChange={(event) => setReviewDraft({ ...reviewDraft, [attempt.id]: { ...draft, factualAccuracy: event.target.value } })}><option value="pass">Pass</option><option value="fail">Fail</option><option value="insufficient">Insufficient</option><option value="not-applicable">Not applicable</option></select></label><label>Notes<textarea value={draft.notes} maxLength={1000} onChange={(event) => setReviewDraft({ ...reviewDraft, [attempt.id]: { ...draft, notes: event.target.value } })} /></label><button className={styles.secondaryButton} disabled={busy || !attempt.currentEvidenceDigest} onClick={() => void submitReview(attempt)}>Save review</button></div>}</article>; })}</div></> : <p className={styles.empty}>{operator ? "No stored global report yet. Capture the current persisted state to create one." : "Reports are captured by the configured pilot operator. Controlled validation stays separate from real employer evidence."}</p>}</section>
  </main>;
}
