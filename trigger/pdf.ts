import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { task } from "@trigger.dev/sdk";
import { createPdfSourceFixture } from "../src/lib/fixtures/pdf-source";
import { parsePdfSource } from "../src/lib/pdf-source";
import { renderPdfSourceBytes } from "../src/lib/pdf-renderer";
import { bytesHash } from "../src/lib/resume-artifacts";
import type { ResumeSourcePlan } from "../src/lib/types";

// Manual deployment smoke test: generated source only, no profiles, provider
// calls, storage writes, email, browser sessions, or employer submissions.
export const verifyPdfRuntime = task({
  id: "verify-pdf-runtime",
  machine: "medium-1x",
  maxDuration: 180,
  retry: { maxAttempts: 1 },
  run: async (payload: Record<string, never>) => {
    if (Object.keys(payload).length) throw new Error("The PDF runtime check accepts no input.");
    const cases = [
      { name: "legacy-tj", options: {} },
      { name: "positioned-tj-with-divider", options: { positionedWordSpacing: true, sectionDivider: true } },
    ] as const;
    const smokeCases = [];
    let primary: { original: Buffer; rendered: Awaited<ReturnType<typeof renderPdfSourceBytes>> } | undefined;
    for (const testCase of cases) {
      const original = await createPdfSourceFixture(testCase.options);
      const source = await parsePdfSource(original);
      if (source.support.status !== "candidate") throw new Error(`${testCase.name}: ${source.support.reason ?? "The synthetic PDF fixture is unsupported."}`);
      const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({ anchorId: anchor.id, text: anchor.text, factIds: [`synthetic-smoke-fact-${index}`] }));
      const target = source.anchors.find((anchor) => anchor.text === "Built a search index for 1,200 users.");
      if (!target) throw new Error(`${testCase.name}: the synthetic PDF has no editable bullet.`);
      const edit = claims.find((claim) => claim.anchorId === target.id);
      if (!edit) throw new Error(`${testCase.name}: the synthetic PDF bullet is not a candidate claim.`);
      edit.text = "Built search index for 1,200 users.";
      const plan: ResumeSourcePlan = { version: 1, format: "pdf", sourceHash: source.sourceHash, representationVersion: source.version,
        profileHash: "0".repeat(64), factsHash: "1".repeat(64), settingsHash: "2".repeat(64), jobHash: "3".repeat(64), claims,
        edits: [{ anchorId: target.id, text: edit.text, factIds: edit.factIds }],
        grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: claims.map((claim) => ({ claimId: claim.anchorId,
          affectedText: claim.text, outcome: "supported", reason: "Synthetic smoke fact.", evidenceFactIds: claim.factIds })) }, model: "synthetic-smoke" };
      const rendered = await renderPdfSourceBytes(original, source, plan, Date.now() + 90_000);
      const reparsed = await parsePdfSource(rendered.pdf);
      if (!reparsed.text.includes(edit.text) || reparsed.text.includes(target.text) || rendered.visualOutsideEditDifferenceAt144Dpi !== 0 || rendered.visualOutsideEditDifferenceAt300Dpi !== 0)
        throw new Error(`${testCase.name}: the PDF edit was not visible or changed pixels outside the edited text.`);
      smokeCases.push({ name: testCase.name, outsideEditPixelsAt144Dpi: rendered.visualOutsideEditDifferenceAt144Dpi,
        outsideEditPixelsAt300Dpi: rendered.visualOutsideEditDifferenceAt300Dpi, wordingChanged: true });
      primary ??= { original, rendered };
    }
    if (!primary) throw new Error("No PDF runtime smoke case ran.");
    const { original, rendered } = primary;
    const runtimeRoot = process.env.PDFBOX_RUNTIME_ROOT;
    if (!runtimeRoot) throw new Error("The deployed PDF runtime root is not configured.");
    const runtimeManifest = JSON.parse(await readFile(path.join(runtimeRoot, "runtime-manifest.json"), "utf8")) as { java: string; pdfbox: string; architecture: string };
    const jar = await readFile(path.join(runtimeRoot, "pdfbox-app-3.0.8.jar"));
    const jarSha512 = createHash("sha512").update(jar).digest("hex");
    if (runtimeManifest.java !== "21.0.12.1+1" || runtimeManifest.pdfbox !== "3.0.8" || runtimeManifest.architecture !== "linux-x64" ||
      rendered.javaVersion.split(".")[0] !== "21" || rendered.runtimeArchitecture !== "linux-x64" || rendered.rendererVersion !== "3.0.8" ||
      rendered.pageWidthPt !== 612 || rendered.pageHeightPt !== 792 || rendered.visualOutsideEditDifferenceAt144Dpi !== 0 ||
      rendered.visualOutsideEditDifferenceAt300Dpi !== 0 || jarSha512 !== "768847238f683568507bf73570a2b6fedcbe58b25c7b4f97fba536ba110b290fe96ba065aed58629d41fb94857d76bc1978c2f31d294b553c69f287f71ee9600")
      throw new Error("The deployed PDFBox/Temurin runtime failed its pinned version, checksum, page, or fidelity smoke assertions.");
    if (rendered.baselinePdfHash !== bytesHash(original) || bytesHash(rendered.pdf) === bytesHash(original)) throw new Error("The PDF smoke did not save a distinct source-preserving output.");
    return { renderer: rendered.renderer, pdfboxVersion: rendered.rendererVersion, javaVersion: rendered.javaVersion, architecture: rendered.runtimeArchitecture,
      pdfboxJarSha512: jarSha512, sourceBytes: original.length, outputBytes: rendered.pdf.length, pages: 1, pageWidthPt: rendered.pageWidthPt,
      pageHeightPt: rendered.pageHeightPt, outsideEditPixelsAt144Dpi: rendered.visualOutsideEditDifferenceAt144Dpi,
      outsideEditPixelsAt300Dpi: rendered.visualOutsideEditDifferenceAt300Dpi, smokeCases };
  },
});
