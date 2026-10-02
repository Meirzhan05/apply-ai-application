import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo, loadState } from "@/lib/repository";
import { readAllModelUsage, readModelUsage, type ModelUsageRecord } from "@/lib/model-usage";
import { readAllBrowserUsage, readBrowserUsage, type BrowserUsageRecord } from "@/lib/browser-usage";

export const SERVICE_COST_CATEGORIES = ["model", "browser", "hosting", "runtime", "database", "storage", "email"] as const;
export type ServiceCostCategory = typeof SERVICE_COST_CATEGORIES[number];
export const ALLOCATION_METHODS = ["none", "direct-owner", "equal-active-users", "confirmed-submissions"] as const;
export type AllocationMethod = typeof ALLOCATION_METHODS[number];

export interface ServiceCostAllocation { userId: string; amountUsd: number; }
export interface ServiceCostRecord {
  version: 1;
  id: string;
  provider: string;
  invoiceId: string;
  lineId: string;
  period: string;
  category: ServiceCostCategory;
  amountUsd: number;
  currency: "USD";
  description?: string;
  allocationMethod: AllocationMethod;
  allocations: ServiceCostAllocation[];
  reconciles: string[];
  importedAt: string;
}

export interface CostEvidence {
  id: string;
  ownerId: string;
  provider: string;
  period: string | null;
  category: "model" | "browser";
  component: "model" | "browser" | "proxy";
  amountUsd: number | null;
  measurement?: "measured" | "estimated";
  rateVersion?: string;
  reconciledUsd: number | null;
  unknown: boolean;
  status: string;
  applicationId?: string;
  backgroundJobId?: string;
  runId: string;
}
export interface CostReport {
  scope: "owner" | "service";
  ownerId?: string;
  period?: string;
  projectedUsd: number;
  measuredEstimateUsd: number;
  unreconciledEstimateUsd: number;
  reconciledUsd: number;
  knownTotalUsd: number;
  unknownComponents: number;
  confirmedSubmissions: number;
  costPerConfirmedSubmission: number | null;
  activeUsers: number;
  costPerActiveUser: number | null;
  heldRequests: number;
  invoiceLines: Array<Pick<ServiceCostRecord, "id" | "provider" | "invoiceId" | "lineId" | "period" | "category" | "amountUsd" | "currency" | "allocationMethod" | "reconciles"> & { allocatedUsd: number | null }>;
  evidence: CostEvidence[];
}

const localPath = () => isDemo() || process.env.NODE_ENV === "test"
  ? path.join(process.env.SERVICE_COSTS_TEST_DIR || path.join(process.cwd(), ".data"), "service-costs.json")
  : undefined;
let writes: Promise<unknown> = Promise.resolve();
async function readLocal(file: string): Promise<ServiceCostRecord[]> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function cleanString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
function validMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.round(value * 100) !== value * 100) throw new Error(`${label} must be a non-negative USD amount with at most two decimals.`);
  return value;
}
function validate(record: ServiceCostRecord): ServiceCostRecord {
  if (record.version !== 1 || record.currency !== "USD") throw new Error("Unsupported service cost record version or currency.");
  const provider = cleanString(record.provider, "Provider");
  const invoiceId = cleanString(record.invoiceId, "Invoice identity");
  const lineId = cleanString(record.lineId, "Invoice line identity");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(record.period)) throw new Error("Period must use YYYY-MM.");
  if (!SERVICE_COST_CATEGORIES.includes(record.category)) throw new Error("Unknown service cost category.");
  const amountUsd = validMoney(record.amountUsd, "Amount");
  if (!ALLOCATION_METHODS.includes(record.allocationMethod)) throw new Error("Unknown allocation method.");
  if (!Array.isArray(record.allocations)) throw new Error("Allocations must be an array.");
  if (record.allocationMethod === "none" && record.allocations.length) throw new Error("An unallocated line cannot include owner allocations.");
  const allocations = record.allocations.map((allocation) => ({ userId: cleanString(allocation.userId, "Allocation owner"), amountUsd: validMoney(allocation.amountUsd, "Allocation amount") }));
  if (new Set(allocations.map((allocation) => allocation.userId)).size !== allocations.length) throw new Error("Each owner may appear once per invoice line.");
  if (record.allocationMethod !== "none" && Math.abs(allocations.reduce((sum, allocation) => sum + allocation.amountUsd, 0) - amountUsd) > 0.000001) throw new Error("Owner allocations must equal the invoice line amount.");
  if (record.allocationMethod === "direct-owner" && allocations.length === 0) throw new Error("Direct-owner lines need an owner allocation.");
  if (!Array.isArray(record.reconciles) || record.reconciles.some((value) => typeof value !== "string" || !value.trim())) throw new Error("Reconciliation evidence identities must be strings.");
  if (new Set(record.reconciles).size !== record.reconciles.length) throw new Error("Reconciliation evidence identities must be unique.");
  if (record.category !== "model" && record.category !== "browser" && record.reconciles.length) throw new Error("Fixed service costs cannot reconcile usage evidence.");
  return { ...record, id: cleanString(record.id, "Record identity"), provider, invoiceId, lineId, period: record.period, amountUsd, allocations, reconciles: [...record.reconciles] };
}

