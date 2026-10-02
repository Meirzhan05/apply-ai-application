import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { draftResumeSourcePlan } from "@/lib/resume-source-draft";
import { pdfSourceLayout } from "@/lib/resume-source-layout";

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { parse: mocks.parse }; } }));

async function fixture() {
  const state = initialDemoState();
  state.profile.id = "docx-writer-owner";
  const bytes = await createDocxSourceFixture();
  const source = await parseDocxSource(bytes);
  state.profile.resumeSource = { sha256: source.sourceHash, size: bytes.length, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", storageKey: `${state.profile.id}/synthetic.docx` };
  state.profile.resumeSourceDocument = source;
  state.profile.facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({ id: `source-fact-${index}`, text: `${anchor.sectionHeading} · ${anchor.entryHeading} · ${anchor.text}`, source: "resume" as const, verified: true, sourceAnchorId: anchor.id }));
  return { profile: state.profile, job: state.jobs[0], source };
}

async function pdfFixture() {
  const state = initialDemoState();
  state.profile.id = "pdf-writer-owner";
  const bytes = await createPdfSourceFixture();
  const source = await parsePdfSource(bytes);
  state.profile.resumeSource = { sha256: source.sourceHash, size: bytes.length, mimeType: "application/pdf", storageKey: `${state.profile.id}/synthetic.pdf` };
  state.profile.resumeSourceDocument = source;
  state.profile.resumeFileName = "synthetic.pdf";
  state.profile.facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({ id: `source-fact-${index}`, text: `${anchor.sectionHeading} · ${anchor.entryHeading} · ${anchor.text}`, source: "resume" as const, verified: true, sourceAnchorId: anchor.id }));
  return { profile: state.profile, job: state.jobs[0], source, layout: pdfSourceLayout(source)! };
}

function sourcePlanResponse(request: { input: Array<{ content: string }> }, editText = "Built an explainable recommender with 92% precision.") {
  const body = JSON.parse(request.input[1].content);
  return { output_parsed: { claims: body.sourceDocument.anchors.filter((anchor: { candidateClaim: boolean }) => anchor.candidateClaim).map((anchor: { id: string; kind: string; text: string }, index: number) => ({
    anchorId: anchor.id, text: anchor.kind === "bullet" ? editText : anchor.text, factIds: [`source-fact-${index}`],
  })) } };
}
function auditResponse(request: { input: Array<{ content: string }> }, unsupported = false) {
  const body = JSON.parse(request.input[1].content);
  return { output_parsed: { findings: body.claims.map((claim: { claimId: string; affectedText: string; factIds: string[] }, index: number) => ({
    claimId: claim.claimId, outcome: unsupported && index === 1 ? "unsupported" : "supported", reason: unsupported && index === 1 ? "The confirmed fact does not establish team leadership." : "The confirmed source supports this wording.",
    evidenceFactIds: claim.factIds, requiredInformation: unsupported && index === 1 ? "Keep the original recommender result wording." : null,
  })), sourceActivityPreservations: (body.sourceActivityPreservationChecks ?? []).map((check: { sourceClaimId: string }) => ({ sourceClaimId: check.sourceClaimId,
    outcome: "preserved", preservedClaimId: check.sourceClaimId, reason: "The recommender work remains in the same source entry.", requiredInformation: null })) } };
}

beforeEach(() => { mocks.parse.mockReset(); vi.stubEnv("OPENAI_API_KEY", "synthetic"); });
afterEach(() => vi.unstubAllEnvs());

it("gives the writer full source context and saves an anchored, grounded edit plan", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));

  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000);
  const writerInput = JSON.parse(mocks.parse.mock.calls[0][0].input[1].content);

  expect(writerInput.sourceDocument.text).toBe(source.text);
  expect(writerInput.sourceDocument.anchors).toHaveLength(source.anchors.length);
  expect(writerInput.confirmedFacts.every((fact: { id: string }) => profile.facts.some((item) => item.id === fact.id && item.verified))).toBe(true);
  expect(plan.edits).toHaveLength(1);
  expect(plan.edits[0]).toMatchObject({ anchorId: source.anchors.find((anchor) => anchor.kind === "bullet")!.id, text: "Built an explainable recommender with 92% precision." });
  expect(plan.grounding).toMatchObject({ writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0 });
});

it("asks for confirmation of source claims before writing and never treats source text as evidence", async () => {
  const { profile, job, source } = await fixture();
  profile.facts[0].verified = false;

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000)).rejects.toMatchObject({ diagnostics: { outcome: "needs_information", writerAttempts: 0, checkerAttempts: 0, repairAttempts: 0 } });
  expect(mocks.parse).not.toHaveBeenCalled();
});

it("repairs a flagged bullet once, rechecks the complete anchored claim set, and keeps all original anchors", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never, "Led a team of 20 to build an explainable recommender."))
    .mockImplementationOnce(async (request) => auditResponse(request as never, true))
    .mockImplementationOnce(async (request) => {
      const body = JSON.parse(request.input[1].content);
      expect(body.findings).toHaveLength(source.anchors.filter((anchor) => anchor.candidateClaim).length);
      expect(body.currentDraft).toHaveLength(source.anchors.filter((anchor) => anchor.candidateClaim).length);
      return sourcePlanResponse(request as never, "Built an explainable recommender with 92% precision.");
    }).mockImplementationOnce(async (request) => auditResponse(request as never));

  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000);
  expect(mocks.parse).toHaveBeenCalledTimes(4);
  expect(plan.claims.map((claim) => claim.anchorId)).toEqual(source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => anchor.id));
  expect(plan.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 });
});

