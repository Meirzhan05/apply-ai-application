import { z } from "zod";
import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { draftResumeSourcePlan, type ResumeSourceResponses } from "@/lib/resume-source-draft";
import { validateSourcePlanEvidence } from "@/lib/source-plan-evidence";

const Request = z.object({ input: z.array(z.object({ content: z.string() })), text: z.object({ format: z.object({ name: z.string() }) }) });
const AuditInput = z.object({ claims: z.array(z.object({ claimId: z.string(), factIds: z.array(z.string()) })), sourceActivityPreservationChecks: z.array(z.object({ sourceClaimId: z.string() })) });

/** Generated sources and scripted model responses exercise the deployed controller.
 * No paid calls, saved profiles, usage writes, browser sessions, or submissions. */
export async function probeResumeFeedback() {
  const results = [];
  for (const format of ["docx", "pdf"] as const) {
    const state = initialDemoState();
    const bytes = format === "docx" ? await createDocxSourceFixture() : await createPdfSourceFixture();
    const source = format === "docx" ? await parseDocxSource(bytes, state.profile.name) : await parsePdfSource(bytes, state.profile.name);
    state.profile.resumeSource = { sha256: source.sourceHash, size: bytes.length, mimeType: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    state.profile.facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({ id: `probe-fact-${index}`, text: anchor.text, source: "resume", sourceAnchorId: anchor.id, verified: true }));
    const bullet = source.anchors.find((anchor) => anchor.kind === "bullet" && anchor.editable)!;
    const fact = state.profile.facts.find((candidate) => candidate.sourceAnchorId === bullet.id)!;
    let writers = 0;
    let checkers = 0;
    let receivedFeedback = false;
    const responses: ResumeSourceResponses = {
      async parse(request) {
        const parsed = Request.parse(request);
        if (parsed.text.format.name === "anchored_resume_edit_plan") {
          writers++;
          if (writers === 1) return { output_parsed: { edits: [{ anchorId: "invalid-probe-anchor", text: bullet.text, factIds: [fact.id] }] } };
          const body = JSON.parse(parsed.input[1].content);
          receivedFeedback = body.feedback.some((issue: { code: string }) => issue.code === "unknown_anchor");
          return { output_parsed: { edits: [] } };
        }
        checkers++;
        if (checkers === 1) return { output_parsed: { findings: [] } };
        const body = AuditInput.parse(JSON.parse(parsed.input[1].content));
        return { output_parsed: {
          findings: body.claims.map((claim) => ({ claimId: claim.claimId, outcome: "supported", evidenceFactIds: claim.factIds, reason: "The generated source fact supports this statement.", requiredInformation: null })),
          sourceActivityPreservations: body.sourceActivityPreservationChecks.map((check) => ({ sourceClaimId: check.sourceClaimId, outcome: "preserved", preservedClaimId: check.sourceClaimId, reason: "The original activity was retained.", requiredInformation: null })),
        } };
      },
    };
    const plan = await draftResumeSourcePlan(state.profile, state.jobs[0], source, Date.now() + 60_000, undefined, undefined, undefined,
      { responses, meter: async (_context, _operation, _model, call) => call() });
    if (!receivedFeedback || plan.grounding.writerAttempts !== 2 || plan.grounding.checkerAttempts !== 2 || plan.grounding.repairAttempts !== 1 || plan.grounding.checkerRetries !== 1 ||
      !validateSourcePlanEvidence({ source, profile: state.profile, ...plan }) || plan.claims.some((claim) => claim.text !== source.anchors.find((anchor) => anchor.id === claim.anchorId)?.text))
      throw new Error(`${format}: feedback recovery or complete source preservation failed.`);
    results.push({ format, structuralRepair: true, checkerRetry: true, writerAttempts: writers, checkerAttempts: checkers, repairAttempts: plan.grounding.repairAttempts, evidencePolicyVersion: plan.evidencePolicyVersion, sourcePreserved: true });
  }
  return results;
}
