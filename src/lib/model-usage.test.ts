import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { parse }; } }));
import { assessMatch } from "@/lib/matching";
import { initialDemoState } from "@/lib/demo-data";
import { draftAiEssay } from "@/lib/essay-drafting";
import { readModelUsage, withModelUsageContext, meterModelResponse, recordModelUsage } from "@/lib/model-usage";

beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", "fixture"); parse.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
it("retains measured drafting and audit usage even when grounding fails", async () => {
  const state = initialDemoState();
  const userId = randomUUID();
  state.profile.id = userId;
  const fact = state.profile.facts[0];
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } };
  parse.mockResolvedValueOnce({ id: "draft-response", model: "gpt-6-luna", service_tier: "default", usage, output_parsed: { sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "I want to contribute.", kind: "perspective", factIds: [] }] } });
  parse.mockResolvedValueOnce({ id: "audit-response", model: "gpt-6-luna", service_tier: "default", usage, output_parsed: { grounded: false, unsupportedClaims: ["uncertain"] } });
  const answer = await withModelUsageContext({ userId, applicationId: "application", runId: "draft-run", jobId: state.jobs[0].id }, () => draftAiEssay(state.profile, state.jobs[0], "Why are you interested?"));
  expect(answer.aiDraft).toBeUndefined();
  const report = await readModelUsage(userId);
  expect(report.records).toHaveLength(2);
  expect(report.records.every((record) => record.applicationId === "application" && record.runId === "draft-run")).toBe(true);
  expect(report.records.find((record) => record.operation === "essay-generation")?.tokens).toEqual({ input: 1000, cachedInput: 200, cacheWrite: 0, output: 100, reasoningOutput: 60 });
  expect(parse.mock.calls[0][0].model).toBe("gpt-6-luna");
  expect(report.records.find((record) => record.operation === "essay-generation")?.estimatedUsd).toBeCloseTo(0.000132, 8);
  expect(report.reconciledUsd).toBeNull();
});

it("keeps failed and retried background matching calls without inventing an application", async () => {
  const state = initialDemoState();
  state.profile.id = randomUUID();
  parse.mockRejectedValueOnce(Object.assign(new Error("transport"), { name: "AbortError" }));
  await assessMatch(state.profile, state.jobs[0]);
  parse.mockResolvedValueOnce({ id: "match-retry", model: "gpt-6-luna", output_parsed: null, usage: { input_tokens: 20, output_tokens: 10 } });
  await assessMatch(state.profile, state.jobs[0]);
  const report = await readModelUsage(state.profile.id);
  expect(report.records).toHaveLength(2);
  expect(report.records.every((item) => !item.applicationId && item.jobId === state.jobs[0].id && item.backgroundJobId)).toBe(true);
  expect(report.records.find((item) => item.status === "failed")?.tokens.input).toBeNull();
  expect(report.records.find((item) => item.status === "failed")?.failure).toBe("aborted");
  expect(report.unknownCalls).toBe(1);
  expect(report.incompleteCostCalls).toBe(2);
});

it("runs the matching freshness guard after the started usage record is persisted", async () => {
  const state = initialDemoState();
  const userId = randomUUID();
  state.profile.id = userId;
  state.profile.workAuthorization = "Authorized to work in the US";
  const job = state.jobs[0];
  parse.mockResolvedValueOnce({ id: "guarded-match", model: "gpt-6-luna", service_tier: "default", usage: { input_tokens: 20, output_tokens: 10 }, output_parsed: { category: "strong", score: 90, evidence: [{ jobQuote: job.title, factIds: [state.profile.facts[0].id] }], gaps: [], uncertainty: [] } });
  let recordsBeforeProvider = 0;
  const result = await assessMatch(state.profile, job, { beforeModelCall: async () => { recordsBeforeProvider = (await readModelUsage(userId)).records.length; } });
  expect(recordsBeforeProvider).toBe(1);
  expect(result.model).toBe("gpt-6-luna");
  expect(parse).toHaveBeenCalledOnce();
});

it("does not turn a failed matching freshness guard into a cached fallback", async () => {
  const state = initialDemoState();
  state.profile.id = randomUUID();
  await expect(assessMatch(state.profile, state.jobs[0], { beforeModelCall: () => { throw new Error("matching context changed"); } })).rejects.toThrow("matching context changed");
  expect(parse).not.toHaveBeenCalled();
  expect((await readModelUsage(state.profile.id)).records[0].status).toBe("failed");
});

it("keeps an unknown failed replay shaped with nullable fields", async () => {
  const userId = randomUUID();
  const id = randomUUID();
  const incomplete = {
    version: 1 as const, id, userId, runId: "failed-run", provider: "openai" as const, model: "gpt-6-luna", operation: "matching",
    startedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:01:00.000Z", status: "failed" as const,
    responseId: null, requestId: null, providerStatus: null, serviceTier: null, tokens: {} as never,
    rate: undefined as never, estimatedUsd: undefined as never, reconciledUsd: undefined as never, failure: "provider_error" as const,
  };
  await recordModelUsage(incomplete);
  const report = await readModelUsage(userId);
  expect(report.measuredCalls).toBe(0);
  expect(report.unknownCalls).toBe(1);
  expect(report.estimatedUsd).toBe(0);
  expect(report.incompleteCostCalls).toBe(1);
  expect(report.records[0].tokens).toEqual({ input: null, cachedInput: null, cacheWrite: null, output: null, reasoningOutput: null });
  expect(report.records[0].rate).toBeNull();
  expect(report.records[0].estimatedUsd).toBeNull();
});

