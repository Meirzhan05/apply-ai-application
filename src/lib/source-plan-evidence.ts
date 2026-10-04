import { isUsableFact, factAnchorIds, evidenceBelongsToEntry } from "@/lib/fact-evidence";
import type { Profile, ResumeSourceAnchor, ResumeSourceDocument, ResumeSourceEdit, ResumeSourcePlan, ResumeGroundingSnapshot, ResumeSourceClaim } from "@/lib/types";
import { evidenceRequiredAnchorIds } from "@/lib/resume-source-semantics";

const normalized = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function sourceEvidenceAnchors(source: ResumeSourceDocument, policyVersion: 1 | 2 = 1, trustedName?: string): ResumeSourceAnchor[] {
  const required = policyVersion === 2 ? evidenceRequiredAnchorIds(source, trustedName) : undefined;
  return source.anchors.filter((anchor) => policyVersion === 2 ? required!.has(anchor.id) : anchor.candidateClaim);
}

export function sourceWithCurrentEvidenceClaims<T extends ResumeSourceDocument>(source: T, trustedName?: string): T {
  const required = evidenceRequiredAnchorIds(source, trustedName);
  return { ...source, anchors: source.anchors.map((anchor) => ({ ...anchor, candidateClaim: required.has(anchor.id) })) } as T;
}

export function confirmedFactIdsForAnchor(profile: Profile, anchor: ResumeSourceAnchor): string[] {
  const sourceText = normalized(anchor.text);
  return profile.facts.filter((fact) => isUsableFact(fact) && (
    (fact.grounding ? fact.grounding.evidence.some(item => item.anchorId === anchor.id && normalized(item.quote).includes(sourceText))
      : fact.sourceAnchorId === anchor.id || (!fact.sourceAnchorId && normalized(fact.text).includes(sourceText)))
  )).map((fact) => fact.id);
}

function validateLegacySourcePlan(input: {
  source: ResumeSourceDocument;
  profile: Profile;
  claims: ResumeSourceClaim[];
  edits: ResumeSourceEdit[];
  grounding?: ResumeGroundingSnapshot;
}): boolean {
  const anchors = sourceEvidenceAnchors(input.source, 1);
  const anchorById = new Map(input.source.anchors.map((anchor) => [anchor.id, anchor]));
  const verified = new Map(input.profile.facts.filter((fact) => isUsableFact(fact)).map((fact) => [fact.id, fact]));
  const claims = new Map(input.claims.map((claim) => [claim.anchorId, claim]));
  const edits = new Map(input.edits.map((edit) => [edit.anchorId, edit]));
  if (claims.size !== input.claims.length || edits.size !== input.edits.length || anchors.length !== input.claims.length ||
    anchors.some((anchor) => !claims.has(anchor.id)) || input.claims.some((claim) => {
      const anchor = anchorById.get(claim.anchorId);
      const edit = edits.get(claim.anchorId);
      return !anchor || !claim.factIds.length || claim.factIds.some((id) => !verified.has(id)) ||
        (input.source.format === "pdf" && claim.factIds.some((id) => {
          const sourceAnchorId = verified.get(id)!.sourceAnchorId;
          return Boolean(sourceAnchorId && anchorById.get(sourceAnchorId)?.entryId !== anchor.entryId);
        })) ||
        (anchor.kind !== "bullet" && claim.text !== anchor.text) ||
        (claim.text !== anchor.text && (!anchor.editable || !edit || edit.text !== claim.text || JSON.stringify(edit.factIds) !== JSON.stringify(claim.factIds))) ||
        (claim.text === anchor.text && edit !== undefined);
    }) || input.edits.some((edit) => !claims.has(edit.anchorId))) return false;
  const grounding = input.grounding;
  return !grounding || (grounding.findings.length === input.claims.length && grounding.findings.every((finding) => finding.outcome === "supported") &&
    grounding.writerAttempts >= 1 && grounding.writerAttempts <= 3 && grounding.checkerAttempts >= 1 && grounding.checkerAttempts <= 3 && grounding.repairAttempts <= 2);
}

export function validateSourcePlanEvidence(input: {
  source: ResumeSourceDocument;
  profile: Profile;
  claims: ResumeSourceClaim[];
  edits: ResumeSourceEdit[];
  grounding?: ResumeGroundingSnapshot;
  evidencePolicyVersion?: 1 | 2;
}): boolean {
  if ((input.evidencePolicyVersion ?? 1) === 1) return validateLegacySourcePlan(input);
  const anchors = sourceEvidenceAnchors(input.source, input.evidencePolicyVersion ?? 1, input.profile.name);
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const verified = new Map(input.profile.facts.filter((fact) => isUsableFact(fact)).map((fact) => [fact.id, fact]));
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
      if (fact.grounding && fact.grounding.sourceHash !== input.source.sourceHash) return true;
      for (const id of factAnchorIds(fact)) {
        const evidenceAnchor = input.source.anchors.find(candidate => candidate.id === id);
        if (!evidenceAnchor || !evidenceBelongsToEntry(evidenceAnchor, anchor)) return true;
      }
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
