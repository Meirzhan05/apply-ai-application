import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { assessMatch, assessMatchWithOpenAI } from "../src/lib/matching";
import { randomUUID } from "node:crypto";
import { readModelUsage, withModelUsageContext } from "../src/lib/model-usage";
import type { Job, Profile, MatchAssessment } from "../src/lib/types";

const Example = z.object({
  profile: z.record(z.string(), z.unknown()),
  job: z.record(z.string(), z.unknown()),
  label: z.enum(["strong", "possible", "uncertain"]),
});
async function main() {
// Exported profiles have anonymous IDs. Keep evaluation usage local and never mutate production owner state.
Object.assign(process.env, { NODE_ENV: "test", MODEL_USAGE_TEST_DIR: ".data" });
await mkdir(".data", { recursive: true });
const inputPath = process.argv[2];
if (!inputPath)
  throw new Error("Usage: npm run eval:jev -- labeled-pairs.json");
if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY)
  throw new Error("Configure OPENAI_API_KEY and TYPESAFE_API_KEY for the comparison.");
const examples = z
  .array(Example)
  .min(10)
  .max(100)
  .parse(JSON.parse(await readFile(inputPath, "utf8")));
const results: {
  index: number;
  label: "strong" | "possible" | "uncertain";
  baseline: string;
  baselineModel: string;
  baselineLatencyMs: number;
  jev: MatchAssessment & { latencyMs: number; inputTokens?: number; outputTokens?: number };
}[] = [];
for (const [index, example] of examples.entries()) {
  const profile = example.profile as unknown as Profile;
  const job = example.job as unknown as Job;
  const [{ baseline, baselineLatencyMs }, jev] = await Promise.all([
    (async () => {
      const started = performance.now();
      const baseline = await assessMatchWithOpenAI(profile, job);
      return { baseline, baselineLatencyMs: Math.round(performance.now() - started) };
    })(),
    (async () => {
      const started = performance.now(), runId = randomUUID();
      const assessment = await withModelUsageContext({ userId: profile.id, jobId: job.id, runId }, () => assessMatch(profile, job));
      const usage = (await readModelUsage(profile.id)).records.find(record => record.runId === runId);
      return { ...assessment, latencyMs: Math.round(performance.now() - started), inputTokens: usage?.tokens.input ?? undefined, outputTokens: usage?.tokens.output ?? undefined };
    })(),
  ]);
  results.push({
    index,
    label: example.label,
    baseline: baseline.category,
    baselineModel: baseline.model,
    baselineLatencyMs,
    jev,
  });
  process.stdout.write(`\rEvaluated ${index + 1}/${examples.length}`);
}
process.stdout.write("\n");
const accuracy = (key: "baseline" | "jev") =>
  results.filter(
    (row) =>
      (key === "baseline" ? row.baseline : row.jev.category) === row.label,
  ).length / results.length;
const mean = (values: number[]) =>
  Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
const summary = {
  count: results.length,
  baselineAccuracy: accuracy("baseline"),
  baselineFallbackCount: results.filter((row) => row.baselineModel === "rules").length,
  jevAccuracy: accuracy("jev"),
  jevFallbackCount: results.filter(row => !row.jev.model.startsWith("jev")).length,
  baselineMeanLatencyMs: mean(results.map((row) => row.baselineLatencyMs)),
  jevMeanLatencyMs: mean(results.map((row) => row.jev.latencyMs)),
  jevInputTokens: results.reduce(
    (sum, row) => sum + (row.jev.inputTokens ?? 0),
    0,
  ),
  jevOutputTokens: results.reduce(
    (sum, row) => sum + (row.jev.outputTokens ?? 0),
    0,
  ),
  productionMatcher: "jev",
  note: "Offline comparison against the preserved OpenAI baseline. Human labels are required; this run never starts applications.",
};
const path = inputPath.replace(/\.json$/i, "") + ".results.json";
await writeFile(path, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));

}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
