import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { draftResumeSourcePlan } from "@/lib/resume-source-draft";
import { pdfSourceLayout } from "@/lib/resume-source-layout";
import { renderPdfSourceBytes } from "@/lib/pdf-renderer";
import { ResumeRendererDiagnosticError } from "@/lib/resume-renderer-diagnostics";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import { PDFDocument, StandardFonts } from "pdf-lib";

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

async function pdfFixture(sourceBytes?: Buffer) {
  const state = initialDemoState();
  state.profile.id = "pdf-writer-owner";
  const bytes = sourceBytes ?? await createPdfSourceFixture();
  const source = await parsePdfSource(bytes, state.profile.name);
  state.profile.resumeSource = { sha256: source.sourceHash, size: bytes.length, mimeType: "application/pdf", storageKey: `${state.profile.id}/synthetic.pdf` };
  state.profile.resumeSourceDocument = source;
  state.profile.resumeFileName = "synthetic.pdf";
  state.profile.facts = source.anchors.filter((anchor) => anchor.candidateClaim).map((anchor, index) => ({ id: `source-fact-${index}`, text: `${anchor.sectionHeading} · ${anchor.entryHeading} · ${anchor.text}`, source: "resume" as const, verified: true, sourceAnchorId: anchor.id }));
  return { profile: state.profile, job: state.jobs[0], source, layout: pdfSourceLayout(source)! };
}

async function createUnembeddedPdfSourceFixture(name: string) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText(name, { x: 72, y: 744, size: 20, font });
  page.drawText("Experience", { x: 72, y: 710, size: 12, font });
  page.drawText("Orbit Labs — Data Intern | 2025", { x: 72, y: 686, size: 10, font });
  page.drawText("• Built a search index for 1,200 users.", { x: 84, y: 664, size: 10, font });
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function sourcePlanResponse(request: { input: Array<{ content: string }> }, editText = "Built an explainable recommender with 92% precision.") {
  const body = JSON.parse(request.input[1].content);
  return { output_parsed: { edits: body.sourceDocument.anchors.filter((anchor: { candidateClaim: boolean }) => anchor.candidateClaim).map((anchor: { id: string; kind: string; text: string }, index: number) => ({
    anchorId: anchor.id, text: anchor.kind === "bullet" ? editText : anchor.text, factIds: [`source-fact-${index}`],
  })).filter((edit: { anchorId: string; text: string }) => body.sourceDocument.anchors.some((anchor: { id: string; kind: string; editable: boolean; text: string }) => anchor.id === edit.anchorId && anchor.kind === "bullet" && anchor.editable && anchor.text !== edit.text)) } };
}
function auditResponse(request: { input: Array<{ content: string }> }, unsupported = false) {
  const body = JSON.parse(request.input[1].content);
  return { output_parsed: { findings: body.claims.map((claim: { claimId: string; affectedText: string; factIds: string[] }) => ({
    claimId: claim.claimId, outcome: unsupported && claim.claimId === body.sourceActivityPreservationChecks[0]?.sourceClaimId ? "unsupported" : "supported", reason: unsupported && claim.claimId === body.sourceActivityPreservationChecks[0]?.sourceClaimId ? "The confirmed fact does not establish team leadership." : "The confirmed source supports this wording.",
    evidenceFactIds: claim.factIds, requiredInformation: unsupported && claim.claimId === body.sourceActivityPreservationChecks[0]?.sourceClaimId ? "Keep the original recommender result wording." : null,
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

  expect(mocks.parse.mock.calls.map(([request]) => request.model)).toEqual(["gpt-6-luna", "gpt-6-luna"]);
  expect(plan.model).toBe("gpt-6-luna");
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

it("checks run authorization before the first writer call", async () => {
  const { profile, job, source } = await fixture();

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, async () => {
    throw new Error("The application run is no longer authorized.");
  })).rejects.toMatchObject({ diagnostics: { outcome: "technical_failure", technicalFailure: "other", writerAttempts: 0, checkerAttempts: 0, repairAttempts: 0 } });
  expect(mocks.parse).not.toHaveBeenCalled();
});

it("does not start writer or checker calls after the shared deadline expires", async () => {
  const { profile, job, source } = await fixture();

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() - 1)).rejects.toMatchObject({
    diagnostics: { outcome: "technical_failure", technicalFailure: "deadline", writerAttempts: 0, checkerAttempts: 0, repairAttempts: 0 },
  });
  expect(mocks.parse).not.toHaveBeenCalled();
});

it("does not trust renderer prose without a typed safe diagnostic", async () => {
  const { profile, job, source } = await pdfFixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));
  const actionable = "The source font for an edited résumé bullet is not embedded as a supported outline font. Embed that font or upload an editable DOCX; no substitute font will be used.";

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, pdfSourceLayout(source)!, async () => { throw new Error(actionable); }))
    .rejects.toMatchObject({ message: "The résumé layout could not be checked by the pinned renderer. The last valid packet is preserved; retry after reviewing the source document.", diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });

  mocks.parse.mockReset();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, pdfSourceLayout(source)!, async () => { throw new Error("font failure with private runtime path /tmp/private-key"); }))
    .rejects.toMatchObject({ message: "The résumé layout could not be checked by the pinned renderer. The last valid packet is preserved; retry after reviewing the source document.", diagnostics: { technicalFailure: "renderer" } });
});

