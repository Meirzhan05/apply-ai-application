import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parseDocxSource } from "@/lib/docx-source";
import type { ApplicationPacket, DocxResumeArtifact, Profile, ResumeDraftDiagnostics, ResumeSourcePlan } from "@/lib/types";
import { ResumeComparison, ResumeComparisonView, ResumeSourceFactsNotice, ResumeSourceSupportNotice, ResumeDraftHistory } from "@/components/resume-comparison";

async function fixture() {
  const state = initialDemoState();
  const profile = structuredClone(state.profile);
  const sourceBytes = await createDocxSourceFixture();
  const source = await parseDocxSource(sourceBytes);
  const candidateAnchors = source.anchors.filter((anchor) => anchor.candidateClaim);
  const changedAnchor = candidateAnchors.find((anchor) => anchor.kind === "bullet")!;
  const fact = { id: "confirmed-fact-1", text: "Built an explainable recommender with 92% precision.", source: "resume" as const, verified: true, sourceAnchorId: changedAnchor.id };
  profile.resumeFileName = "original-riley.docx";
  profile.resumeSource = { storageKey: `${profile.id}/${source.sourceHash}.docx`, sha256: source.sourceHash, size: sourceBytes.length, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  profile.resumeSourceDocument = source;
  profile.facts = [fact];
  const claims = candidateAnchors.map((anchor) => ({ anchorId: anchor.id, text: anchor.id === changedAnchor.id ? fact.text : anchor.text, factIds: [fact.id] }));
  const edits = [{ anchorId: changedAnchor.id, text: fact.text, factIds: [fact.id] }];
  const plan: ResumeSourcePlan = {
    version: 1, format: "docx", sourceHash: source.sourceHash, representationVersion: 1,
    profileHash: "b".repeat(64), factsHash: "c".repeat(64), settingsHash: "d".repeat(64), jobHash: "e".repeat(64),
    claims, edits,
    grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed source fact.", evidenceFactIds: claim.factIds })) },
    model: "fixture",
  };
  const artifact: DocxResumeArtifact = {
    format: "docx", inputHash: "f".repeat(64), pageCount: 1, renderer: "libreoffice-26.8.0.3", rendererVersion: "LibreOffice 26.8.0.3",
    sourceHash: source.sourceHash, representationVersion: 1, profileHash: plan.profileHash, factsHash: plan.factsHash, settingsHash: plan.settingsHash, jobHash: plan.jobHash,
    layoutPolicy: "docx-single-column-one-page-v1",
    layoutValidation: { outcome: "passed", pageWidthPt: 612, pageHeightPt: 792, unchangedAnchorTolerancePt: 1, pageSizeTolerancePt: 0.5, visualOutsideEditTolerance: 0.001, visualOutsideEditDifference: 0, baselinePdfHash: "1".repeat(64) },
    baseline: { storageKey: `${profile.id}/${plan.jobHash}/${"1".repeat(64)}.pdf`, sha256: "1".repeat(64), size: 256, mimeType: "application/pdf" },
    source: { storageKey: `${profile.id}/${plan.jobHash}/${"2".repeat(64)}.docx`, sha256: "2".repeat(64), size: 512, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  };
  const packet: ApplicationPacket = {
    schemaVersion: 3, version: 1, summary: "Application packet", resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })),
    resumeMode: "tailored", resumeSourcePlan: plan, resumeArtifact: artifact,
    files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", size: 1024, sha256: "3".repeat(64), storageKey: `${profile.id}/${plan.jobHash}/${"3".repeat(64)}.pdf`, factIds: [fact.id] }],
    answers: [], createdAt: "2026-10-01T00:00:00.000Z", model: "fixture",
  };
  return { state, profile, source, packet, fact, changedAnchor };
}

function renderView(profile: Profile, packet: ApplicationPacket, freshness: "checking" | "current" | "stale" | "unavailable" = "current", freshnessReasons: string[] = [], onReviewProfile?: () => void, onRebuildResume?: () => void) {
  const artifact = packet.resumeArtifact;
  const plan = packet.resumeSourcePlan;
  if (!artifact || artifact.format === "latex" || !("baseline" in artifact) || !("layoutValidation" in artifact) || !plan) throw new Error("Fixture must contain a source-preserving packet.");
  return renderToStaticMarkup(createElement(ResumeComparisonView, { applicationId: "application-123", profile, artifact, plan, freshness, freshnessReasons, onReviewProfile, onRebuildResume }));
}

