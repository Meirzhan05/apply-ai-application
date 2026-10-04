import assert from "node:assert/strict";
import { runs, tasks } from "@trigger.dev/sdk";
import type { verifyResumeFeedback } from "../trigger/resume-feedback";

async function main() {
  assert.ok(process.env.TRIGGER_SECRET_KEY?.startsWith("tr_prod_"), "Set TRIGGER_SECRET_KEY to a production key before running this production smoke check.");
  const handle = await tasks.trigger<typeof verifyResumeFeedback>("verify-resume-feedback", {});
  const result = await runs.poll<typeof verifyResumeFeedback>(handle.id, { pollIntervalMs: 2000 });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.output?.cases, ["docx", "pdf"].map((format) => ({ format, structuralRepair: true, checkerRetry: true,
    writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1, evidencePolicyVersion: 3, sourcePreserved: true })));
  console.log(JSON.stringify({ check: "production résumé feedback controller", status: result.status, version: result.version, ...result.output }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