async function coverageIndex(): Promise<Map<string, Pick<CostEvidence, "ownerId" | "provider" | "period" | "category">>> {
  const index = new Map<string, Pick<CostEvidence, "ownerId" | "provider" | "period" | "category">>();
  for (const record of uniqueModelRecords(await readAllModelUsage())) index.set(record.id, { ownerId: record.userId, provider: record.provider, period: record.startedAt.slice(0, 7), category: "model" });
  for (const group of canonicalBrowserGroups(await readAllBrowserUsage())) {
    for (const record of group.records) {
      const base = { ownerId: record.userId, provider: record.provider, period: group.period, category: "browser" as const };
      if (record.sessionId) { index.set(`browser:${record.provider}:${record.sessionId}:browser`, base); index.set(`browser:${record.provider}:${record.sessionId}:proxy`, base); }
      else { index.set(`browser:event:${record.id}`, base); index.set(`browser:event:${record.id}:proxy`, base); }
    }
  }
  return index;
}
async function validateCoverage(record: ServiceCostRecord): Promise<void> {
  if (!record.reconciles.length) return;
  const index = await coverageIndex();
  for (const identity of record.reconciles) {
    const evidence = index.get(identity);
    if (!evidence) throw new Error(`Reconciliation evidence ${identity} was not found.`);
    if (evidence.category !== record.category || evidence.provider !== record.provider || evidence.period !== record.period) throw new Error(`Reconciliation evidence ${identity} does not match provider, category and period.`);
    if (!record.allocations.some((allocation) => allocation.userId === evidence.ownerId)) throw new Error(`Reconciliation evidence ${identity} is outside the allocated owner set.`);
  }
}

export async function recordServiceCost(input: ServiceCostRecord): Promise<ServiceCostRecord> {
  const record = validate(input);
  const file = localPath();
  if (file) {
    const write = writes.then(async () => {
      const records = await readLocal(file);
      const previous = records.find((item) => item.id === record.id || (item.provider === record.provider && item.invoiceId === record.invoiceId && item.lineId === record.lineId));
      if (previous) {
        if (previous.id !== record.id) throw new Error("Provider invoice line identity already belongs to another record.");
        return previous;
      }
      await validateCoverage(record);
      if (records.some((item) => item.reconciles.some((identity) => record.reconciles.includes(identity)))) throw new Error("An evidence identity is already reconciled.");
      const next = [...records, record];
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
      return record;
    });
    writes = write.catch(() => undefined);
    return await write;
  }
  const existing = await adminSupabase().from("service_cost_records").select("data").eq("id", record.id).maybeSingle();
  if (existing.error) throw new Error("Service cost could not be loaded.");
  if (existing.data?.data) return existing.data.data as ServiceCostRecord;
  await validateCoverage(record);
  const { data, error } = await adminSupabase().rpc("record_service_cost", { p_record: record });
  if (error) throw new Error("Service cost could not be persisted.");
  return (data ?? record) as ServiceCostRecord;
}

