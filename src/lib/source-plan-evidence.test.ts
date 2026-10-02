import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parseDocxSource } from "@/lib/docx-source";
import { validateSourcePlanEvidence } from "@/lib/source-plan-evidence";

it("rejects a DOCX claim that cites a confirmed fact anchored to a different experience entry", async () => {
  const source = await parseDocxSource(await createDocxSourceFixture({ secondExperience: true }));
  const anchors = source.anchors.filter((anchor) => anchor.candidateClaim);
  const profile = initialDemoState().profile;
  profile.facts = anchors.map((anchor, index) => ({ id: `fact-${index}`, text: anchor.text, verified: true, source: "resume", sourceAnchorId: anchor.id }));
  const claims = anchors.map((anchor) => ({ anchorId: anchor.id, text: anchor.text, factIds: [profile.facts.find((fact) => fact.sourceAnchorId === anchor.id)!.id] }));
  const claimsWithGrounding = () => ({
    source, profile, claims, edits: [], evidencePolicyVersion: 2 as const,
    grounding: { version: 1 as const, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: claims.map((claim) => ({
      claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed source fact.", evidenceFactIds: claim.factIds,
    })) },
  });

  expect(new Set(anchors.map((anchor) => anchor.entryId)).size).toBeGreaterThan(1);
  expect(validateSourcePlanEvidence(claimsWithGrounding())).toBe(true);

  const firstEntry = anchors.find((anchor) => anchor.kind === "bullet")!;
  const secondEntry = anchors.find((anchor) => anchor.kind === "bullet" && anchor.entryId !== firstEntry.entryId)!;
  const firstClaim = claims.find((claim) => claim.anchorId === firstEntry.id)!;
  firstClaim.factIds.push(profile.facts.find((fact) => fact.sourceAnchorId === secondEntry.id)!.id);
  const invalid = claimsWithGrounding();
  invalid.grounding.findings.find((finding) => finding.claimId === firstClaim.anchorId)!.evidenceFactIds.push(firstClaim.factIds[1]);

  expect(validateSourcePlanEvidence(invalid)).toBe(false);
});
