import type { VerifiedFact, ResumeSourceAnchor } from "@/lib/types";

/** Legacy user confirmations and automatically grounded statements share one eligibility rule. */
export function isUsableFact(fact: VerifiedFact): boolean {
  if (fact.verified) return Boolean(fact.text.trim());
  return fact.status === "accepted" && fact.source === "resume" && fact.grounding?.version === 1 &&
    fact.grounding.acceptedText === fact.text && /^[a-f0-9]{64}$/.test(fact.grounding.sourceHash) &&
    Boolean(fact.sourceAnchorId && fact.grounding.evidence.some(item => item.anchorId === fact.sourceAnchorId && item.quote.trim()));
}

export function factAnchorIds(fact: VerifiedFact): string[] {
  return [...new Set([...(fact.sourceAnchorId ? [fact.sourceAnchorId] : []), ...(fact.grounding?.evidence.map(item => item.anchorId) ?? [])])];
}

/** Preserve the legacy hash shape while binding new plans to their complete evidence. */
export function factEvidenceSnapshot(facts: VerifiedFact[]) {
  return facts.filter(isUsableFact).map(({ id, text, source, sourceAnchorId, grounding }) => ({
    id, text, source, ...(sourceAnchorId ? { sourceAnchorId } : {}), ...(grounding ? { grounding } : {}),
  }));
}

/** Context headings can support categories without lending another employer's claims. */
export function evidenceBelongsToEntry(evidence: ResumeSourceAnchor, target: ResumeSourceAnchor): boolean {
  return evidence.entryId === target.entryId || (evidence.kind === "section" && evidence.sectionId === target.sectionId);
}
