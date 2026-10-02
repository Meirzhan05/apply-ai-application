import type { Profile, ResumeSourceAnchor, ResumeSourceDocument, ResumeSourceEdit, ResumeSourcePlan, ResumeGroundingSnapshot, ResumeSourceClaim } from "@/lib/types";
import { requiresSourceEvidence } from "@/lib/resume-source-semantics";

const normalized = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function sourceEvidenceAnchors(source: ResumeSourceDocument, policyVersion: 1 | 2 = 1): ResumeSourceAnchor[] {
  return source.anchors.filter((anchor) => policyVersion === 2 ? requiresSourceEvidence(anchor) : anchor.candidateClaim);
}

export function sourceWithCurrentEvidenceClaims<T extends ResumeSourceDocument>(source: T): T {
  return { ...source, anchors: source.anchors.map((anchor) => ({ ...anchor, candidateClaim: requiresSourceEvidence(anchor) })) } as T;
}

export function confirmedFactIdsForAnchor(profile: Profile, anchor: ResumeSourceAnchor): string[] {
  const sourceText = normalized(anchor.text);
  return profile.facts.filter((fact) => fact.verified && (
    fact.sourceAnchorId === anchor.id || (!fact.sourceAnchorId && normalized(fact.text).includes(sourceText))
  )).map((fact) => fact.id);
}

export function validateSourcePlanEvidence(input: {
  source: ResumeSourceDocument;
  profile: Profile;
  claims: ResumeSourceClaim[];
  edits: ResumeSourceEdit[];
  grounding?: ResumeGroundingSnapshot;
  evidencePolicyVersion?: 1 | 2;
}): boolean {
  const anchors = sourceEvidenceAnchors(input.source, input.evidencePolicyVersion ?? 1);
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const verified = new Map(input.profile.facts.filter((fact) => fact.verified).map((fact) => [fact.id, fact]));
  const claimById = new Map<string, ResumeSourceClaim>();
  const editById = new Map<string, ResumeSourceEdit>();
  if (input.claims.length !== anchors.length || input.claims.some((claim) => {
    const anchor = anchorById.get(claim.anchorId);
    if (!anchor || claimById.has(anchor.id) || !claim.factIds.length || new Set(claim.factIds).size !== claim.factIds.length || claim.factIds.some((id) => !verified.has(id))) return true;
    const eligibleFactIds = confirmedFactIdsForAnchor(input.profile, anchor);
    if (!eligibleFactIds.some((id) => claim.factIds.includes(id))) return true;
    if (anchor.kind !== "bullet" && claim.text !== anchor.text) return true;
    if (claim.text !== anchor.text) {
      const edit = editById.get(anchor.id) ?? input.edits.find((candidate) => candidate.anchorId === anchor.id);
      if (!anchor.editable || !edit || edit.text !== claim.text || JSON.stringify([...edit.factIds].sort()) !== JSON.stringify([...claim.factIds].sort())) return true;
    } else if (input.edits.some((edit) => edit.anchorId === anchor.id)) return true;
    for (const id of claim.factIds) {
      const fact = verified.get(id)!;
      if (!fact.sourceAnchorId) continue;
      const evidenceAnchor = input.source.anchors.find((candidate) => candidate.id === fact.sourceAnchorId);
      if (!evidenceAnchor || evidenceAnchor.entryId !== anchor.entryId) return true;
    }
    claimById.set(anchor.id, claim);
    return false;
  })) return false;
  for (const edit of input.edits) {
    if (editById.has(edit.anchorId) || !claimById.has(edit.anchorId)) return false;
    editById.set(edit.anchorId, edit);
  }
  if (input.edits.length !== [...new Set(input.edits.map((edit) => edit.anchorId))].length || input.edits.some((edit) => {
    const claim = claimById.get(edit.anchorId)!;
    return claim.text === anchorById.get(edit.anchorId)!.text || claim.text !== edit.text || JSON.stringify([...claim.factIds].sort()) !== JSON.stringify([...edit.factIds].sort());
  })) return false;
  const grounding = input.grounding;
  if (!grounding) return true;
  if (!Number.isInteger(grounding.writerAttempts) || grounding.writerAttempts < 1 || grounding.writerAttempts > 3 ||
    !Number.isInteger(grounding.checkerAttempts) || grounding.checkerAttempts < 1 || grounding.checkerAttempts > 3 ||
    !Number.isInteger(grounding.repairAttempts) || grounding.repairAttempts < 0 || grounding.repairAttempts > 2 || grounding.findings.length !== claimById.size) return false;
  const findingIds = new Set<string>();
  for (const finding of grounding.findings) {
    const claim = claimById.get(finding.claimId);
    if (!claim || findingIds.has(finding.claimId) || finding.outcome !== "supported" || !finding.evidenceFactIds.length ||
      new Set(finding.evidenceFactIds).size !== finding.evidenceFactIds.length || finding.evidenceFactIds.some((id) => !verified.has(id) || !claim.factIds.includes(id))) return false;
    findingIds.add(finding.claimId);
  }
  return findingIds.size === claimById.size;
}

export function planEvidencePolicy(plan: ResumeSourcePlan): 1 | 2 {
  return plan.evidencePolicyVersion === 2 ? 2 : 1;
}