export async function readServiceCosts(period?: string): Promise<ServiceCostRecord[]> {
  if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("Period must use YYYY-MM.");
  const file = localPath();
  if (file) { await writes; return (await readLocal(file)).filter((record) => !period || record.period === period); }
  const records: ServiceCostRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    let query = adminSupabase().from("service_cost_records").select("data").order("period", { ascending: false }).range(offset, offset + 499);
    if (period) query = query.eq("period", period);
    const { data, error } = await query;
    if (error) throw new Error("Service costs could not be loaded.");
    records.push(...(data ?? []).map((row) => row.data as ServiceCostRecord));
    if (!data || data.length < 500) break;
  }
  return records;
}

function modelEvidence(record: ModelUsageRecord): CostEvidence {
  return { id: record.id, ownerId: record.userId, provider: record.provider, period: record.startedAt.slice(0, 7), category: "model", component: "model", amountUsd: record.estimatedUsd, measurement: record.estimatedUsd === null ? undefined : "estimated", rateVersion: record.rate?.version, reconciledUsd: null, unknown: record.estimatedUsd === null, status: record.status, applicationId: record.applicationId, backgroundJobId: record.backgroundJobId, runId: record.runId };
}
function browserEvidence(record: BrowserUsageRecord, amountUsd: number | null, unknown = amountUsd === null, period = record.occurredAt.slice(0, 7), measurement?: "measured" | "estimated"): CostEvidence {
  return { id: `browser:${record.provider}:${record.sessionId}:browser`, ownerId: record.userId, provider: record.provider, period, category: "browser", component: "browser", amountUsd, measurement, rateVersion: record.report?.rate?.version, reconciledUsd: null, unknown, status: record.event, applicationId: record.applicationId, backgroundJobId: record.jobId, runId: record.runId };
}
function proxyEvidence(record: BrowserUsageRecord, amountUsd: number | null, period = record.occurredAt.slice(0, 7)): CostEvidence {
  return { id: `browser:${record.provider}:${record.sessionId}:proxy`, ownerId: record.userId, provider: record.provider, period, category: "browser", component: "proxy", amountUsd, measurement: amountUsd === null ? undefined : "measured", rateVersion: record.report?.rate?.version, reconciledUsd: null, unknown: amountUsd === null, status: record.event, applicationId: record.applicationId, backgroundJobId: record.jobId, runId: record.runId };
}
function nullSessionEvidence(record: BrowserUsageRecord, period = record.occurredAt.slice(0, 7)): CostEvidence {
  const amount = record.report?.browserCostUsd ?? null;
  return { id: `browser:event:${record.id}`, ownerId: record.userId, provider: record.provider, period, category: "browser", component: "browser", amountUsd: amount, measurement: amount === null ? undefined : "measured", rateVersion: record.report?.rate?.version, reconciledUsd: null, unknown: amount === null, status: record.event, applicationId: record.applicationId, backgroundJobId: record.jobId, runId: record.runId };
}
function nullSessionProxyEvidence(record: BrowserUsageRecord, period = record.occurredAt.slice(0, 7)): CostEvidence {
  const amount = record.report?.proxyCostUsd ?? null;
  return { id: `browser:event:${record.id}:proxy`, ownerId: record.userId, provider: record.provider, period, category: "browser", component: "proxy", amountUsd: amount, measurement: amount === null ? undefined : "measured", rateVersion: record.report?.rate?.version, reconciledUsd: null, unknown: amount === null, status: record.event, applicationId: record.applicationId, backgroundJobId: record.jobId, runId: record.runId };
}
function periodMatches(value: string | undefined, period: string | undefined): boolean { return !period || Boolean(value && value.slice(0, 7) === period); }
function modelMeasurementScore(record: ModelUsageRecord): number {
  return Object.values(record.tokens).filter((value) => value !== null).length
    + (record.rate ? 1 : 0) + (record.estimatedUsd !== null ? 1 : 0)
    + (record.responseId ? 1 : 0) + (record.providerStatus ? 1 : 0);
}
function modelMeasurementTime(record: ModelUsageRecord): string { return record.completedAt ?? record.startedAt; }
function uniqueModelRecords(records: ModelUsageRecord[]): ModelUsageRecord[] {
  const groups = new Map<string, ModelUsageRecord[]>();
  for (const record of records) {
    const key = record.responseId ? `${record.provider}:${record.responseId}` : record.id;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].map((group) => {
    const [canonical] = [...group].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    const strongest = group.reduce((best, record) => {
      const score = modelMeasurementScore(record), bestScore = modelMeasurementScore(best);
      return score > bestScore || (score === bestScore && (record.startedAt > best.startedAt || (record.startedAt === best.startedAt && (modelMeasurementTime(record) > modelMeasurementTime(best) || (modelMeasurementTime(record) === modelMeasurementTime(best) && record.id > best.id))))) ? record : best;
    });
    return { ...canonical, ...strongest, id: canonical.id, startedAt: canonical.startedAt, userId: canonical.userId, runId: canonical.runId, responseId: canonical.responseId ?? strongest.responseId };
  });
}
function addUniqueEvidence(target: Map<string, CostEvidence>, evidence: CostEvidence): void {
  const existing = target.get(evidence.id);
  if (!existing || (existing.amountUsd === null && evidence.amountUsd !== null)) target.set(evidence.id, evidence);
}
function browserSessionKey(record: BrowserUsageRecord): string { return record.sessionId ? `${record.provider}:${record.sessionId}` : `event:${record.id}`; }
function browserCanonicalPeriod(records: BrowserUsageRecord[]): string {
  const providerStarts = records.map((record) => record.report?.startedAt).filter((value): value is string => Boolean(value));
  return (providerStarts.sort()[0] ?? records.map((record) => record.occurredAt).sort()[0]).slice(0, 7);
}
function canonicalBrowserGroups(records: BrowserUsageRecord[]): Array<{ records: BrowserUsageRecord[]; period: string }> {
  const groups = new Map<string, BrowserUsageRecord[]>();
  for (const record of records) groups.set(browserSessionKey(record), [...(groups.get(browserSessionKey(record)) ?? []), record]);
  return [...groups.values()].map((group) => ({ records: group, period: browserCanonicalPeriod(group) }));
}
async function ownerIdsForService(models: ModelUsageRecord[], browsers: BrowserUsageRecord[], lines: ServiceCostRecord[]): Promise<string[]> {
  const ids = new Set([...models.map((record) => record.userId), ...browsers.map((record) => record.userId), ...lines.flatMap((line) => line.allocations.map((allocation) => allocation.userId))]);
  if (isDemo()) ids.add("demo-user");
  else {
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await adminSupabase().from("app_states").select("user_id").range(offset, offset + 499);
      if (error) throw new Error("Owner states could not be loaded.");
      for (const row of data ?? []) ids.add(row.user_id);
      if (!data || data.length < 500) break;
    }
  }
  return [...ids];
}

