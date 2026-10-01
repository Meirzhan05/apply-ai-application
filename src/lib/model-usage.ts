import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import { writeUsageLedger } from "@/lib/usage-ledger";

export interface ModelUsageContext {
  userId: string;
  applicationId?: string;
  jobId?: string;
  backgroundJobId?: string;
  runId: string;
}
export interface ModelRate {
  version: "openai-standard-2026-10-01";
  source: string;
  checkedAt: "2026-10-01";
  unit: "USD per million tokens";
  context: "short" | "long";
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}
export interface ModelUsageRecord extends ModelUsageContext {
  version: 1;
  id: string;
  provider: "openai";
  model: string;
  operation: string;
  startedAt: string;
  completedAt: string | null;
  status: "started" | "reported" | "failed";
  responseId: string | null;
  requestId: string | null;
  providerStatus: string | null;
  serviceTier: string | null;
  tokens: { input: number | null; cachedInput: number | null; cacheWrite: number | null; output: number | null; reasoningOutput: number | null };
  rate: ModelRate | null;
  estimatedUsd: number | null;
  reconciledUsd: number | null;
  failure: "aborted" | "provider_error" | null;
}
export interface ModelUsageReport {
  records: ModelUsageRecord[];
  measuredCalls: number;
  unknownCalls: number;
  estimatedUsd: number;
  incompleteCostCalls: number;
  reconciledUsd: null;
}
const context = new AsyncLocalStorage<ModelUsageContext>();
export function withModelUsageContext<T>(owner: ModelUsageContext, work: () => T): T {
  return context.run(owner, work);
}
const localPath = () => {
  if (process.env.NODE_ENV === "test") return path.join(process.env.MODEL_USAGE_TEST_DIR || "/tmp", `apply-model-usage-${process.pid}.json`);
  return isDemo() ? path.join(process.cwd(), ".data", "model-usage.json") : undefined;
};
let writes: Promise<unknown> = Promise.resolve();
async function readLocal(file: string): Promise<ModelUsageRecord[]> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function usageCompleteness(record: ModelUsageRecord): number {
  return Object.values(record.tokens).filter((value) => value !== null).length
    + (record.rate ? 1 : 0) + (record.estimatedUsd !== null ? 1 : 0)
    + (record.responseId ? 1 : 0) + (record.providerStatus ? 1 : 0);
}
function usageTimestamp(record: ModelUsageRecord): string {
  return record.completedAt ?? record.startedAt;
}
function normalizeModelUsageRecord(record: ModelUsageRecord): ModelUsageRecord {
  return { ...record, completedAt: record.completedAt ?? null, responseId: record.responseId ?? null,
    requestId: record.requestId ?? null, providerStatus: record.providerStatus ?? null, serviceTier: record.serviceTier ?? null,
    tokens: { input: record.tokens?.input ?? null, cachedInput: record.tokens?.cachedInput ?? null, cacheWrite: record.tokens?.cacheWrite ?? null, output: record.tokens?.output ?? null, reasoningOutput: record.tokens?.reasoningOutput ?? null },
    rate: record.rate ?? null, estimatedUsd: record.estimatedUsd ?? null, reconciledUsd: record.reconciledUsd ?? null, failure: record.failure ?? null };
}
function mergeModelUsageRecord(previous: ModelUsageRecord, incoming: ModelUsageRecord): ModelUsageRecord {
  const previousComplete = previous.completedAt !== null;
  const incomingComplete = incoming.completedAt !== null;
  if (previousComplete && !incomingComplete) return previous;
  const previousScore = usageCompleteness(previous), incomingScore = usageCompleteness(incoming);
  if (incomingScore < previousScore || (incomingScore === previousScore && usageTimestamp(incoming) < usageTimestamp(previous))) return previous;
  const primary = incoming, secondary = previous;
  const tokens = Object.fromEntries(Object.keys(primary.tokens).map((key) => {
    const name = key as keyof ModelUsageRecord["tokens"];
    return [name, primary.tokens[name] ?? secondary.tokens[name]];
  })) as ModelUsageRecord["tokens"];
  return { ...secondary, ...primary, completedAt: primary.completedAt ?? secondary.completedAt,
    responseId: primary.responseId ?? secondary.responseId, requestId: primary.requestId ?? secondary.requestId,
    providerStatus: primary.providerStatus ?? secondary.providerStatus, serviceTier: primary.serviceTier ?? secondary.serviceTier,
    tokens, rate: primary.rate ?? secondary.rate, estimatedUsd: primary.estimatedUsd ?? secondary.estimatedUsd,
    reconciledUsd: primary.reconciledUsd ?? secondary.reconciledUsd, failure: primary.failure ?? secondary.failure };
}

// Stable invocation IDs make replayed reports updates, never additional charges.
// This ledger is separate from owner-state CAS: provider work cannot be rerun by a state retry.
export async function recordModelUsage(record: ModelUsageRecord): Promise<void> {
  if (!record.userId || !record.id || !record.runId) throw new Error("Model usage requires an owner, invocation and run.");
  record = normalizeModelUsageRecord(record);
  const file = localPath();
  if (file) {
    const write = writes.then(() => writeUsageLedger({ file, record, merge: (previous, incoming) => previous ? mergeModelUsageRecord(previous, incoming) : incoming }));
    writes = write.catch(() => undefined);
    await write;
    return;
  }
  const { error } = await adminSupabase().rpc("record_model_usage", { p_record: record });
  if (error) throw new Error("Model usage could not be persisted.");
}