it("blocks a repair that substitutes a different activity even when it cites the same confirmed source fact", async () => {
  const { profile, job, source } = await fixture();
  const bulletId = source.anchors.find((anchor) => anchor.kind === "bullet")!.id;
  let auditCount = 0;
  mocks.parse.mockImplementation(async (request) => {
    if (request.text.format.name === "anchored_resume_edit_plan") {
      const editText = request.input[0].content.includes("This is a repair") ? "Automated an unrelated sales pipeline." : "Led a team of 20 to build a recommender.";
      return sourcePlanResponse(request as never, editText);
    }
    auditCount++;
    const response = auditResponse(request as never, auditCount === 1);
    if (auditCount === 2) return { output_parsed: { ...response.output_parsed, sourceActivityPreservations: [{ sourceClaimId: bulletId, outcome: "substituted", preservedClaimId: null,
      reason: "The repaired wording describes a different work activity.", requiredInformation: "Keep the original recommender-development activity or confirm a replacement." }] } };
    return response;
  });

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000)).rejects.toMatchObject({ diagnostics: {
    outcome: "needs_information", writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1,
    findings: [expect.objectContaining({ claimId: bulletId, outcome: "uncertain", requiredInformation: expect.stringContaining("original recommender-development activity") })],
  } });
  expect(mocks.parse).toHaveBeenCalledTimes(4);
  expect(JSON.parse(mocks.parse.mock.calls[2][0].input[1].content).sourceActivityPreservationChecks).toEqual([
    expect.objectContaining({ sourceClaimId: bulletId, originalClaimText: "Built a recommender with 92% precision." }),
  ]);
});

it("shortens a layout-rejected source bullet once, then reruns the full grounding audit", async () => {
  const { profile, job, source, layout } = await pdfFixture();
  const anchor = source.anchors.find((item) => item.kind === "bullet")!;
  const mapped = layout.anchors.find((item) => item.anchorId === anchor.id)!;
  const tooLong = "Built a search index for 1,200 users with improved retrieval and search APIs.";
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never, tooLong))
    .mockImplementationOnce(async (request) => auditResponse(request as never))
    .mockImplementationOnce(async (request) => {
      const body = JSON.parse(request.input[1].content);
      expect(body.layoutFeedback).toMatchObject({ anchorId: anchor.id, pageNumber: mapped.pageNumber, regionId: mapped.regionId });
      expect(body.findings).toBeUndefined();
      return { output_parsed: { claims: body.currentDraft.map((claim: { anchor: { id: string }; text: string; factIds: string[] }) => ({
        anchorId: claim.anchor.id, text: claim.anchor.id === anchor.id ? "Built search index for 1,200 users." : claim.text, factIds: claim.factIds,
      })) } };
    }).mockImplementationOnce(async (request) => auditResponse(request as never));

  let layoutCalls = 0;
  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, layout, async () => layoutCalls++ === 0 ? ({
    anchorId: anchor.id, pageNumber: mapped.pageNumber, regionId: mapped.regionId, reason: "Shorten wording to fit the original line.",
  }) : undefined);

  expect(plan.edits.find((edit) => edit.anchorId === anchor.id)?.text).toBe("Built search index for 1,200 users.");
  expect(plan.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 });
  expect(mocks.parse).toHaveBeenCalledTimes(4);
  expect(mocks.parse.mock.calls[2][0].input[0].content).toContain("layout fit repair");
});

it("blocks impossible layout repairs after the shared two-repair budget with no factual findings", async () => {
  const { profile, job, source, layout } = await pdfFixture();
  const anchor = source.anchors.find((item) => item.kind === "bullet")!;
  const tooLong = "Built a search index for 1,200 users with improved retrieval and search APIs.";
  const shorter = "Built search index for 1,200 users.";
  const shortest = "Built 1,200-user search index.";
  let writerCall = 0;
  mocks.parse.mockImplementation(async (request) => {
    if (request.text.format.name === "anchored_resume_edit_plan") {
      writerCall++;
      if (writerCall === 1) return sourcePlanResponse(request as never, tooLong);
      const body = JSON.parse(request.input[1].content);
      return { output_parsed: { claims: body.currentDraft.map((claim: { anchor: { id: string }; text: string; factIds: string[] }) => ({
        anchorId: claim.anchor.id, text: claim.anchor.id === anchor.id ? (writerCall === 2 ? shorter : shortest) : claim.text, factIds: claim.factIds,
      })) } };
    }
    return auditResponse(request as never);
  });

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, layout, async () => {
    const mapped = layout.anchors.find((item) => item.anchorId === anchor.id)!;
    return { anchorId: anchor.id, pageNumber: mapped.pageNumber, regionId: mapped.regionId, reason: "Still does not fit the original line." };
  })).rejects.toMatchObject({ diagnostics: { outcome: "technical_failure", technicalFailure: "renderer", writerAttempts: 3, checkerAttempts: 3, repairAttempts: 2, findings: [] } });
  expect(mocks.parse).toHaveBeenCalledTimes(6);
});