describe("ResumeComparison", () => {
  it("describes DOCX layout support using the source format and support result", async () => {
    const { source } = await fixture();
    const supported = renderToStaticMarkup(createElement(ResumeSourceSupportNotice, { source }));
    const blocked = renderToStaticMarkup(createElement(ResumeSourceSupportNotice, { source: { ...source, support: { status: "blocked", reason: "The source uses unsupported columns." } } }));

    expect(supported).toContain("DOCX source captured");
    expect(supported).toContain("1 column");
    expect(supported).toContain("Up to eight pages and two text columns per page are supported");
    expect(supported).toContain("DOCX page count is verified after rendering");
    expect(supported).toContain("Layout is checked before a tailored file is saved");
    expect(blocked).toContain("DOCX layout is unsupported");
    expect(blocked).toContain("The source uses unsupported columns.");
  });

  it("shows private original and tailored previews, exact downloads, anchored wording changes, and layout evidence", async () => {
    const { profile, source, packet, fact, changedAnchor } = await fixture();
    const markup = renderView(profile, packet);

    expect(markup).toContain('title="Original résumé layout preview"');
    expect(markup).toContain('/api/applications/application-123/files/resume-original-preview');
    expect(markup).toContain('title="Tailored résumé preview"');
    expect(markup).toContain('/api/applications/application-123/files/resume-tailored-preview');
    expect(markup).toContain('/api/applications/application-123/files/resume-tailored-preview?download=1');
    expect(markup).toContain('/api/applications/application-123/files/resume-original?download=1');
    expect(markup).toContain("original-riley.docx");
    expect(markup).toContain("Original wording");
    expect(markup).toContain(changedAnchor.text);
    expect(markup).toContain(fact.text);
    expect(markup).toContain("Available profile fact");
    expect(markup).toContain("Layout check passed");
    expect(markup).toContain("1 page");
    expect(markup).toContain(source.format.toUpperCase());
  });

  it("shows precise latest grounding blockers and routes source corrections to the profile", async () => {
    const { profile, packet, changedAnchor } = await fixture();
    const diagnostics: ResumeDraftDiagnostics = {
      version: 1, outcome: "needs_information", writerAttempts: 3, checkerAttempts: 3, repairAttempts: 2,
      requiredInformation: ["Confirm whether the project reached production."],
      findings: [
        { claimId: changedAnchor.id, affectedText: "Launched the project to production.", outcome: "uncertain", reason: "The confirmed facts do not establish launch status.", evidenceFactIds: ["confirmed-fact-1"], requiredInformation: "Confirm whether the project reached production." },
        { claimId: "other-anchor", affectedText: "Managed a 50-person team.", outcome: "contradiction", reason: "The confirmed record describes an individual project.", evidenceFactIds: ["confirmed-fact-1"], requiredInformation: "Confirm the team size." },
      ],
    };
    const markup = renderToStaticMarkup(createElement(ResumeComparison, { applicationId: "application-123", profile, packet, diagnostics, onReviewProfile: () => {} }));

    expect(markup).toContain("Résumé needs more information");
    expect(markup).toContain("Evidence is uncertain");
    expect(markup).toContain("Conflicts with available profile facts");
    expect(markup).toContain("Confirm whether the project reached production.");
    expect(markup).toContain("Review profile facts");
  });

  it("keeps source-fact preflight concise and sends the user to confirm the pending facts", async () => {
    const { profile, packet, changedAnchor } = await fixture();
    const diagnostics: ResumeDraftDiagnostics = {
      version: 1, outcome: "needs_information", writerAttempts: 0, checkerAttempts: 0, repairAttempts: 0,
      requiredInformation: ["Confirm the date context.", "Confirm the project name."],
      findings: [
        { claimId: changedAnchor.id, affectedText: "2025", outcome: "unsupported", reason: "This original résumé claim has not been confirmed as a fact.", evidenceFactIds: [], requiredInformation: "Confirm this source claim in your profile facts." },
        { claimId: "pending-project", affectedText: "Northwind project", outcome: "unsupported", reason: "This original résumé claim has not been confirmed as a fact.", evidenceFactIds: [], requiredInformation: "Confirm this source claim in your profile facts." },
      ],
    };
    const markup = renderToStaticMarkup(createElement(ResumeComparison, { applicationId: "application-123", profile, packet, diagnostics, onReviewProfile: () => {} }));

    expect(markup).toContain("2 source details are missing evidence links");
    expect(markup).toContain("Re-extract your saved resume in Profile, then retry drafting.");
    expect(markup).toContain("Repair source evidence in profile");
    expect(markup).toContain("2025");
    expect(markup).toContain("Northwind project");
    expect(markup).not.toContain("Information needed");
    expect(markup).not.toContain("This original résumé claim has not been confirmed as a fact.");
  });

  it("shows an actionable source-fact review notice when the first draft has no packet yet", () => {
    const diagnostics: ResumeDraftDiagnostics = {
      version: 1, outcome: "needs_information", writerAttempts: 0, checkerAttempts: 0, repairAttempts: 0,
      requiredInformation: ["Confirm one date."],
      findings: [{ claimId: "date-anchor", affectedText: "2025", outcome: "unsupported", reason: "Unconfirmed source claim.", evidenceFactIds: [], requiredInformation: "Confirm this date." }],
    };
    const markup = renderToStaticMarkup(createElement(ResumeSourceFactsNotice, { diagnostics, onReviewProfile: () => {} }));

    expect(markup).toContain("Reconnect your resume source details before drafting");
    expect(markup).toContain("Re-extract your saved resume in Profile, then retry drafting.");
    expect(markup).toContain("Repair source evidence in profile");
    expect(markup).toContain("2025");
  });

  it("does not map saved edits onto a replaced source file", async () => {
    const { profile, packet } = await fixture();
    profile.resumeSourceDocument = { ...profile.resumeSourceDocument!, sourceHash: "a".repeat(64) };
    profile.resumeSource = { ...profile.resumeSource!, sha256: "a".repeat(64) };
    const markup = renderView(profile, packet, "stale", ["source"], undefined, () => {});

    expect(markup).toContain("original source has changed");
    expect(markup).toContain("The original wording map is stale");
    expect(markup).toContain("source changed");
    expect(markup).toContain("Rebuild to compare current previews");
    expect(markup).toContain("Rebuild résumé");
    expect(markup).not.toContain("title=\"Original résumé layout preview\"");
    expect(markup).not.toContain("title=\"Tailored résumé preview\"");
    expect(markup).not.toContain("resume-tailored-preview?download=1");
    expect(markup).not.toContain("resume-original?download=1");
  });

  it("keeps all preview links hidden while freshness is being checked or cannot be verified", async () => {
    const { profile, packet } = await fixture();
    for (const freshness of ["checking", "unavailable"] as const) {
      const markup = renderView(profile, packet, freshness);
      expect(markup).toContain("Résumé previews unavailable");
      expect(markup).not.toContain("resume-original-preview#");
      expect(markup).not.toContain("resume-tailored-preview#");
      expect(markup).not.toContain("resume-tailored-preview?download=1");
    }
  });
});


it("shows the failed rule and recovery in the résumé preparation history", () => {
  const markup = renderToStaticMarkup(createElement(ResumeDraftHistory, { report: { writerAttempts: 2, checkerAttempts: 1, repairAttempts: 1,
    attempts: [{ stage: "structure", writerAttempt: 1, checkerAttempt: 0, outcome: "failed", issues: [{ stage: "structure", code: "different_entry", message: "Use evidence from the same employer." }] },
      { stage: "audit", writerAttempt: 2, checkerAttempt: 1, outcome: "passed", issues: [] }] } }));
  expect(markup).toContain("Preparation history");
  expect(markup).toContain("Use evidence from the same employer.");
  expect(markup).toContain("Passed");
});