it("forwards a recognized typed PDF renderer diagnostic", async () => {
  const { profile, job, source } = await pdfFixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));
  const actionable = new ResumeRendererDiagnosticError({ code: "unembedded_font" });
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, pdfSourceLayout(source)!, async () => { throw actionable; }))
    .rejects.toMatchObject({ message: actionable.message, diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });
});

it("forwards typed DOCX and source-parser font guidance from the shared diagnostic catalog", async () => {
  const { profile, job, source } = await pdfFixture();
  const docxFont = new ResumeRendererDiagnosticError({ code: "docx_rendered_font_mismatch",
    text: "Built a search index for 1,200 users.", renderedFonts: ["Arial"], sourceFont: "Noto Sans",
  });
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, pdfSourceLayout(source)!, async () => { throw docxFont; }))
    .rejects.toMatchObject({ message: docxFont.message, diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });

  mocks.parse.mockReset();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));
  const sourceFont = new ResumeRendererDiagnosticError({ code: "pdf_source_font_unidentified", text: "Built a search index for 1,200 users." });

  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, pdfSourceLayout(source)!, async () => { throw sourceFont; }))
    .rejects.toMatchObject({ message: sourceFont.message, diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });
});

it("does not allow plain Errors to spoof DOCX or source-parser font guidance", async () => {
  const { profile, job, source } = await pdfFixture();
  const messages = [
    "The source font for “Built a search index for 1,200 users.” cannot be identified. Upload an editable DOCX rather than substituting a font.",
    "The rendered paragraph “Built a search index for 1,200 users.” uses Arial instead of source font Noto Sans. Upload a DOCX using the pinned Noto Sans source font.",
  ];

  for (const message of messages) {
    mocks.parse.mockReset();
    mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never)).mockImplementationOnce(async (request) => auditResponse(request as never));
    await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, pdfSourceLayout(source)!, async () => { throw new Error(message); }))
      .rejects.toMatchObject({ message: "The résumé layout could not be checked by the pinned renderer. The last valid packet is preserved; retry after reviewing the source document.",
        diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });
  }
});

it("shows an actionable font diagnostic for a real PDFBox missing-glyph failure", async () => {
  await ensurePdfTestRuntime();
  const { profile, job, source } = await pdfFixture();
  const bytes = await createPdfSourceFixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never, "Built a 🪐 search index for 1,200 users."))
    .mockImplementationOnce(async (request) => auditResponse(request as never));

  const failure = await draftResumeSourcePlan(profile, job, source, Date.now() + 90_000, undefined, pdfSourceLayout(source)!, async (plan) => {
    await renderPdfSourceBytes(bytes, source, plan, Date.now() + 90_000, undefined, profile.name);
    return undefined;
  }).catch((error: unknown) => error);

  expect(failure).toMatchObject({ diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });
  expect(failure).toMatchObject({ message: expect.stringMatching(/embedded PDF source font cannot render/i) });
  expect((failure as Error).message).not.toMatch(/Command failed:|PdfSourceRewrite|\/tmp\//);
}, 120_000);

