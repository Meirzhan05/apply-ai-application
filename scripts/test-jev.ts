import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initialDemoState } from "../src/lib/demo-data";
import { assessMatch } from "../src/lib/matching";
import { readModelUsage } from "../src/lib/model-usage";

async function main() {
  // Synthetic profiles only; local usage storage, no employer applications or production owner changes.
  process.env.DEMO_MODE = "true";
  assert.ok(process.env.TYPESAFE_API_KEY, "Configure TYPESAFE_API_KEY for the live provider test.");
  const state = initialDemoState();
  const profile = { ...state.profile, id: randomUUID(), workAuthorization: "Authorized to work in the US",
    facts: [...state.profile.facts, { id: "education", text: "Completing a bachelor's degree in computer science in 2026.", verified: true, source: "user" as const }] };
  const base = { ...state.jobs[0], description: "An entry-level analyst position for a graduating student. Use Python and SQL to analyze datasets. No prior professional employment is required.", requirements: ["Python", "SQL"] };
  const cases = [
    { name: "supported-entry-level", job: base, profile, expected: "strong" },
    { name: "unrelated-occupation", job: { ...base, id: "nursing", title: "Registered Nurse", description: "Licensed registered nurse providing bedside clinical care. A current RN license is required.", requirements: ["Current RN license", "Clinical nursing experience"] }, profile, expected: "uncertain" },
    { name: "senior-experience-gap", job: { ...base, id: "senior", title: "Senior Data Engineer", description: "Requires at least eight years of professional data engineering employment and experience managing teams.", requirements: ["Eight years of professional data engineering employment", "Engineering team management"] }, profile, expected: "uncertain" },
    { name: "unconfirmed-authorization", job: base, profile: { ...profile, workAuthorization: "Unspecified" }, expected: "uncertain" },
  ];
  const results = [];
  for (const item of cases) {
    const started = Date.now();
    const result = await assessMatch(item.profile, item.job);
    results.push({ name: item.name, expected: item.expected, category: result.category, model: result.model, confidence: result.confidence,
      latencyMs: Date.now() - started, evidenceCount: result.evidence.length, gaps: result.gaps, uncertainty: result.uncertainty });
    assert.ok(result.model.startsWith("jev"), "The test must exercise JEV, not a rules fallback.");
  }
  const usage = await readModelUsage(profile.id);
  console.log(JSON.stringify({ synthetic: true, results, estimatedUsd: usage.estimatedUsd, providerCalls: usage.measuredCalls }, null, 2));
  for (const result of results) assert.equal(result.category, result.expected, result.name);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
