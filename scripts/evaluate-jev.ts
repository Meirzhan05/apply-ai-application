import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { assessMatch } from "../src/lib/matching";
import { jevTriage } from "../src/lib/jev";
import type { Job, Profile } from "../src/lib/types";

const Example = z.object({
  profile: z.record(z.string(), z.unknown()),
  job: z.record(z.string(), z.unknown()),
  label: z.enum(["strong", "possible", "uncertain"]),
});
async function main() {
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
  jev: Awaited<ReturnType<typeof jevTriage>>;
}[] = [];
for (const [index, example] of examples.entries()) {
  const profile = example.profile as unknown as Profile;
  const job = example.job as unknown as Job;
  const [{ baseline, baselineLatencyMs }, jev] = await Promise.all([
    (async () => {
      const started = performance.now();
      const baseline = await assessMatch(profile, job);
      return { baseline, baselineLatencyMs: Math.round(performance.now() - started) };
    })(),
    jevTriage(profile, job),
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
  enableJev: false,
  note: "Shadow evaluation only. Compare service cost separately before enabling Jev for triage.",
};
const path = inputPath.replace(/\.json$/i, "") + ".results.json";
await writeFile(path, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));

}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
