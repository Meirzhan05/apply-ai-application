import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import type { BrowserProvider } from "@/lib/types";

export type BrowserUsageEvent =
  | "created" | "connected" | "disconnected" | "status" | "stopped"
  | "expired" | "cancelled" | "failed" | "ambiguous" | "release_failed";

export interface BrowserUsageRate {
  version: "browser-use-2026-10-01";
  source: "https://browser-use.com/pricing";
  checkedAt: "2026-10-01";
  unit: "USD per browser minute";
  browserUsdPerMinute: number;
}

export const BROWSER_USE_RATE: BrowserUsageRate = {
  version: "browser-use-2026-10-01", source: "https://browser-use.com/pricing", checkedAt: "2026-10-01",
  unit: "USD per browser minute", browserUsdPerMinute: 0.02 / 60,
};

export interface BrowserProviderReport {
  status?: "active" | "stopped" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  expiresAt?: string;
  proxyUsedMb?: number;
  proxyCostUsd?: number;
  browserCostUsd?: number;
  rate?: BrowserUsageRate;
}

export interface BrowserUsageContext {
  userId: string;
  applicationId?: string;
  jobId?: string;
  runId: string;
}

export interface BrowserUsageRecord extends BrowserUsageContext {
  version: 1;
  id: string;
  provider: BrowserProvider;
  sessionId: string | null;
  event: BrowserUsageEvent;
  occurredAt: string;
  report: BrowserProviderReport | null;
  failure: "allocation_failed" | "ambiguous_allocation" | "release_failed" | null;
  orphanedSessionId: string | null;
}

export interface BrowserUsageSession extends BrowserUsageContext {
  provider: BrowserProvider;
  sessionId: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  status: "active" | "stopped" | "unknown";
  durationMinutes: number | null;
  proxyUsedMb: number | null;
  proxyCostUsd: number | null;
  browserCostUsd: number | null;
  rate: BrowserUsageRate | null;
  estimatedBrowserCostUsd: number | null;
  estimatedUsd: number | null;
  trafficStatus: "measured" | "unknown";
  lastEvent: BrowserUsageEvent;
  provisional: boolean;
  orphaned: boolean;
}

export interface BrowserUsageReport {
  records: BrowserUsageRecord[];
  sessions: BrowserUsageSession[];
  measuredSessions: number;
  activeSessions: number;
  unknownTrafficSessions: number;
  estimatedUsd: number;
  measuredUsd: number;
  incompleteCostSessions: number;
}

const context = new AsyncLocalStorage<BrowserUsageContext>();
export function withBrowserUsageContext<T>(owner: BrowserUsageContext, work: () => T): T {
  return context.run(owner, work);
}
export function browserUsageContext(): BrowserUsageContext | undefined { return context.getStore(); }

const localPath = () => {
  if (process.env.NODE_ENV === "test") return path.join(process.env.BROWSER_USAGE_TEST_DIR || "/tmp", `apply-browser-usage-${process.pid}.json`);
  return isDemo() ? path.join(process.cwd(), ".data", "browser-usage.json") : undefined;
};
let writes: Promise<unknown> = Promise.resolve();
async function readLocal(file: string): Promise<BrowserUsageRecord[]> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function browserUsageEventId(provider: BrowserProvider, sessionId: string | null, event: BrowserUsageEvent, runId: string): string {
  return `${provider}:${sessionId ?? "allocation"}:${event}:${runId}`;
}

export async function recordBrowserUsage(record: BrowserUsageRecord): Promise<void> {
  if (!record.userId || !record.id || !record.runId) throw new Error("Browser usage requires an owner, event and run.");
  const normalized = record.report && record.provider === "browser-use" && !record.report.rate
    ? { ...record, report: { ...record.report, rate: BROWSER_USE_RATE } } : record;
  const file = localPath();
  if (file) {
    const write = writes.then(async () => {
      const records = await readLocal(file);
      const previous = records.find((item) => item.id === normalized.id);
      if (previous && previous.userId !== normalized.userId) throw new Error("Browser usage belongs to another owner.");
      const next = [...records.filter((item) => item.id !== normalized.id), mergeBrowserUsageRecord(previous, normalized)];
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
    });
    writes = write.catch(() => undefined);
    await write;
    return;
  }
  const { error } = await adminSupabase().rpc("record_browser_usage", { p_record: normalized });
  if (error) throw new Error("Browser usage could not be persisted.");
}

function isFinalReport(report: BrowserProviderReport | null): boolean {
  return report?.status === "stopped" || report?.finishedAt !== undefined;
}
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
function normalizedReport(report: BrowserProviderReport | null): BrowserProviderReport | null {
  return report ? withoutUndefined(report) : null;
}
function mergeBrowserUsageRecord(previous: BrowserUsageRecord | undefined, incoming: BrowserUsageRecord): BrowserUsageRecord {
  if (!previous) return incoming;
  const previousReport = normalizedReport(previous.report), incomingReport = normalizedReport(incoming.report);
  const previousFinal = isFinalReport(previousReport), incomingFinal = isFinalReport(incomingReport);
  const incomingNewer = incoming.occurredAt >= previous.occurredAt;
  const newer = incomingNewer ? incoming : previous;
  const older = incomingNewer ? previous : incoming;
  const primary = previousFinal && !incomingFinal ? previousReport : normalizedReport(newer.report);
  const secondary = previousFinal && !incomingFinal ? incomingReport : normalizedReport(older.report);
  const report = primary || secondary ? withoutUndefined({ ...(secondary ?? {}), ...(primary ?? {}) }) : null;
  const merged = { ...older, ...newer, occurredAt: newer.occurredAt, report };
  if (incoming.applicationId === undefined) merged.applicationId = previous.applicationId;
  if (incoming.jobId === undefined) merged.jobId = previous.jobId;
  return merged;
}