it("shows the source font limitation for a real PDFBox unembedded-font rejection", async () => {
  await ensurePdfTestRuntime();
  const state = initialDemoState();
  const bytes = await createUnembeddedPdfSourceFixture(state.profile.name);
  const { profile, job, source } = await pdfFixture(bytes);
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never))
    .mockImplementationOnce(async (request) => auditResponse(request as never));

  let rendererFailure: unknown;
  const failure = await draftResumeSourcePlan(profile, job, source, Date.now() + 90_000, undefined, pdfSourceLayout(source)!, async (plan) => {
    try { await renderPdfSourceBytes(bytes, source, plan, Date.now() + 90_000, undefined, profile.name); }
    catch (error) { rendererFailure = error; throw error; }
    return undefined;
  }).catch((error: unknown) => error);

  expect(rendererFailure).toMatchObject({ name: "ResumeRendererDiagnosticError", diagnosticCode: "unembedded_font" });
  expect(failure).toMatchObject({ diagnostics: { outcome: "technical_failure", technicalFailure: "renderer" } });
  expect((failure as Error).message).toMatch(/source font .* not embedded/i);
  expect((failure as Error).message).not.toMatch(/Command failed:|PdfSourceRewrite|\/tmp\//);
}, 120_000);

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

it("repairs an AI substitution of the original activity before accepting the résumé", async () => {
  const { profile, job, source } = await fixture();
  const bulletId = source.anchors.find((anchor) => anchor.kind === "bullet")!.id;
  let auditCount = 0;
  let writerCount = 0;
  mocks.parse.mockImplementation(async (request) => {
    if (request.text.format.name === "anchored_resume_edit_plan") {
      writerCount++;
      return sourcePlanResponse(request as never, writerCount === 1 ? "Automated an unrelated sales pipeline." : "Built an explainable recommender with 92% precision.");
    }
    auditCount++;
    const response = auditResponse(request as never);
    if (auditCount === 1) response.output_parsed.sourceActivityPreservations = [{ sourceClaimId: bulletId, outcome: "substituted", preservedClaimId: null,
      reason: "The wording describes a different work activity.", requiredInformation: "Restore the original recommender-development activity." }];
    return response;
  });
  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000);
  expect(plan.edits[0].text).toBe("Built an explainable recommender with 92% precision.");
  expect(plan.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 });
  expect(JSON.parse(mocks.parse.mock.calls[2][0].input[1].content).feedback).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: "audit", anchorId: bulletId, message: expect.stringContaining("original recommender-development activity") }),
  ]));
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
      return { output_parsed: { edits: body.currentDraft.filter((claim: { anchor: { kind: string; editable: boolean } }) => claim.anchor.kind === "bullet" && claim.anchor.editable).map((claim: { anchor: { id: string }; text: string; factIds: string[] }) => ({
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
      return { output_parsed: { edits: body.currentDraft.filter((claim: { anchor: { kind: string; editable: boolean } }) => claim.anchor.kind === "bullet" && claim.anchor.editable).map((claim: { anchor: { id: string }; text: string; factIds: string[] }) => ({
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


it("repairs an invalid edit reference with specific feedback before auditing the assembled résumé", async () => {
  const { profile, job, source } = await fixture();
  const bullet = source.anchors.find((anchor) => anchor.kind === "bullet")!;
  const factId = profile.facts.find((fact) => fact.sourceAnchorId === bullet.id)!.id;
  mocks.parse.mockImplementationOnce(async () => ({ output_parsed: { edits: [{ anchorId: "missing-bullet", text: "Built a recommender.", factIds: [factId] }] } }))
    .mockImplementationOnce(async (request) => {
      const body = JSON.parse(request.input[1].content);
      expect(body.feedback).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "structure", code: "unknown_anchor", anchorId: "missing-bullet" })]));
      expect(body.rejectedCandidate).toEqual({ edits: [{ anchorId: "missing-bullet", text: "Built a recommender.", factIds: [factId] }] });
      return { output_parsed: { edits: [{ anchorId: bullet.id, text: "Built an explainable recommender with 92% precision.", factIds: [factId] }] } };
    }).mockImplementationOnce(async (request) => auditResponse(request as never));

  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000);
  expect(plan.claims).toHaveLength(source.anchors.filter((anchor) => anchor.candidateClaim).length);
  expect(plan.claims.filter((claim) => claim.anchorId !== bullet.id).map((claim) => claim.text)).toEqual(source.anchors.filter((anchor) => anchor.candidateClaim && anchor.id !== bullet.id).map((anchor) => anchor.text));
  expect(plan.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 1, repairAttempts: 1 });
  expect(plan.grounding.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "structure", outcome: "failed" }), expect.objectContaining({ stage: "audit", outcome: "passed" })]));
});

