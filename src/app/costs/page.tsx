"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { CostReport, ServiceCostCategory, AllocationMethod } from "@/lib/service-costs";
import styles from "../usage/usage.module.css";
import costStyles from "./costs.module.css";
import { MandatoryOnboardingGate } from "@/components/mandatory-onboarding-gate";

const money = (value: number | null) => value === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);
const label = (value: string) => value.replaceAll("-", " ").replaceAll("_", " ");
type CostPageReport = CostReport & { operator: boolean };
export default function CostsPage() {
  const [report, setReport] = useState<CostPageReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [importMessage, setImportMessage] = useState("");
  const [period, setPeriod] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("period") || "");
  const [serviceScope, setServiceScope] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("scope") === "service");
  const requestSequence = useRef(0);
  const refresh = useCallback(async (search = window.location.search) => {
    const requestId = ++requestSequence.current;
    setLoading(true); setError("");
    setReport(null);
    try {
      const response = await fetch(`/api/costs${search}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Costs could not be loaded. Try again.");
      if (requestId !== requestSequence.current) return;
      setReport(data);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setReport(null);
      setError(cause instanceof Error ? cause.message : "Costs could not be loaded. Try again.");
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);
  const setFilter = (changes: { period?: string; service?: boolean }) => {
    const params = new URLSearchParams(window.location.search);
    const nextPeriod = changes.period ?? period;
    const nextServiceScope = changes.service ?? serviceScope;
    if (nextPeriod) params.set("period", nextPeriod); else params.delete("period");
    if (nextServiceScope) params.set("scope", "service"); else params.delete("scope");
    const search = params.toString() ? `?${params}` : "";
    setPeriod(nextPeriod);
    setServiceScope(nextServiceScope);
    window.history.replaceState({}, "", `${window.location.pathname}${search}`);
    void refresh(search);
  };
  const importLine = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setImportMessage("");
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const allocationMethod = String(form.get("allocationMethod")) as AllocationMethod;
    const amountUsd = Number(form.get("amountUsd"));
    const userId = String(form.get("userId") || "").trim();
    const record = { version: 1 as const, id: crypto.randomUUID(), provider: String(form.get("provider")), invoiceId: String(form.get("invoiceId")), lineId: String(form.get("lineId")), period: String(form.get("period")), category: String(form.get("category")) as ServiceCostCategory, amountUsd, currency: "USD" as const, allocationMethod, allocations: allocationMethod === "none" ? [] : [{ userId, amountUsd }], reconciles: [], importedAt: new Date().toISOString() };
    try { const response = await fetch("/api/costs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Invoice line could not be imported."); setImportMessage("Invoice line imported."); formElement.reset(); void refresh(); }
    catch (cause) { setImportMessage(cause instanceof Error ? cause.message : "Invoice line could not be imported."); }
  };
  useEffect(() => {
    const initialSearch = window.location.search;
    const initial = setTimeout(() => { void refresh(initialSearch); }, 0);
    return () => clearTimeout(initial);
  }, [refresh]);
  const csvParams = new URLSearchParams();
  if (period) csvParams.set("period", period);
  if (serviceScope) csvParams.set("scope", "service");
  csvParams.set("format", "csv");
  const csvHref = `/api/costs?${csvParams}`;
  return <MandatoryOnboardingGate><main className={styles.sheet}>
    <nav className={styles.navigation} aria-label="Cost navigation"><Link href="/"><ArrowLeft size={16} /> Workspace</Link><div className={costStyles.actions}><Link href="/usage">Usage detail</Link>{report && <a href={csvHref}>Download CSV</a>}<button onClick={() => void refresh(window.location.search)} disabled={loading}><RefreshCw size={16} />{loading ? "Loading…" : "Refresh costs"}</button></div></nav>
    <header className={styles.heading}><h1>Service costs</h1><p>Projected reservations, measured estimates, reconciled charges and unknown evidence stay visible as separate operational signals.</p></header>
    <div className={costStyles.filters} aria-label="Cost filters"><label>Period <input type="month" value={period} onChange={(event) => setFilter({ period: event.target.value })} /></label>{report?.operator && <label className={costStyles.checkboxLabel}><input type="checkbox" checked={serviceScope} onChange={(event) => setFilter({ service: event.target.checked })} /> Service totals</label>}</div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {loading && !report && <p role="status">Loading cost evidence…</p>}
    {report && <>
      <dl className={styles.summary}>
        <div><dt>Projected reservations</dt><dd>{money(report.projectedUsd)}</dd></div>
        <div><dt>Measured estimates</dt><dd>{money(report.measuredEstimateUsd)}</dd></div>
        <div><dt>Reconciled charges</dt><dd>{money(report.reconciledUsd)}</dd></div>
        <div><dt>Unreconciled estimates</dt><dd>{money(report.unreconciledEstimateUsd)}</dd></div>
        <div><dt>Known combined total</dt><dd>{money(report.knownTotalUsd)}</dd></div>
        <div><dt>Unknown components</dt><dd>{report.unknownComponents}</dd></div>
        <div><dt>Confirmed submissions</dt><dd>{report.confirmedSubmissions}</dd></div>
        <div><dt>Cost per confirmed submission</dt><dd>{money(report.costPerConfirmedSubmission)}</dd></div>
        <div><dt>Active users</dt><dd>{report.activeUsers}</dd></div>
        <div><dt>Cost per active user</dt><dd>{money(report.costPerActiveUser)}</dd></div>
      </dl>
      <p className={styles.explanation}>{report.heldRequests} request{report.heldRequests === 1 ? " is" : "s are"} paused for the service spend ceiling. The request remains saved for later dispatch; initiated applications are not removed.</p>
      <p className={styles.explanation}>Active users include accounts with an initiated application or attempted model or browser work in this period, including cancelled and failed attempts. Cost per active user divides the known combined total by that count.</p>
      {report.unknownComponents > 0 && <p className={styles.explanation}>Unknown evidence remains unresolved ({report.unknownComponents} component{report.unknownComponents === 1 ? "" : "s"}); it is excluded from the known combined total rather than treated as zero.</p>}
      {report.operator && <section className={styles.reservations} aria-labelledby="import-heading"><h2 id="import-heading">Import an invoice line</h2><p>Record provider, invoice, line, period, category and amount. Choose Service total or Direct owner, and provide an owner ID for direct-owner allocation.</p><form onSubmit={importLine}><div className={costStyles.invoiceForm}><label>Provider <input name="provider" required /></label><label>Invoice <input name="invoiceId" required /></label><label>Line <input name="lineId" required /></label><label>Period <input name="period" type="month" required defaultValue={report.period || ""} /></label><label>Category <select name="category" defaultValue="hosting"><option value="model">Model</option><option value="browser">Browser</option><option value="hosting">Hosting</option><option value="runtime">Runtime</option><option value="database">Database</option><option value="storage">Storage</option><option value="email">Email</option></select></label><label>Amount USD <input name="amountUsd" type="number" min="0" step="0.01" required /></label><label>Allocation <select name="allocationMethod" defaultValue="none"><option value="none">Service total</option><option value="direct-owner">Direct owner</option></select></label><label>Owner ID (for owner allocation) <input name="userId" /></label><button type="submit">Import line</button></div></form>{importMessage && <p role="status">{importMessage}</p>}</section>}
      <section aria-labelledby="invoice-heading"><h2 id="invoice-heading">Reconciled invoice lines</h2>
        {!report.invoiceLines.length ? <div className={styles.empty}><h3>No operator invoice lines yet</h3><p>Imported provider charges appear here once their period, category and allocation method are recorded.</p></div> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Reconciled invoice lines"><table className={styles.table}><caption className={styles.srOnly}>Operator-entered or imported provider invoice lines</caption><thead><tr><th scope="col">Provider / invoice</th><th scope="col">Period</th><th scope="col">Category</th><th scope="col">Charge</th><th scope="col">Allocation</th><th scope="col">Evidence replaced</th></tr></thead><tbody>{report.invoiceLines.map((line) => <tr key={line.id}><td><strong>{line.provider}</strong><span className={styles.identifier}>{line.invoiceId} · {line.lineId}</span></td><td>{line.period}</td><td>{label(line.category)}</td><td className={styles.numeric}>{money(line.allocatedUsd ?? line.amountUsd)}</td><td>{label(line.allocationMethod)}<span>{line.allocationMethod === "none" ? "Service total" : "Owner allocation stated"}</span></td><td className={styles.numeric}>{line.reconciles.length ? line.reconciles.length : "None"}</td></tr>)}</tbody></table></div>}
      </section>
      <section className={styles.reservations} aria-labelledby="evidence-heading"><h2 id="evidence-heading">Usage evidence</h2><p>{report.evidence.length} model and browser record{report.evidence.length === 1 ? "" : "s"}. Failed, cancelled and background work remain in the ledger.</p>{report.evidence.length > 0 && <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Cost evidence"><table className={styles.table}><thead><tr><th scope="col">Kind / identity</th><th scope="col">Owner</th><th scope="col">Amount</th><th scope="col">State</th></tr></thead><tbody>{report.evidence.map((item) => <tr key={item.id}><td><strong>{label(item.category)}</strong><span className={styles.identifier}>{item.id}</span><span>{item.applicationId ? "Application work" : item.backgroundJobId ? "Background work" : "Unlinked work"}</span></td><td className={styles.identifier}>{report.scope === "service" ? item.ownerId : "Signed-in owner"}</td><td className={styles.numeric}>{money(item.amountUsd)}{item.unknown && <span>Measurement unknown</span>}</td><td>{label(item.status)}{item.reconciledUsd !== null && <span>Reconciled</span>}</td></tr>)}</tbody></table></div>}</section>
    </>}
  </main></MandatoryOnboardingGate>;
}