export async function costReport(ownerId: string, options: { service?: boolean; period?: string } = {}): Promise<CostReport> {
  const service = options.service === true;
  const [lines, modelRecords, browserRecords] = await Promise.all([readServiceCosts(options.period), service ? readAllModelUsage() : readModelUsage(ownerId).then((report) => report.records), service ? readAllBrowserUsage() : readBrowserUsage(ownerId).then((report) => report.records)]);
  const period = options.period;
  const scopedModels = uniqueModelRecords(modelRecords).filter((record) => periodMatches(record.startedAt, period));
  const canonicalBrowsers = canonicalBrowserGroups(browserRecords);
  const scopedBrowsers = canonicalBrowsers.filter((group) => periodMatches(group.period, period)).flatMap((group) => group.records);
  const ownerIds = service ? await ownerIdsForService(scopedModels, scopedBrowsers, lines) : [ownerId];
  const states = await Promise.all(ownerIds.map(async (id) => [id, await loadState(id)] as const));
  const evidence = new Map<string, CostEvidence>();
  for (const record of scopedModels) if (service || record.userId === ownerId) addUniqueEvidence(evidence, modelEvidence(record));
  const browsersBySession = new Map<string, BrowserUsageRecord[]>();
  for (const record of scopedBrowsers) if (service || record.userId === ownerId) if (!record.sessionId) { addUniqueEvidence(evidence, nullSessionEvidence(record)); addUniqueEvidence(evidence, nullSessionProxyEvidence(record)); }
  for (const record of scopedBrowsers) if (service || record.userId === ownerId) if (record.sessionId) {
    const key = `${record.provider}:${record.sessionId}`;
    browsersBySession.set(key, [...(browsersBySession.get(key) ?? []), record]);
  }
  for (const sessionRecords of browsersBySession.values()) {
    sessionRecords.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const latest = sessionRecords.at(-1)!;
    const final = sessionRecords.filter((item) => item.report?.status === "stopped" || item.report?.finishedAt !== undefined).at(-1);
    const report = sessionRecords.reduce((merged, item) => ({ ...merged, ...(item.report ?? {}) }), {} as NonNullable<BrowserUsageRecord["report"]>);
    if (final?.report) Object.assign(report, final.report, { status: "stopped" });
    const record = { ...latest, report };
    const browserCost = report.browserCostUsd;
    const proxyCost = report.proxyCostUsd;
    const start = report.startedAt ? Date.parse(report.startedAt) : NaN;
    const finish = report.finishedAt ? Date.parse(report.finishedAt) : NaN;
    const durationMinutes = Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? Math.max(1, Math.ceil((finish - start) / 60_000)) : null;
    const estimatedBrowser = browserCost === undefined && durationMinutes !== null && report.rate ? durationMinutes * report.rate.browserUsdPerMinute : null;
    const amount = browserCost === undefined && estimatedBrowser === null ? null : (browserCost ?? estimatedBrowser ?? 0);
    addUniqueEvidence(evidence, browserEvidence(record, amount, browserCost === undefined && estimatedBrowser === null, browserCanonicalPeriod(sessionRecords), browserCost !== undefined ? "measured" : estimatedBrowser !== null ? "estimated" : undefined));
    addUniqueEvidence(evidence, proxyEvidence(record, proxyCost ?? null, browserCanonicalPeriod(sessionRecords)));
  }
  const relevantLines = service ? lines : lines.filter((line) => line.allocations.some((allocation) => allocation.userId === ownerId));
  const evidenceValues = [...evidence.values()];
  const reconciledIds = new Set(relevantLines.flatMap((line) => line.reconciles.filter((identity) => {
    const item = evidence.get(identity);
    return item && item.provider === line.provider && item.period === line.period && (service || line.allocations.some((allocation) => allocation.userId === item.ownerId)) && ((line.category === "model" && item.category === "model") || (line.category === "browser" && item.category === "browser"));
  })));
  let measuredEstimateUsd = 0, unreconciledEstimateUsd = 0, reconciledUsd = 0, unknownComponents = 0;
  for (const item of evidence.values()) {
    if (item.unknown) unknownComponents++;
    if (item.amountUsd === null) continue;
    measuredEstimateUsd += item.amountUsd;
    if (!reconciledIds.has(item.id)) unreconciledEstimateUsd += item.amountUsd;
  }
  const invoiceLines = relevantLines.map((line) => {
    const allocation = service ? null : line.allocations.find((item) => item.userId === ownerId);
    // The immutable invoice line was validated when imported. Source evidence
    // may later be archived or its owner removed, but the charge remains real.
    const allocatedUsd = allocation?.amountUsd ?? (service ? line.amountUsd : null);
    if (allocatedUsd !== null) reconciledUsd += allocatedUsd;
    return { id: line.id, provider: line.provider, invoiceId: line.invoiceId, lineId: line.lineId, period: line.period, category: line.category, amountUsd: service ? line.amountUsd : allocatedUsd ?? 0, currency: line.currency, allocationMethod: line.allocationMethod, reconciles: line.reconciles, allocatedUsd };
  });
  for (const line of relevantLines) {
    const covered = line.reconciles.filter((identity) => reconciledIds.has(identity));
    if (!covered.length) continue;
    const allocation = service ? line.amountUsd : line.allocations.find((item) => item.userId === ownerId)?.amountUsd ?? 0;
    for (const identity of covered) {
      const item = evidence.get(identity);
      if (item) item.reconciledUsd = allocation / covered.length;
    }
  }
  const scopedApplications = states.flatMap(([, state]) => state.applications);
  const projectedUsd = scopedApplications.flatMap((app) => (app.runs ?? []).filter((run) => periodMatches(run.requestedAt, period))).reduce((sum, run) => sum + run.projectedUsd, 0);
  const heldRequests = scopedApplications.filter((app) => app.queuedRun?.reason === "budget" && periodMatches(app.queuedRun.requestedAt, period)).length;
  const confirmedSubmissions = scopedApplications.filter((app) => (app.status === "submitted" || Boolean(app.submittedAt)) && periodMatches(app.submittedAt, period)).length;
  // Active means the account initiated or attempted service work in the period.
  // Keep cancelled and failed attempts in this denominator because their usage
  // evidence still contributes to the service cost.
  const activeOwners = new Set(evidenceValues.map((item) => item.ownerId));
  for (const [id, state] of states) {
    if (state.applications.some((app) => periodMatches(app.createdAt, period) || periodMatches(app.submittedAt, period) || app.runs?.some((run) => periodMatches(run.requestedAt, period)) || periodMatches(app.queuedRun?.requestedAt, period))) activeOwners.add(id);
  }
  const activeUsers = activeOwners.size;
  const knownTotalUsd = unreconciledEstimateUsd + reconciledUsd;
  return { scope: service ? "service" : "owner", ...(service ? {} : { ownerId }), ...(options.period ? { period: options.period } : {}), projectedUsd, measuredEstimateUsd, unreconciledEstimateUsd, reconciledUsd, knownTotalUsd, unknownComponents, confirmedSubmissions, costPerConfirmedSubmission: confirmedSubmissions > 0 ? knownTotalUsd / confirmedSubmissions : null, activeUsers, costPerActiveUser: activeUsers > 0 ? knownTotalUsd / activeUsers : null, heldRequests, invoiceLines, evidence: evidenceValues };
}

