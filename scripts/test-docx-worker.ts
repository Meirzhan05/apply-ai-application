import assert from "node:assert/strict";
import { runs, tasks } from "@trigger.dev/sdk";
import type { verifyDocxRuntime } from "../trigger/docx";

async function main() {
  const handle = await tasks.trigger<typeof verifyDocxRuntime>("verify-docx-runtime", undefined);
  const result = await runs.poll<typeof verifyDocxRuntime>(handle.id, { pollIntervalMs: 2000 });
  assert.equal(result.status, "COMPLETED", `DOCX runtime smoke ended with ${result.status}`);
  assert.equal(result.output?.renderer, "libreoffice-26.8.0.3");
  assert.match(result.output?.rendererVersion ?? "", /^LibreOffice 26\.8\.0\.3/);
  assert.equal(result.output?.pages, 1);
  assert.equal(result.output?.pageWidthPt, 612);
  assert.equal(result.output?.pageHeightPt, 792);
  assert.ok((result.output?.visualOutsideEditDifference ?? 1) <= 0.001);
  assert.ok((result.output?.editedDocxSha256 ?? "").match(/^[a-f0-9]{64}$/));
  assert.ok((result.output?.pdfSha256 ?? "").match(/^[a-f0-9]{64}$/));
  console.log(JSON.stringify({ check: "production DOCX rendering and fidelity", status: result.status, version: result.version, ...result.output }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
