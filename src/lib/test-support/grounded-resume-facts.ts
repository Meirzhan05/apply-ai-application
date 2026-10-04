import { sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";
import type { ResumeSourceDocument, VerifiedFact } from "@/lib/types";

/** Deterministic model adapter for application-flow fixtures; extractor behavior has its own tests. */
export function groundedResumeFacts(source: ResumeSourceDocument, trustedName?: string): VerifiedFact[] {
  return sourceWithCurrentEvidenceClaims(source, trustedName).anchors.filter(anchor => anchor.candidateClaim).map((anchor, index) => {
    const text = [anchor.sectionHeading, anchor.entryHeading, anchor.text].join(" · ");
    return { id: `extracted-${index}`, text, source: "resume", verified: false, status: "accepted", sourceAnchorId: anchor.id,
      grounding: { version: 1, sourceHash: source.sourceHash, model: "fixture", acceptedText: text, evidence: [{ anchorId: anchor.id, quote: anchor.text }] } };
  });
}
