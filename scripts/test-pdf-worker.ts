import assert from "node:assert/strict";
import { runs, tasks } from "@trigger.dev/sdk";
import type { verifyPdfRuntime } from "../trigger/pdf";

async function main() {
  const handle = await tasks.trigger<typeof verifyPdfRuntime>("verify-pdf-runtime", {});
  const result = await runs.poll<typeof verifyPdfRuntime>(handle.id, { pollIntervalMs: 2000 });
  assert.equal(result.status, "COMPLETED", `PDF runtime smoke ended with ${result.status}`);
  assert.equal(result.output?.renderer, "apache-pdfbox");
  assert.equal(result.output?.pdfboxVersion, "3.0.8");
  assert.match(result.output?.javaVersion ?? "", /^21\./);
  assert.equal(result.output?.architecture, "linux-x64");
  assert.equal(result.output?.pages, 1);
  assert.equal(result.output?.pageWidthPt, 612);
  assert.equal(result.output?.pageHeightPt, 792);
  assert.equal(result.output?.outsideEditPixelsAt144Dpi, 0);
  assert.equal(result.output?.outsideEditPixelsAt300Dpi, 0);
  assert.deepEqual(result.output?.smokeCases?.map((item) => item.name), ["legacy-tj", "positioned-tj-with-divider"]);
  assert.ok(result.output?.smokeCases?.every((item) => item.wordingChanged && item.outsideEditPixelsAt144Dpi === 0 && item.outsideEditPixelsAt300Dpi === 0));
  assert.deepEqual(result.output?.groundingSmoke, { labelsExcluded: 4, separatorAnchorsExcluded: true, contextualFactReused: true,
    pendingFactsBeforeConfirmation: 1, completionAfterExplicitConfirmation: true });
  assert.ok((result.output?.pdfboxJarSha512 ?? "").match(/^[a-f0-9]{128}$/));
  assert.ok((result.output?.outputBytes ?? 0) > 0);
  console.log(JSON.stringify({ check: "production PDFBox/Temurin rendering and fidelity", status: result.status, version: result.version, ...result.output }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
