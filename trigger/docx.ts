import { task } from "@trigger.dev/sdk";
import { parseDocxSource } from "../src/lib/docx-source";
import { createDocxSourceFixture } from "../src/lib/fixtures/docx-source";
import { bytesHash } from "../src/lib/resume-artifacts";
import { renderDocxSourceBytes } from "../src/lib/docx-renderer";
import type { ResumeSourcePlan } from "../src/lib/types";

export const verifyDocxRuntime = task({
  id: "verify-docx-runtime",
  machine: "medium-1x",
  maxDuration: 180,
  retry: { maxAttempts: 1 },
  run: async () => {
    const original = await createDocxSourceFixture();
    const source = await parseDocxSource(original);
    if (source.support.status !== "candidate") throw new Error(source.support.reason ?? "The synthetic DOCX fixture is unsupported.");
    const claims = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({ anchorId: anchor.id, text: anchor.text, factIds: [`smoke-fact-${index}`] }));
    const target = source.anchors.find((anchor) => anchor.kind === "bullet");
    if (!target) throw new Error("The synthetic DOCX has no editable bullet.");
    const edit = claims.find((claim) => claim.anchorId === target.id);
    if (!edit) throw new Error("The synthetic DOCX bullet is not a candidate claim.");
    edit.text = "Built an explainable recommender with 92% precision.";
    const plan: ResumeSourcePlan = { version: 1, format: "docx", sourceHash: source.sourceHash, representationVersion: source.version,
      profileHash: "0".repeat(64), factsHash: "1".repeat(64), settingsHash: "2".repeat(64), jobHash: "3".repeat(64), claims,
      edits: [{ anchorId: target.id, text: edit.text, factIds: edit.factIds }],
      grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: claims.map((claim) => ({ claimId: claim.anchorId,
        affectedText: claim.text, outcome: "supported", reason: "Synthetic confirmed smoke fact.", evidenceFactIds: claim.factIds })) }, model: "synthetic-smoke" };
    const rendered = await renderDocxSourceBytes(original, source, plan, Date.now() + 90_000);
    if (rendered.pageWidthPt !== 612 || rendered.pageHeightPt !== 792 || rendered.visualOutsideEditDifference > 0.001 || rendered.baselinePdfHash === bytesHash(rendered.pdf)) throw new Error("The DOCX runtime did not meet the pinned one-page fidelity smoke assertions.");
    if (!rendered.rendererVersion.startsWith("LibreOffice 26.8.0.3")) throw new Error("The installed LibreOffice patch version does not match the runtime lock.");
    return { renderer: rendered.renderer, rendererVersion: rendered.rendererVersion, originalSha256: bytesHash(original), editedDocxSha256: bytesHash(rendered.docx), pdfSha256: bytesHash(rendered.pdf),
      pages: 1, pageWidthPt: rendered.pageWidthPt, pageHeightPt: rendered.pageHeightPt, visualOutsideEditDifference: rendered.visualOutsideEditDifference };
  },
});
