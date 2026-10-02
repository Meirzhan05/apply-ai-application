import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { prepareDocxResumeBaseline, renderDocxSourceBytes } from "@/lib/docx-renderer";
import { parseDocxSource } from "@/lib/docx-source";
import { bytesHash } from "@/lib/resume-artifacts";
import { sourceEvidenceAnchors } from "@/lib/source-plan-evidence";
import type { ResumeSourcePlan } from "@/lib/types";

const fixtureName = "Riley Example";
const expectedRendererVersion = "LibreOffice 26.8.0.3";

export async function runDocxRuntimeProbe() {
  const deadline = Date.now() + 170_000;
  const original = await createDocxSourceFixture({ identityText: `${fixtureName} | riley@example.com` });
  const source = await parseDocxSource(original, fixtureName);
  if (source.support.status !== "candidate") {
    throw new Error(source.support.reason ?? "The synthetic DOCX fixture is unsupported.");
  }

  const preparedBaseline = await prepareDocxResumeBaseline(original, source, deadline, undefined, fixtureName);
  const evidenceAnchors = sourceEvidenceAnchors(source, 2, fixtureName);
  const claims = evidenceAnchors.map((anchor, index) => ({
    anchorId: anchor.id,
    text: anchor.text,
    factIds: [`smoke-fact-${index}`],
  }));
  const target = evidenceAnchors.find((anchor) => anchor.kind === "bullet" && anchor.editable);
  if (!target) throw new Error("The synthetic DOCX has no editable bullet under the current source evidence policy.");
  const edit = claims.find((claim) => claim.anchorId === target.id);
  if (!edit) throw new Error("The synthetic DOCX bullet is not a source-evidence claim.");
  edit.text = "Built recommender with 92% precision.";

  const plan: ResumeSourcePlan = {
    version: 1,
    evidencePolicyVersion: 2,
    jobHashPolicyVersion: 2,
    format: "docx",
    sourceHash: source.sourceHash,
    representationVersion: source.version,
    profileHash: "0".repeat(64),
    factsHash: "1".repeat(64),
    settingsHash: "2".repeat(64),
    jobHash: "3".repeat(64),
    sourceLayout: preparedBaseline.sourceLayout,
    layoutHash: preparedBaseline.layoutHash,
    claims,
    edits: [{ anchorId: target.id, text: edit.text, factIds: edit.factIds }],
    grounding: {
      version: 1,
      writerAttempts: 1,
      checkerAttempts: 1,
      repairAttempts: 0,
      findings: claims.map((claim) => ({
        claimId: claim.anchorId,
        affectedText: claim.text,
        outcome: "supported",
        reason: "Synthetic confirmed smoke fact.",
        evidenceFactIds: claim.factIds,
      })),
    },
    model: "synthetic-smoke",
  };

  const rendered = await renderDocxSourceBytes(original, source, plan, deadline, undefined, preparedBaseline, fixtureName);
  if (rendered.pageCount !== 1 || rendered.pageWidthPt !== 612 || rendered.pageHeightPt !== 792 ||
    rendered.visualOutsideEditDifference !== 0 || rendered.baselinePdfHash === bytesHash(rendered.pdf)) {
    throw new Error("The DOCX runtime did not meet the one-page, zero-outside-edit fidelity smoke assertions.");
  }
  if (!rendered.rendererVersion.startsWith(expectedRendererVersion)) {
    throw new Error("The installed LibreOffice patch version does not match the runtime lock.");
  }

  return {
    renderer: rendered.renderer,
    rendererVersion: rendered.rendererVersion,
    originalSha256: bytesHash(original),
    baselinePdfSha256: rendered.baselinePdfHash,
    editedDocxSha256: bytesHash(rendered.docx),
    pdfSha256: bytesHash(rendered.pdf),
    pageCount: rendered.pageCount,
    pageWidthPt: rendered.pageWidthPt,
    pageHeightPt: rendered.pageHeightPt,
    visualOutsideEditDifference: rendered.visualOutsideEditDifference,
  };
}
