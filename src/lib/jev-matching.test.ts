import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { initialDemoState } from "@/lib/demo-data";
import { assessMatch } from "@/lib/matching";
import { readModelUsage } from "@/lib/model-usage";
import { hashJson } from "@/lib/crypto";
import { matchKey } from "@/lib/match-cache";

const fetchMock = vi.fn();
const choice = (choice: string, confidence = 0.95) => ({ type: "choice", choice, confidence });
const fixture = () => {
  const state = initialDemoState(); state.profile.id = randomUUID();
  state.profile.workAuthorization = "Authorized to work in the US";
  return { profile: state.profile, job: { ...state.jobs[0], requirements: ["Python", "SQL"] } };
};
const reply = (answers: object = {}) => ({ ok: true, json: async () => ({ model: "jev-1.13.0", usage: { input_tokens: 1000, output_tokens: 100 }, answers: {
  experience: choice("fit"), skills: choice("strong"), evidence_0: choice("fact_0"), evidence_1: choice("fact_1"), ...answers,
} }) });
beforeEach(() => { vi.stubEnv("TYPESAFE_API_KEY", "fixture"); vi.stubEnv("OPENAI_API_KEY", ""); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset().mockResolvedValue(reply()); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("uses JEV without OpenAI and links exact posting requirements to confirmed facts", async () => {
  const { profile, job } = fixture();
  const result = await assessMatch(profile, job);
  expect(result).toMatchObject({ category: "strong", model: "jev-1.13.0", score: 100, confidence: .95 });
  expect(result.evidence).toEqual([`Posting: “Python” · Confirmed: ${profile.facts[0].text}`, `Posting: “SQL” · Confirmed: ${profile.facts[1].text}`]);
  expect(fetchMock).toHaveBeenCalledOnce();
  const report = await readModelUsage(profile.id);
  expect(report.records[0]).toMatchObject({ provider: "typesafe", model: "jev-1.13.0", operation: "matching", status: "reported", jobId: job.id });
  expect(report.estimatedUsd).toBeCloseTo(.000042, 8);
});
it("uses automatically grounded resume facts without requiring manual confirmation", async () => {
  const { profile, job } = fixture();
  profile.facts = profile.facts.slice(0, 2).map((fact, index) => ({ ...fact, source: "resume", verified: false, status: "accepted", sourceAnchorId: `anchor-${index}`,
    grounding: { version: 1, sourceHash: "a".repeat(64), model: "fixture", acceptedText: fact.text, evidence: [{ anchorId: `anchor-${index}`, quote: fact.text }] } }));
  const result = await assessMatch(profile, job);
  expect(result.category).toBe("strong");
  expect(result.evidence).toEqual([`Posting: “Python” · Confirmed: ${profile.facts[0].text}`, `Posting: “SQL” · Confirmed: ${profile.facts[1].text}`]);
  const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(JSON.parse(payload.state).applicant.verifiedFacts).toEqual(profile.facts.map(fact => fact.text));
});
it.each([
  { skills: choice("unknown") }, { experience: choice("gap") }, { skills: choice("strong", .3) },
  { evidence_0: choice("unknown") }, { evidence_1: choice("fact_1", .3) },
  { evidence_0: choice("gap"), evidence_1: choice("gap") },
])("keeps unknown, unsupported, and low-confidence decisions uncertain: %j", async answers => {
  fetchMock.mockResolvedValue(reply(answers)); const { profile, job } = fixture();
  expect((await assessMatch(profile, job)).category).toBe("uncertain");
});
it("downgrades a strong skills decision when a requirement has no supporting fact", async () => {
  fetchMock.mockResolvedValue(reply({ evidence_1: choice("gap") })); const { profile, job } = fixture();
  expect(await assessMatch(profile, job)).toMatchObject({ category: "possible", gaps: ["No confirmed evidence yet for “SQL”."] });
});
it("does not let JEV override hard-rule uncertainty or explicit exclusion", async () => {
  const { profile, job } = fixture(); profile.remoteOnly = true;
  expect((await assessMatch(profile, { ...job, remote: null })).category).toBe("uncertain");
  fetchMock.mockClear(); expect((await assessMatch(profile, { ...job, remote: false })).category).toBe("excluded");
  expect(fetchMock).not.toHaveBeenCalled();
});
it.each(["invented_fact", "fact_999", "gap"])("cannot produce a strong match from an invalid or unsupported evidence choice: %s", async value => {
  fetchMock.mockResolvedValue(reply({ evidence_0: choice(value), evidence_1: choice(value) })); const { profile, job } = fixture();
  expect((await assessMatch(profile, job)).category).toBe("uncertain");
});
it("fails closed on provider failure, missing answers, or absent configuration", async () => {
  const { profile, job } = fixture();
  fetchMock.mockRejectedValueOnce(new Error("provider outage"));
  expect(await assessMatch(profile, job)).toMatchObject({ category: "uncertain", evidence: [], model: "rules" });
  fetchMock.mockResolvedValue(reply({ evidence_1: undefined }));
  expect((await assessMatch(profile, job)).category).toBe("uncertain");
  vi.stubEnv("TYPESAFE_API_KEY", ""); fetchMock.mockClear();
  expect((await assessMatch(profile, job)).category).toBe("uncertain"); expect(fetchMock).not.toHaveBeenCalled();
});
it("checks freshness after recording started usage and never calls the provider after revocation", async () => {
  const { profile, job } = fixture();
  await expect(assessMatch(profile, job, { beforeModelCall: async () => {
    expect((await readModelUsage(profile.id)).records[0].status).toBe("started");
    throw new Error("profile changed");
  } })).rejects.toThrow("profile changed");
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await readModelUsage(profile.id)).records[0].status).toBe("failed");
});
it("invalidates pre-JEV assessments", () => {
  const { profile, job } = fixture();
  const previous = `${job.id}:${hashJson({ policyVersion: 5, profileUpdatedAt: profile.updatedAt, title: job.title, location: job.location, remote: job.remote, deadline: job.deadline, description: job.description, requirements: job.requirements, active: job.active, importStatus: job.importCheck?.status, lastCheckedAt: job.lastCheckedAt })}`;
  expect(matchKey(profile, job)).not.toBe(previous);
});