it.each(["docx", "pdf"])("bounds structural repairs and records actionable %s failures", async (format) => {
  const { profile, job, source } = format === "pdf" ? await pdfFixture() : await fixture();
  let attempt = 0;
  mocks.parse.mockImplementation(async () => ({ output_parsed: { edits: [{ anchorId: `invalid-${++attempt}`, text: "Built a recommender.", factIds: [profile.facts[0].id] }] } }));
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000)).rejects.toMatchObject({
    diagnostics: { outcome: "technical_failure", writerAttempts: 3, checkerAttempts: 0, repairAttempts: 2,
      attempts: expect.arrayContaining([expect.objectContaining({ stage: "structure", outcome: "failed", issues: expect.arrayContaining([expect.objectContaining({ code: "unknown_anchor" })]) })]) },
  });
  expect(mocks.parse).toHaveBeenCalledTimes(3);
});

it("stops repeated identical rejected candidates before spending the remaining repair attempt", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockResolvedValue({ output_parsed: { edits: [{ anchorId: "unknown", text: "Built a recommender.", factIds: [profile.facts[0].id] }] } });
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000)).rejects.toMatchObject({ diagnostics: { writerAttempts: 2, repairAttempts: 1, checkerAttempts: 0 } });
  expect(mocks.parse).toHaveBeenCalledTimes(2);
});

it("retries a malformed checker result without rewriting a valid candidate", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never))
    .mockResolvedValueOnce({ output_parsed: { findings: [] } })
    .mockImplementationOnce(async (request) => {
      expect(JSON.parse(request.input[1].content).checkerFeedback[0].code).toBe("malformed_audit");
      return auditResponse(request as never);
    });
  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000);
  expect(plan.grounding).toMatchObject({ writerAttempts: 1, checkerAttempts: 2, checkerRetries: 1, repairAttempts: 0 });
});

it("stops after the separately bounded checker retry without blaming profile facts", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockImplementationOnce(async (request) => sourcePlanResponse(request as never))
    .mockResolvedValue({ output_parsed: { findings: [] } });
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000)).rejects.toMatchObject({ diagnostics: {
    outcome: "technical_failure", technicalFailure: "malformed_response", writerAttempts: 1, checkerAttempts: 2, repairAttempts: 0, findings: [],
  } });
  expect(mocks.parse).toHaveBeenCalledTimes(3);
});

it("shares the repair budget across structure, factual wording, and layout feedback", async () => {
  const { profile, job, source, layout } = await pdfFixture();
  const bullet = source.anchors.find((anchor) => anchor.kind === "bullet")!;
  const mapped = layout.anchors.find((anchor) => anchor.anchorId === bullet.id)!;
  const response = (request: Parameters<typeof sourcePlanResponse>[0], text: string) => {
    const value = sourcePlanResponse(request, text);
    value.output_parsed.edits = value.output_parsed.edits.filter((edit: { anchorId: string }) => edit.anchorId === bullet.id);
    return value;
  };
  mocks.parse.mockResolvedValueOnce({ output_parsed: { edits: [{ anchorId: "invalid", text: "Built search.", factIds: [profile.facts[0].id] }] } })
    .mockImplementationOnce(async (request) => response(request as never, "Led 20 engineers to build search."))
    .mockImplementationOnce(async (request) => auditResponse(request as never, true))
    .mockImplementationOnce(async (request) => response(request as never, "Built search index for 1,200 users."))
    .mockImplementationOnce(async (request) => auditResponse(request as never));
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, layout, async () => ({
    anchorId: bullet.id, pageNumber: mapped.pageNumber, regionId: mapped.regionId, reason: "Too long for the original line.",
  }))).rejects.toMatchObject({ diagnostics: { writerAttempts: 3, checkerAttempts: 2, repairAttempts: 2, technicalFailure: "renderer" } });
  expect(mocks.parse).toHaveBeenCalledTimes(5);
});