export async function recordBrowserUsageEvent(event: Omit<BrowserUsageRecord, "version" | "id" | "occurredAt"> & { occurredAt?: string }): Promise<void> {
  await recordBrowserUsage({ ...event, version: 1, occurredAt: event.occurredAt ?? new Date().toISOString(), id: browserUsageEventId(event.provider, event.sessionId, event.event, event.runId) });
}

function minutes(startedAt: string | null, finishedAt: string | null, active: boolean): number | null {
  if (!startedAt) return null;
  const end = finishedAt ? Date.parse(finishedAt) : active ? Date.now() : NaN;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(1, Math.ceil((end - start) / 60_000));
}

function sessionFrom(records: BrowserUsageRecord[], owner: BrowserUsageContext, provider: BrowserProvider, sessionId: string): BrowserUsageSession {
  const events = records.filter((record) => record.provider === provider && record.sessionId === sessionId).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const reportEntries = events.flatMap((event) => event.report ? [{ event, report: event.report }] : []);
  const reports = reportEntries.map((entry) => entry.report);
  const complete = (report: BrowserProviderReport) => Object.values(report).filter((value) => value !== undefined).length;
  const finalEntry = reportEntries.filter(({ report }) => report.status === "stopped" || report.finishedAt !== undefined)
    .sort((a, b) => complete(b.report) - complete(a.report) || b.event.occurredAt.localeCompare(a.event.occurredAt)).at(0);
  const final = finalEntry?.report;
  const latest = final ?? reports.at(-1) ?? {};
  // A late, partial active/status replay cannot erase a confirmed stop. Fill
  // only fields missing from the winning report, so explicit zeroes remain zero.
  const fill = <K extends keyof BrowserProviderReport>(key: K) => latest[key] ?? [...reportEntries].reverse().find(({ report }) => report[key] !== undefined)?.report[key];
  const startedAt = fill("startedAt") ?? null;
  const finishedAt = final?.finishedAt ?? null;
  const expiresAt = fill("expiresAt") ?? null;
  const status = final?.status ?? latest.status ?? "unknown";
  const active = status === "active";
  const durationMinutes = minutes(startedAt, finishedAt, active);
  const proxyUsedMb = fill("proxyUsedMb") ?? null;
  const proxyCostUsd = fill("proxyCostUsd") ?? null;
  const browserCostUsd = fill("browserCostUsd") ?? null;
  const rate = fill("rate") ?? null;
  const estimatedBrowserCostUsd = browserCostUsd === null && durationMinutes !== null && rate ? durationMinutes * rate.browserUsdPerMinute : null;
  let orphaned = false;
  for (const event of events) {
    if (event.event === "release_failed" || event.orphanedSessionId === sessionId) orphaned = true;
    if ((event.event === "stopped" || event.event === "status") && event.report?.status === "stopped") orphaned = false;
  }
  return { ...owner, provider, sessionId, startedAt, finishedAt, expiresAt, status, durationMinutes, proxyUsedMb, proxyCostUsd, browserCostUsd,
    rate, estimatedBrowserCostUsd, estimatedUsd: browserCostUsd ?? estimatedBrowserCostUsd, trafficStatus: proxyUsedMb === null ? "unknown" : "measured",
    lastEvent: finalEntry?.event.event ?? events.at(-1)?.event ?? "created", provisional: active || browserCostUsd === null, orphaned };
}

export async function readBrowserUsage(userId: string): Promise<BrowserUsageReport> {
  const file = localPath();
  let records: BrowserUsageRecord[];
  if (file) { await writes; records = (await readLocal(file)).filter((item) => item.userId === userId); }
  else {
    records = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await adminSupabase().from("browser_usage_records").select("data").eq("user_id", userId).order("occurred_at", { ascending: false }).range(offset, offset + 499);
      if (error) throw new Error("Browser usage could not be loaded.");
      records.push(...(data ?? []).map((row) => row.data as BrowserUsageRecord));
      if (!data || data.length < 500) break;
    }
  }
  const sessions = new Map<string, BrowserUsageSession>();
  for (const record of records) if (record.sessionId) sessions.set(`${record.provider}:${record.sessionId}`, sessionFrom(records, { userId: record.userId, applicationId: record.applicationId, jobId: record.jobId, runId: record.runId }, record.provider, record.sessionId));
  const values = [...sessions.values()];
  return { records: records.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)), sessions: values.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
    measuredSessions: values.filter((session) => session.browserCostUsd !== null || session.proxyUsedMb !== null).length,
    activeSessions: values.filter((session) => session.status === "active").length,
    unknownTrafficSessions: values.filter((session) => session.trafficStatus === "unknown").length,
    estimatedUsd: values.reduce((sum, session) => sum + (session.estimatedUsd ?? 0), 0),
    measuredUsd: values.reduce((sum, session) => sum + (session.browserCostUsd ?? 0) + (session.proxyCostUsd ?? 0), 0),
    incompleteCostSessions: values.filter((session) => session.estimatedUsd === null || session.proxyCostUsd === null).length };
}
