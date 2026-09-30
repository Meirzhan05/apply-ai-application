import assert from "node:assert/strict";
import { tasks, runs } from "@trigger.dev/sdk";
import type { verifyLatexRuntime } from "../trigger/latex";

async function main() {
  const handle = await tasks.trigger<typeof verifyLatexRuntime>("verify-latex-runtime", {});
  const result = await runs.poll<typeof verifyLatexRuntime>(handle.id, { pollIntervalMs: 2000 });
  assert.equal(result.status, "COMPLETED", `Runtime smoke test ended with ${result.status}`);
  assert.equal(result.output?.compiler, "tectonic-0.17.0");
  assert.equal(result.output?.pages, 1);
  assert.ok((result.output?.bytes ?? 0) > 1000);
  console.log(JSON.stringify({ check: "production LaTeX runtime", status: result.status, version: result.version, ...result.output }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
