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
  parse.mockResolvedValueOnce({ id: "draft-response", model: "gpt-6-sol", service_tier: "default", usage, output_parsed: { sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "I want to contribute.", kind: "perspective", factIds: [] }] } });
  parse.mockResolvedValueOnce({ id: "audit-response", model: "gpt-6-luna", service_tier: "default", usage, output_parsed: { grounded: false, unsupportedClaims: ["uncertain"] } });
  const answer = await withModelUsageContext({ userId, applicationId: "application", runId: "draft-run", jobId: state.jobs[0].id }, () => draftAiEssay(state.profile, state.jobs[0], "Why are you interested?"));
  expect(answer.aiDraft).toBeUndefined();
  const report = await readModelUsage(userId);
  expect(report.records).toHaveLength(2);
  expect(report.records.every((record) => record.applicationId === "application" && record.runId === "draft-run")).toBe(true);
  expect(report.records.find((record) => record.operation === "essay-generation")?.tokens).toEqual({ input: 1000, cachedInput: 200, cacheWrite: 0, output: 100, reasoningOutput: 60 });
  expect(report.records.find((record) => record.operation === "essay-generation")?.estimatedUsd).toBeCloseTo(0.00264, 8);
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
