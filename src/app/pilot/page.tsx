"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download, RefreshCw, ShieldCheck } from "lucide-react";
import styles from "./pilot.module.css";
import { PILOT_CONSENT_TEXT, PILOT_CONSENT_VERSION } from "@/lib/pilot";

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
};

const reasonLabel: Record<string, string> = {
  "fewer-than-20-real-initiated": "At least 20 real initiated applications are still needed.",
  "cohorts-missing": "Both internship and new-grad roles need real initiated evidence.",
  "unattended-rate-below-80-percent": "Unattended confirmed completion is below the 80% target.",
  "confirmed-attempt-review-incomplete": "Confirmed attempts still need suitability and factual-accuracy review.",
};

export default function PilotPage() {
  const [state, setState] = useState<PilotView | null>(null);
  const [report, setReport] = useState<PilotReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [stateResponse, reportResponse] = await Promise.all([fetch("/api/state", { cache: "no-store" }), fetch("/api/pilot", { cache: "no-store" })]);
    const stateBody = await stateResponse.json();
    if (!stateResponse.ok) throw new Error(stateBody.error || "Your workspace could not be loaded.");
    setState(stateBody);
    if (reportResponse.ok) setReport(await reportResponse.json());
    else setReport(null);
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Your workspace could not be loaded.")); }, 0); return () => window.clearTimeout(timer); }, [load]);

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

  const enrolled = Boolean(state?.pilot?.activeEpisodeId);
  const automationText = state?.automation?.enabled ? "Automation is enabled separately." : state?.automation?.paused ? "Automation is paused separately." : "Automation is not enabled.";
  return <main className={styles.page}>
    <nav className={styles.nav}><Link href="/"><ArrowLeft size={16} /> Workspace</Link><button className={styles.refresh} onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></nav>
    <header className={styles.header}><div><h1>Autonomy pilot</h1><p>Measure real application work with clear evidence for interruptions, outcomes, suitability, accuracy, and cost.</p></div><ShieldCheck size={36} strokeWidth={1.5} /></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {message && <p role="status" className={styles.message}>{message}</p>}
    <section className={styles.enrollment} aria-labelledby="enrollment-heading"><div><h2 id="enrollment-heading">{enrolled ? "You are enrolled" : "Join the invited pilot"}</h2><p>{enrolled ? "New applications you start from this point may be included in the pilot. This does not enable automation or change your saved preferences." : "Participation starts after onboarding and applies only to applications initiated after you consent."}</p><p className={styles.secondary}>{automationText}</p></div>{enrolled ? <button className={styles.secondaryButton} disabled={busy} onClick={() => void act("withdrawPilot")}>Withdraw from future initiations</button> : <button className={styles.primaryButton} disabled={busy || !state} onClick={() => void act("enrollPilot")}>{busy ? "Saving…" : "Join pilot"}</button>}</section>
    {!enrolled && <section className={styles.consent} aria-labelledby="consent-heading"><h2 id="consent-heading">What you are agreeing to</h2><p>{PILOT_CONSENT_TEXT}</p><small>Consent version {PILOT_CONSENT_VERSION}</small></section>}
    <section className={styles.report} aria-labelledby="report-heading"><div className={styles.reportHeading}><div><h2 id="report-heading">Pilot report</h2><p>{report ? `Captured through ${new Date(report.cutoffAt).toLocaleString()}.` : "No report has been captured yet."}</p></div>{report && <a className={styles.download} href="/api/pilot?format=csv"><Download size={15} /> Download CSV</a>}</div>{report ? <><div className={styles.metrics}><div><strong>{report.totals.realInitiated}</strong><span>real initiated</span></div><div><strong>{report.totals.confirmed}</strong><span>confirmed receipts</span></div><div><strong>{report.totals.unattendedConfirmed}</strong><span>unattended confirmed</span></div><div><strong>{report.totals.interventions}</strong><span>interventions</span></div><div><strong>{report.totals.unknownCosts}</strong><span>costs incomplete</span></div></div><p className={report.status === "passed" ? styles.pass : styles.gate}>{report.status === "passed" ? "Pilot gate passed." : report.status.replaceAll("-", " ")}</p>{report.reasons.length > 0 && <ul className={styles.reasons}>{report.reasons.map((reason) => <li key={reason}>{reasonLabel[reason] || reason}</li>)}</ul>}<div className={styles.cohorts}><div><span>Internship</span><strong>{report.cohorts.internship?.initiated ?? 0}</strong><small>initiated · {report.cohorts.internship?.confirmed ?? 0} confirmed</small></div><div><span>New-grad</span><strong>{report.cohorts["new-grad"]?.initiated ?? 0}</strong><small>initiated · {report.cohorts["new-grad"]?.confirmed ?? 0} confirmed</small></div><div><span>Unclassified</span><strong>{report.cohorts.unclassified?.initiated ?? 0}</strong><small>visible, not a qualifying cohort</small></div></div></> : <p className={styles.empty}>Reports are captured by the configured pilot operator. Controlled validation stays separate from real employer evidence.</p>}</section>
  </main>;
}