it("reconciles replayed reports and provider responses once and isolates owners", async () => {
  const userId = randomUUID();
  const otherId = randomUUID();
  const response = { id: `response-${randomUUID()}`, model: "gpt-6-sol", service_tier: "default", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 } } };
  await meterModelResponse({ userId, applicationId: "cancelled-application" }, "resume-generation", "gpt-6-sol", async () => response);
  const record = (await readModelUsage(userId)).records[0];
  await recordModelUsage(record);
  await recordModelUsage({ ...record, completedAt: null, status: "started" });
  await meterModelResponse({ userId, applicationId: "cancelled-application" }, "resume-generation", "gpt-6-sol", async () => response);
  await meterModelResponse({ userId: otherId, backgroundJobId: "other-owner-job" }, "matching", "gpt-6-luna", async () => ({ id: "other-response" }));
  const report = await readModelUsage(userId);
  expect(report.records).toHaveLength(1);
  expect(report.estimatedUsd).toBeCloseTo(0.00269, 8);
  expect(report.records[0].tokens.cacheWrite).toBe(100);
  expect((await readModelUsage(otherId)).records).toHaveLength(1);
  await expect(recordModelUsage({ ...record, userId: otherId })).rejects.toThrow(/another owner/);
});

it("uses a later complete provider report when an earlier delivery lacks measurements", async () => {
  const userId = randomUUID();
  const id = `late-report-${randomUUID()}`;
  await meterModelResponse({ userId, backgroundJobId: "matching:job" }, "matching", "gpt-6-luna", async () => ({ id }));
  await meterModelResponse({ userId, backgroundJobId: "matching:job" }, "matching", "gpt-6-luna", async () => ({ id, model: "gpt-6-luna", service_tier: "default", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 }, output_tokens: 100 } }));
  const report = await readModelUsage(userId);
  expect(report.records).toHaveLength(1);
  expect(report.measuredCalls).toBe(1);
  expect(report.estimatedUsd).toBeCloseTo(0.000132, 8);
});

it("preserves a fuller completed report across older and newer same-id partial replays", async () => {
  const userId = randomUUID();
  const id = `same-id-${randomUUID()}`;
  const full = {
    version: 1 as const, id, userId, runId: "run", provider: "openai" as const, model: "gpt-6-sol", operation: "matching",
    startedAt: "2026-10-01T00:10:00.000Z", completedAt: "2026-10-01T00:11:00.000Z", status: "reported" as const,
    responseId: "response", requestId: null, providerStatus: "completed", serviceTier: "default",
    tokens: { input: 1000, cachedInput: 200, cacheWrite: 100, output: 100, reasoningOutput: 60 },
    rate: { version: "openai-standard-2026-10-01" as const, source: "pricing", checkedAt: "2026-10-01" as const, unit: "USD per million tokens" as const, context: "short" as const, input: 2, cachedInput: .2, cacheWrite: 2.5, output: 10 },
    estimatedUsd: .00269, reconciledUsd: null, failure: null,
  };
  await recordModelUsage(full);
  await recordModelUsage({ ...full, startedAt: "2026-10-01T00:01:00.000Z", completedAt: "2026-10-01T00:02:00.000Z", responseId: null, providerStatus: null, rate: null, estimatedUsd: null, tokens: { input: 1000, cachedInput: null, cacheWrite: null, output: null, reasoningOutput: null } });
  await recordModelUsage({ ...full, startedAt: "2026-10-01T00:20:00.000Z", completedAt: "2026-10-01T00:21:00.000Z", responseId: null, providerStatus: null, rate: null, estimatedUsd: null, tokens: { input: 1000, cachedInput: null, cacheWrite: null, output: null, reasoningOutput: null } });
  await recordModelUsage({ ...full, startedAt: "2026-10-01T00:30:00.000Z", completedAt: "2026-10-01T00:31:00.000Z", tokens: { ...full.tokens, output: 999 }, estimatedUsd: .09 });
  await recordModelUsage({ ...full, startedAt: "2026-10-01T00:25:00.000Z", completedAt: "2026-10-01T00:26:00.000Z", tokens: { ...full.tokens, output: 1 }, estimatedUsd: .0001 });
  const report = await readModelUsage(userId);
  expect(report.measuredCalls).toBe(1);
  expect(report.estimatedUsd).toBeCloseTo(.09, 8);
  expect(report.records[0].tokens).toMatchObject({ input: 1000, cachedInput: 200, cacheWrite: 100, output: 999, reasoningOutput: 60 });
});

it("includes hosted web-search tool fees alongside token usage", async () => {
  const userId = randomUUID();
  await meterModelResponse({ userId }, "personal-job-search", "gpt-6-luna", async () => ({
    id: randomUUID(), model: "gpt-6-luna", service_tier: "default",
    output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "message" }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 100 },
  }));
  const record = (await readModelUsage(userId)).records[0];
  expect(record.webSearchCalls).toBe(2); expect(record.webSearchUsd).toBe(0.02);
  expect(record.estimatedUsd).toBeCloseTo(0.02015, 8);
});
