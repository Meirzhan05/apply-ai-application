import type { Profile, ResumeSourceAnchor, ResumeSourceDocument, ResumeSourceEdit, ResumeSourcePlan, ResumeGroundingSnapshot, ResumeSourceClaim, ResumeRepairIssue } from "@/lib/types";
import { canonicalPdfSourceFactText, evidenceRequiredAnchorIds } from "@/lib/resume-source-semantics";

const normalized = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
const normalizedContextComponent = (value: string) => value.normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function sourceEvidenceAnchors(source: ResumeSourceDocument, policyVersion: 1 | 2 | 3 = 1, trustedName?: string): ResumeSourceAnchor[] {
  const required = policyVersion >= 2 ? evidenceRequiredAnchorIds(source, trustedName, policyVersion as 2 | 3) : undefined;
  return source.anchors.filter((anchor) => policyVersion >= 2 ? required!.has(anchor.id) : anchor.candidateClaim);
}

export function sourceWithCurrentEvidenceClaims<T extends ResumeSourceDocument>(source: T, trustedName?: string): T {
  const required = evidenceRequiredAnchorIds(source, trustedName);
  return { ...source, anchors: source.anchors.map((anchor) => ({ ...anchor, candidateClaim: required.has(anchor.id) })) } as T;
}

export function confirmedFactIdsForAnchor(profile: Profile, anchor: ResumeSourceAnchor, source?: ResumeSourceDocument): string[] {
  const sourceText = normalized(anchor.text);
  const directlyConfirmed = profile.facts.filter((fact) => fact.verified && (
    fact.sourceAnchorId === anchor.id || (!fact.sourceAnchorId && normalized(fact.text).includes(sourceText))
  )).map((fact) => fact.id);
  if (directlyConfirmed.length || source?.format !== "pdf" || anchor.kind !== "entry") return directlyConfirmed;

  const anchorsById = new Map(source.anchors.map((candidate) => [candidate.id, candidate]));
  const targetComponent = normalizedContextComponent(anchor.text);
  if (!targetComponent) return [];
  return profile.facts.filter((fact) => {
    if (!fact.verified || fact.source !== "resume" || !fact.sourceAnchorId) return false;
    const evidenceAnchor = anchorsById.get(fact.sourceAnchorId);
    if (!evidenceAnchor || evidenceAnchor.entryId !== anchor.entryId || fact.text !== canonicalPdfSourceFactText(evidenceAnchor)) return false;
    return evidenceAnchor.entryHeading.split(/[·|]/u).some((component) => normalizedContextComponent(component) === targetComponent);
  }).map((fact) => fact.id);
}

