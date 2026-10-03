"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { UsageView } from "@/lib/usage-view";
import styles from "./usage.module.css";

const money = (value: number | null) => value === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);
const tokens = (value: number | null) => value === null ? "Unknown" : value.toLocaleString();
const label = (value: string) => value.replaceAll("-", " ").replaceAll("_", " ");
export default function UsagePage() {
  const [data, setData] = useState<UsageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/usage${window.location.search}`, { cache: "no-store" });
      const report = await response.json();
      if (!response.ok) throw new Error(report.error || "Usage could not be loaded. Try again.");
      setData(report);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Usage could not be loaded. Try again."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const initial = setTimeout(() => { void refresh(); }, 0); return () => clearTimeout(initial); }, [refresh]);
  return <main className={styles.sheet}>
    <nav className={styles.navigation} aria-label="Usage navigation"><Link href="/"><ArrowLeft size={16} /> Workspace</Link><div><Link href="/costs">Service costs</Link><button onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} />{loading ? "Loading…" : "Refresh usage"}</button></div></nav>
    <header className={styles.heading}><h1>AI usage</h1><p>Provider reports for your applications and background matching, including work that failed or was cancelled.</p></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {loading && !data && <p role="status">Loading your usage records…</p>}
    {data && <>
      <dl className={styles.summary}>
        <div><dt>Reported calls</dt><dd>{data.measuredCalls}</dd></div>
        <div><dt>Unmeasured calls</dt><dd>{data.unknownCalls}</dd></div>
        <div><dt>Known model estimate</dt><dd>{money(data.estimatedUsd)}</dd></div>
        <div><dt>Calls with unknown cost</dt><dd>{data.incompleteCostCalls}</dd></div>
      </dl>
      <p className={styles.explanation}>The model estimate is a subtotal calculated from reported tokens and recorded rates. Browser sessions are reported separately below. Reconciled account charges: <strong>not available</strong>.</p>
      <section aria-labelledby="browser-heading" className={styles.browserSection}><h2 id="browser-heading">Browser sessions</h2>
        <dl className={styles.summary}>
          <div><dt>Measured sessions</dt><dd>{data.browser.measuredSessions}</dd></div>
          <div><dt>Active sessions</dt><dd>{data.browser.activeSessions}</dd></div>
          <div><dt>Browser estimate</dt><dd>{money(data.browser.estimatedUsd)}</dd></div>
          <div><dt>Traffic unknown</dt><dd>{data.browser.unknownTrafficSessions}</dd></div>
        </dl>
        {!data.browser.sessions.length ? <div className={styles.empty}><h3>No browser usage recorded yet</h3><p>Sessions appear when an approved application opens a remote browser. A disconnected client does not end the provider session.</p></div> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Browser session usage; scroll horizontally for all columns"><table className={styles.table}>
          <caption className={styles.srOnly}>Remote browser sessions and provider usage</caption><thead><tr><th scope="col">Provider / session</th><th scope="col">Duration</th><th scope="col">Traffic</th><th scope="col">Cost</th><th scope="col">State</th></tr></thead>
          <tbody>{data.browser.sessions.map((session) => <tr key={`${session.provider}:${session.sessionId}`}>
            <td><strong>{label(session.provider)}</strong><span className={styles.identifier}>{session.sessionId}</span><span>{session.applicationId ? "Application " + session.applicationId : "Unlinked session"}</span></td>
            <td className={styles.numeric}>{session.durationMinutes === null ? "Unknown" : `${session.durationMinutes} min`}</td>
            <td className={styles.numeric}>{session.proxyUsedMb === null ? "Unknown" : `${session.proxyUsedMb} MB`}{session.proxyCostUsd !== null && <span>{money(session.proxyCostUsd)} reported</span>}</td>
            <td className={styles.numeric}>{session.browserCostUsd !== null ? `${money(session.browserCostUsd)} reported` : session.estimatedBrowserCostUsd !== null ? `${money(session.estimatedBrowserCostUsd)} estimated` : "Unknown"}{session.rate && <details><summary>Rate snapshot</summary><p>{session.rate.unit} · {session.rate.browserUsdPerMinute.toFixed(6)}</p><p>{session.rate.version} · checked {session.rate.checkedAt}</p><a href={session.rate.source} target="_blank" rel="noreferrer">Provider pricing</a></details>}</td>
            <td><strong>{session.status === "active" ? "Active / provisional" : label(session.lastEvent)}</strong><span>{session.orphaned ? "Release needs reconciliation" : session.provisional ? "Final provider report pending" : "Provider report received"}</span></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
      <section aria-labelledby="records-heading"><h2 id="records-heading">Model calls</h2>
        {!data.records.length ? <div className={styles.empty}><h3>No model usage recorded yet</h3><p>Records appear when Apply performs AI work. Work from before usage recording began has no measured token report.</p></div> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Model usage measurements; scroll horizontally for all columns"><p className={styles.scrollHint}>Scroll to see all measurements.</p><table className={styles.table}>
          <caption className={styles.srOnly}>Your model usage, with provider reports and calculated estimates</caption>
          <thead><tr><th scope="col">Operation</th><th scope="col">Application or background job</th><th scope="col">Input / cached / cache writes</th><th scope="col">Output</th><th scope="col">Model estimate</th><th scope="col">Report</th></tr></thead>
          <tbody>{data.records.map((record) => <tr key={record.id}>
            <td><strong>{label(record.operation)}</strong><span>{record.model} · {record.provider}</span><time dateTime={record.startedAt}>{new Date(record.startedAt).toLocaleString()}</time></td>
            <td><strong>{record.applicationTitle ?? (record.applicationId ? "Application" : "Background work")}</strong><span className={styles.identifier}>{record.applicationId ?? record.backgroundJobId ?? record.jobId}</span>{record.applicationStatus && <span>{label(record.applicationStatus)}</span>}<details><summary>Run identity</summary><p className={styles.identifier}>{record.runId}</p><p className={styles.identifier}>{record.responseId ?? "No provider response identity"}</p></details></td>
            <td className={styles.numeric}>{tokens(record.tokens.input)} / {tokens(record.tokens.cachedInput)} / {tokens(record.tokens.cacheWrite)}</td>
            <td className={styles.numeric}>{tokens(record.tokens.output)}<span>Reasoning: {tokens(record.tokens.reasoningOutput)} (included)</span></td>
            <td className={styles.numeric}>{money(record.estimatedUsd)}{record.rate && <details><summary>Recorded rate</summary><p>{record.rate.context} context · {record.rate.unit}</p><p>Input {record.rate.input}; cached {record.rate.cachedInput}; cache writes {record.rate.cacheWrite}; output {record.rate.output}.</p><a href={record.rate.source} target="_blank" rel="noreferrer">OpenAI pricing</a><p>Checked {record.rate.checkedAt} · {record.rate.version}</p></details>}</td>
            <td><strong>{record.status === "started" ? "Unfinished / unknown" : record.status === "failed" ? "Failed / unmeasured" : "Provider reported"}</strong><span>{record.providerStatus ? label(record.providerStatus) : "Provider outcome unknown"}</span>{record.failure && <span>{record.failure === "aborted" ? "Request interrupted" : "Provider request failed"}</span>}</td>
          </tr>)}</tbody></table></div>}
      </section>
      <section className={styles.reservations} aria-labelledby="reservations-heading"><h2 id="reservations-heading">Projected scheduling reservations</h2><p>{data.projectedReservations.length} saved application runs · {money(data.projectedReservations.reduce((sum, run) => sum + run.projectedUsd, 0))} projected.</p><p>These amounts reserve service capacity before a run. They are separate from measured tokens, model estimates and provider invoices.</p></section>
    </>}
  </main>;
}