it("asks for user confirmation when unchanged original wording fails factual review", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockResolvedValueOnce({ output_parsed: { edits: [] } })
    .mockImplementationOnce(async (request) => auditResponse(request as never, true));
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000)).rejects.toMatchObject({ diagnostics: {
    outcome: "needs_information", writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
  } });
  expect(mocks.parse).toHaveBeenCalledTimes(2);
});

it("honors cancellation before a structural repair can call the writer again", async () => {
  const { profile, job, source } = await fixture();
  mocks.parse.mockResolvedValue({ output_parsed: { edits: [{ anchorId: "unknown", text: "Built a recommender.", factIds: [profile.facts[0].id] }] } });
  const guard = async () => { if (mocks.parse.mock.calls.length) throw new Error("The application was cancelled."); };
  await expect(draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, guard)).rejects.toThrow("The application was cancelled.");
  expect(mocks.parse).toHaveBeenCalledTimes(1);
});

it.each([false, true])("checks previously accepted meaning when a layout repair restores original wording (%s)", async (restoreOriginal) => {
  const { profile, job, source, layout } = await pdfFixture();
  const bullet = source.anchors.find((anchor) => anchor.kind === "bullet")!;
  const mapped = layout.anchors.find((anchor) => anchor.anchorId === bullet.id)!;
  const accepted = "Built search index for 1,200 users and improved reliability.";
  const seenAccepted: Array<string | undefined> = [];
  let writers = 0;
  let layoutCalls = 0;
  mocks.parse.mockImplementation(async (request) => {
    if (request.text.format.name === "anchored_resume_edit_plan") {
      const response = sourcePlanResponse(request as never, ++writers === 1 ? accepted : writers === 2 ? "Built search index for 1,200 users." : "Built reliable search for 1,200 users.");
      response.output_parsed.edits = restoreOriginal && writers === 2 ? [] : response.output_parsed.edits.filter((edit: { anchorId: string }) => edit.anchorId === bullet.id);
      return response;
    }
    const body = JSON.parse(request.input[1].content);
    if (writers > 1) seenAccepted.push(body.sourceActivityPreservationChecks.find((check: { sourceClaimId: string }) => check.sourceClaimId === bullet.id)?.acceptedLayoutText);
    const response = auditResponse(request as never);
    if (writers === 2) response.output_parsed.sourceActivityPreservations = body.sourceActivityPreservationChecks.map((check: { sourceClaimId: string }) => ({
      sourceClaimId: check.sourceClaimId, outcome: check.sourceClaimId === bullet.id ? "substituted" : "preserved", preservedClaimId: check.sourceClaimId === bullet.id ? null : check.sourceClaimId,
      reason: "The shortened bullet lost the previously accepted reliability result.", requiredInformation: check.sourceClaimId === bullet.id ? "Retain the reliability result in shorter wording." : null,
    }));
    return response;
  });
  const plan = await draftResumeSourcePlan(profile, job, source, Date.now() + 60_000, undefined, layout, async () => layoutCalls++ === 0 ? ({
    anchorId: bullet.id, pageNumber: mapped.pageNumber, regionId: mapped.regionId, reason: "Shorten the accepted wording.",
  }) : undefined);
  expect(plan.edits[0].text).toBe("Built reliable search for 1,200 users.");
  expect(seenAccepted).toEqual([accepted, accepted]);
  expect(plan.grounding).toMatchObject({ writerAttempts: 3, checkerAttempts: 3, repairAttempts: 2 });
});