export async function readModelUsage(userId: string): Promise<ModelUsageReport> {
  const file = localPath();
  let records: ModelUsageRecord[];
  if (file) { await writes; records = (await readLocal(file)).map(normalizeModelUsageRecord).filter((item) => item.userId === userId); }
  else {
    records = [];
    // Supabase's default page size must not silently truncate cost evidence.
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await adminSupabase().from("model_usage_records").select("data").eq("user_id", userId).order("id").range(offset, offset + 499);
      if (error) throw new Error("Model usage could not be loaded.");
      records.push(...(data ?? []).map((row) => normalizeModelUsageRecord(row.data as ModelUsageRecord)));
      if (!data || data.length < 500) break;
    }
  }
  // A provider may replay one response under a different delivery ID. Count it once.
  const identities = new Map<string, ModelUsageRecord>();
  for (const record of records) {
    const key = record.responseId ? `${record.provider}:${record.responseId}` : record.id;
    const previous = identities.get(key);
    if (!previous || usageCompleteness(record) > usageCompleteness(previous) ||
      (usageCompleteness(record) === usageCompleteness(previous) && usageTimestamp(record) > usageTimestamp(previous))) identities.set(key, record);
  }
  records = [...identities.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const measuredCalls = records.filter((item) => item.tokens.input !== null && item.tokens.output !== null).length;
  return { records, measuredCalls, unknownCalls: records.length - measuredCalls,
    estimatedUsd: records.reduce((sum, item) => sum + (item.estimatedUsd ?? 0), 0),
    incompleteCostCalls: records.filter((item) => item.estimatedUsd === null).length, reconciledUsd: null };
}

// Operator reports use this only after the server authorization boundary. It
// returns raw owner-tagged evidence so the cost service can aggregate without
// exposing one owner's records to another owner.
export async function readAllModelUsage(): Promise<ModelUsageRecord[]> {
  const file = localPath();
  if (file) { await writes; return (await readLocal(file)).map(normalizeModelUsageRecord); }
  const records: ModelUsageRecord[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await adminSupabase().from("model_usage_records").select("data").order("id").range(offset, offset + 499);
    if (error) throw new Error("Model usage could not be loaded.");
    records.push(...(data ?? []).map((row) => normalizeModelUsageRecord(row.data as ModelUsageRecord)));
    if (!data || data.length < 500) break;
  }
  return records;
}

interface ProviderResponse {
  id?: string;
  _request_id?: string | null;
  model?: string;
  status?: string;
  service_tier?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | null;
}
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function price(record: ModelUsageRecord): void {
  const models: Record<string, [number, number, number, number]> = { "gpt-6-sol": [2, 0.2, 2.5, 10], "gpt-6-luna": [0.1, 0.01, 0.125, 0.5], "gpt-6-astra": [10, 1, 12.5, 50] };
  const values = models[record.model];
  const { input, cachedInput, cacheWrite, output } = record.tokens;
  // Unknown tier, cache writes, model or invalid subtotals cannot establish a cost.
  if (!values || record.serviceTier !== "default" || input === null) return;
  const long = input > 272000;
  record.rate = { version: "openai-standard-2026-10-01", source: "https://developers.openai.com/api/docs/pricing", checkedAt: "2026-10-01", unit: "USD per million tokens", context: long ? "long" : "short",
    input: values[0] * (long ? 2 : 1), cachedInput: values[1] * (long ? 2 : 1), cacheWrite: values[2] * (long ? 2 : 1), output: values[3] * (long ? 1.5 : 1) };
  if (cachedInput === null || cacheWrite === null || output === null || cachedInput + cacheWrite > input) return;
  record.estimatedUsd = ((input - cachedInput - cacheWrite) * record.rate.input + cachedInput * record.rate.cachedInput + cacheWrite * record.rate.cacheWrite + output * record.rate.output) / 1_000_000;
}

export async function meterModelResponse<T extends ProviderResponse>(fallback: Omit<ModelUsageContext, "runId"> & { runId?: string }, operation: string, model: string, call: () => Promise<T>): Promise<T> {
  const active = context.getStore();
  if (active && active.userId !== fallback.userId) throw new Error("Model usage owner does not match the active run.");
  const record: ModelUsageRecord = { ...fallback, ...active, runId: active?.runId ?? fallback.runId ?? randomUUID(), id: randomUUID(), version: 1, provider: "openai", model, operation,
    startedAt: new Date().toISOString(), completedAt: null, status: "started", responseId: null, requestId: null, providerStatus: null, serviceTier: null,
    tokens: { input: null, cachedInput: null, cacheWrite: null, output: null, reasoningOutput: null }, rate: null, estimatedUsd: null, reconciledUsd: null, failure: null };
  if (record.applicationId) record.backgroundJobId = undefined;
  // A failed initial write prevents an untracked paid call. Interrupted work leaves unknown usage.
  await recordModelUsage(record);
  let response: T;
  try { response = await call(); }
  catch (error) {
    record.status = "failed";
    record.completedAt = new Date().toISOString();
    record.failure = error instanceof Error && error.name === "AbortError" ? "aborted" : "provider_error";
    // Do not retain error messages, prompts, answers or provider headers containing private data.
    await recordModelUsage(record);
    throw error;
  }
  record.status = "reported";
  record.completedAt = new Date().toISOString();
  record.responseId = response.id ?? null;
  record.requestId = response._request_id ?? null;
  record.model = response.model ?? model;
  record.providerStatus = response.status ?? null;
  record.serviceTier = response.service_tier ?? null;
  record.tokens = { input: count(response.usage?.input_tokens), cachedInput: count(response.usage?.input_tokens_details?.cached_tokens), cacheWrite: count(response.usage?.input_tokens_details?.cache_write_tokens), output: count(response.usage?.output_tokens), reasoningOutput: count(response.usage?.output_tokens_details?.reasoning_tokens) };
  // output_tokens already includes reasoning. Adding the detail again would double bill it.
  price(record);
  await recordModelUsage(record);
  return response;
}