/** Suggestions that still need an explicit profile confirmation for this PDF. */
export function unconfirmedPdfFactSuggestions(profile: Profile, source: ResumeSourceDocument): Array<{ text: string; sourceAnchorId: string }> {
  if (source.format !== "pdf") return [];
  const current = sourceWithCurrentEvidenceClaims(source, profile.name);
  return current.anchors.filter((anchor) => anchor.candidateClaim && !confirmedFactIdsForAnchor(profile, anchor, current).length)
    .flatMap((anchor) => {
      const text = canonicalPdfSourceFactText(anchor);
      if (!text || text.length > 500 || profile.facts.some((fact) =>
        fact.sourceAnchorId === anchor.id || (!fact.sourceAnchorId && normalized(fact.text) === normalized(text)))) return [];
      return [{ text, sourceAnchorId: anchor.id }];
    });
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
  const verified = new Map(input.profile.facts.filter((fact) => fact.verified).map((fact) => [fact.id, fact]));
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

interface SourcePlanEvidenceInput {
  source: ResumeSourceDocument;
  profile: Profile;
  claims: ResumeSourceClaim[];
  edits: ResumeSourceEdit[];
  grounding?: ResumeGroundingSnapshot;
  evidencePolicyVersion?: 1 | 2 | 3;
}

/** Detailed feedback for new candidates; saved plans use the same acceptance rules. */
export function sourcePlanEvidenceIssues(input: SourcePlanEvidenceInput): ResumeRepairIssue[] {
  let anchors = sourceEvidenceAnchors(input.source, input.evidencePolicyVersion ?? 1, input.profile.name);
  // Policy 2 was deployed with both selections before artifact exclusions were
  // versioned. Accept either complete historical manifest, never arbitrary subsets.
  if (input.evidencePolicyVersion === 2) {
    const currentAnchors = sourceEvidenceAnchors(input.source, 3, input.profile.name);
    if (input.claims.length === currentAnchors.length && currentAnchors.every((anchor) => input.claims.some((claim) => claim.anchorId === anchor.id))) anchors = currentAnchors;
  }
  const issues: ResumeRepairIssue[] = [];
  const add = (code: string, message: string, anchorId?: string) => issues.push({ stage: "structure", code, message, ...(anchorId ? { anchorId } : {}) });
  const verified = new Map(input.profile.facts.filter((fact) => fact.verified).map((fact) => [fact.id, fact]));
  const allAnchors = new Map(input.source.anchors.map((anchor) => [anchor.id, anchor]));
  const anchorById = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const seen = new Set<string>();
  if (input.claims.length !== anchors.length) add("claim_count", "Include exactly one claim for every required source statement.");
  for (const anchor of anchors) if (!input.claims.some((claim) => claim.anchorId === anchor.id)) add("missing_claim", "Restore the original statement and its confirmed evidence.", anchor.id);
  for (const claim of input.claims) {
    const anchor = anchorById.get(claim.anchorId);
    if (!anchor) { add("unknown_anchor", "Use an existing required source statement ID.", claim.anchorId); continue; }
    if (seen.has(anchor.id)) add("duplicate_claim", "Return this statement only once.", anchor.id);
    seen.add(anchor.id);
    if (!claim.factIds.length || new Set(claim.factIds).size !== claim.factIds.length || claim.factIds.some((id) => !verified.has(id)))
      add("invalid_evidence", "Cite distinct, existing confirmed fact IDs for this source statement.", anchor.id);
    if (!confirmedFactIdsForAnchor(input.profile, anchor, input.source).some((id) => claim.factIds.includes(id)))
      add("missing_source_evidence", "Include confirmed evidence associated with this original statement.", anchor.id);
    if (anchor.kind !== "bullet" && claim.text !== anchor.text) add("protected_text", "Copy this protected source text exactly; only editable bullets may change.", anchor.id);
    if (claim.text !== anchor.text && !anchor.editable) add("uneditable_anchor", "Restore the original text; this source statement cannot be edited.", anchor.id);
    for (const id of claim.factIds) {
      const fact = verified.get(id);
      if (!fact?.sourceAnchorId) continue;
      const evidenceAnchor = allAnchors.get(fact.sourceAnchorId);
      if (!evidenceAnchor || evidenceAnchor.entryId !== anchor.entryId)
        add("different_entry", "Use confirmed facts from this same résumé entry; restore the original supported wording if necessary.", anchor.id);
    }
  }
  const editById = new Map<string, ResumeSourceEdit>();
  for (const edit of input.edits) {
    if (editById.has(edit.anchorId)) add("duplicate_edit", "Return only one edit for this bullet.", edit.anchorId);
    editById.set(edit.anchorId, edit);
    const claim = input.claims.find((candidate) => candidate.anchorId === edit.anchorId);
    if (!claim || claim.text !== edit.text || JSON.stringify([...claim.factIds].sort()) !== JSON.stringify([...edit.factIds].sort()) || claim.text === anchorById.get(edit.anchorId)?.text)
      add("edit_mismatch", "The edit must exactly match its changed source claim and evidence.", edit.anchorId);
  }
  for (const claim of input.claims) if (anchorById.has(claim.anchorId) && claim.text !== anchorById.get(claim.anchorId)!.text && !editById.has(claim.anchorId))
    add("missing_edit", "Include the corresponding edit for this changed bullet.", claim.anchorId);
  const grounding = input.grounding;
  const maxCheckerAttempts = input.evidencePolicyVersion === 3 ? 4 : 3;
  if (grounding && (grounding.findings.length !== input.claims.length || grounding.findings.some((finding) => finding.outcome !== "supported") ||
    !Number.isInteger(grounding.writerAttempts) || grounding.writerAttempts < 1 || grounding.writerAttempts > 3 ||
    !Number.isInteger(grounding.checkerAttempts) || grounding.checkerAttempts < 1 || grounding.checkerAttempts > maxCheckerAttempts ||
    !Number.isInteger(grounding.repairAttempts) || grounding.repairAttempts < 0 || grounding.repairAttempts > 2))
    add("invalid_audit", "The saved grounding report is incomplete or outside the permitted attempt budget.");
  if (grounding) {
    const checked = new Set<string>();
    for (const finding of grounding.findings) {
      const claim = input.claims.find((candidate) => candidate.anchorId === finding.claimId);
      if (!claim || checked.has(finding.claimId) || !finding.evidenceFactIds.length || new Set(finding.evidenceFactIds).size !== finding.evidenceFactIds.length ||
        finding.evidenceFactIds.some((id) => !verified.has(id) || !claim.factIds.includes(id))) add("invalid_audit_evidence", "The grounding check must cite valid confirmed evidence for every statement.", finding.claimId);
      checked.add(finding.claimId);
    }
  }
  return issues;
}

export function validateSourcePlanEvidence(input: SourcePlanEvidenceInput): boolean {
  if ((input.evidencePolicyVersion ?? 1) === 1) return validateLegacySourcePlan(input);
  return sourcePlanEvidenceIssues(input).length === 0;
}

export function planEvidencePolicy(plan: ResumeSourcePlan): 1 | 2 | 3 {
  return plan.evidencePolicyVersion ?? 1;
}