export function costReportCsv(report: CostReport): string {
  const rows = [
    ["rowType", "scope", "ownerId", "category", "evidenceId", "amountUsd", "reconciledUsd", "status", "applicationId", "backgroundJobId", "runId", "provider", "period", "invoiceId", "lineId", "allocationMethod"],
    ["summary", report.scope, report.ownerId ?? "service", "projected", "", String(report.projectedUsd), "", "", "", "", "", "", report.period ?? "", "", "", ""],
    ["summary", report.scope, report.ownerId ?? "service", "known-total", "", String(report.knownTotalUsd), "", `${report.unknownComponents} unknown`, "", "", "", "", report.period ?? "", "", "", ""],
    ...report.invoiceLines.map((line) => ["invoice", report.scope, report.ownerId ?? "service", line.category, "", String(line.amountUsd), "", "", "", "", "", line.provider, line.period, line.invoiceId, line.lineId, line.allocationMethod]),
    ...report.evidence.map((item) => ["evidence", report.scope, report.scope === "service" ? item.ownerId : report.ownerId ?? item.ownerId, `${item.category}:${item.component}`, item.id, item.amountUsd === null ? "" : String(item.amountUsd), item.reconciledUsd === null ? "" : String(item.reconciledUsd), item.status, item.applicationId ?? "", item.backgroundJobId ?? "", item.runId, item.provider, item.period ?? "", "", "", ""]),
  ];
  return rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}
