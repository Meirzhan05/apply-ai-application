import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parseDocxSource } from "@/lib/docx-source";
import { confirmedFactIdsForAnchor, unconfirmedPdfFactSuggestions, validateSourcePlanEvidence } from "@/lib/source-plan-evidence";
import { canonicalPdfSourceFactText, evidenceRequiredAnchorIds } from "@/lib/resume-source-semantics";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource } from "@/lib/pdf-source";

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

it("keeps previously accepted legacy plans readable while new plans require anchor-associated evidence", async () => {
  const source = await parseDocxSource(await createDocxSourceFixture());
  const anchors = source.anchors.filter((anchor) => anchor.candidateClaim);
  const profile = initialDemoState().profile;
  profile.facts = [{ id: "confirmed-legacy-history", text: "Confirmed skills and work history", verified: true, source: "resume" }];
  const claims = anchors.map((anchor) => ({ anchorId: anchor.id, text: anchor.text, factIds: [profile.facts[0].id] }));
  const input = {
    source, profile, claims, edits: [], grounding: { version: 1 as const, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const, reason: "Confirmed by the saved legacy checker.", evidenceFactIds: [profile.facts[0].id] })) },
  };

  expect(validateSourcePlanEvidence(input)).toBe(true);
  expect(validateSourcePlanEvidence({ ...input, evidencePolicyVersion: 2 })).toBe(false);
});

it("reuses only exact current same-entry PDF context and never substring or cross-source evidence", async () => {
  const parsed = await parsePdfSource(await createPdfSourceFixture());
  const base = parsed.anchors.find((anchor) => anchor.kind === "entry")!;
  const target = { ...base, id: "target-entry", text: "Orbit Labs", kind: "entry" as const, candidateClaim: true,
    entryId: "stable-entry", entryHeading: "2024–2025 · Orbit Labs · Machine Learning Engineer" };
  const evidence = { ...base, id: "confirmed-bullet", text: "Built reliable search systems.", kind: "bullet" as const,
    entryId: "stable-entry", entryHeading: target.entryHeading, sectionHeading: "Work Experience" };
  const source = { ...parsed, anchors: [target, evidence] };
  const profile = initialDemoState().profile;
  profile.facts = [{ id: "confirmed-context", text: canonicalPdfSourceFactText(evidence), verified: true, source: "resume", sourceAnchorId: evidence.id }];

  expect(confirmedFactIdsForAnchor(profile, target, source)).toEqual(["confirmed-context"]);
  expect(validateSourcePlanEvidence({ source, profile, evidencePolicyVersion: 2, edits: [], claims: [
    { anchorId: target.id, text: target.text, factIds: ["confirmed-context"] },
    { anchorId: evidence.id, text: evidence.text, factIds: ["confirmed-context"] },
  ] })).toBe(true);
  expect(confirmedFactIdsForAnchor(profile, { ...target, text: "Orbit" }, source)).toEqual([]);
  expect(confirmedFactIdsForAnchor(profile, { ...target, kind: "bullet" }, source)).toEqual([]);
  const docx = await parseDocxSource(await createDocxSourceFixture());
  expect(confirmedFactIdsForAnchor(profile, target, docx)).toEqual([]);

  profile.facts[0].text = `${profile.facts[0].text.replace(" · ", " | ")}`;
  expect(confirmedFactIdsForAnchor(profile, target, source)).toEqual([]);
  profile.facts[0].text = canonicalPdfSourceFactText(evidence);
  profile.facts[0].source = "user";
  expect(confirmedFactIdsForAnchor(profile, target, source)).toEqual([]);
  profile.facts[0].source = "resume";
  profile.facts[0].sourceAnchorId = "stale-anchor";
  expect(confirmedFactIdsForAnchor(profile, target, source)).toEqual([]);
  profile.facts[0].sourceAnchorId = evidence.id;
  profile.facts[0].text = "Work Experience · 2024–2025 · Orbit Labs · Built reliable search systems altered";
  expect(confirmedFactIdsForAnchor(profile, target, source)).toEqual([]);
});

it("filters only PDF punctuation and structurally proven skill labels, not project Tools", async () => {
  const parsed = await parsePdfSource(await createPdfSourceFixture({ columns: true }));
  const base = parsed.anchors.find((anchor) => anchor.text === "Technical Skills")!;
  const row = (id: string, text: string, order: number, kind: "section" | "entry" = "entry") => ({ ...base, id, text, kind,
    candidateClaim: true, readingOrder: order, sectionHeading: "Technical Skills", entryHeading: text,
    boundsPt: { left: 400, top: 100, right: 480, bottom: 110 } });
  const source = { ...parsed, anchors: [
    row("skills-heading", "Technical Skills", 1, "section"),
    row("frameworks-label", "Frameworks", 2),
    row("frameworks-value", ": React, FastAPI", 3),
    row("tools-project", "Tools", 4),
    { ...row("separator", "|", 5), sectionHeading: "Projects" },
  ] };

  const required = evidenceRequiredAnchorIds(source);
  expect(required.has("frameworks-label")).toBe(false);
  expect(required.has("frameworks-value")).toBe(true);
  expect(required.has("tools-project")).toBe(true);
  expect(required.has("separator")).toBe(false);

  const noValue = { ...source, anchors: source.anchors.filter((anchor) => anchor.id !== "frameworks-value") };
  expect(evidenceRequiredAnchorIds(noValue).has("frameworks-label")).toBe(true);
});

it("does not let an identical fact from a different entry suppress a review suggestion", async () => {
  const parsed = await parsePdfSource(await createPdfSourceFixture());
  const base = parsed.anchors.find((anchor) => anchor.kind === "entry")!;
  const first = { ...base, id: "first-entry", text: "2024–2025", kind: "entry" as const, entryId: "entry-one",
    entryHeading: "2024–2025 · Orbit Labs", sectionHeading: "Work Experience", candidateClaim: true };
  const second = { ...first, id: "second-entry", entryId: "entry-two" };
  const source = { ...parsed, anchors: [first, second] };
  const profile = initialDemoState().profile;
  profile.facts = [{ id: "other-entry-fact", text: canonicalPdfSourceFactText(first), verified: true, source: "resume", sourceAnchorId: first.id }];

  expect(confirmedFactIdsForAnchor(profile, second, source)).toEqual([]);
  expect(unconfirmedPdfFactSuggestions(profile, source)).toContainEqual({ text: canonicalPdfSourceFactText(second), sourceAnchorId: second.id });

  const shortProject = { ...second, id: "short-project", text: "Tools", entryHeading: "Tools", sectionHeading: "Projects" };
  const shortSource = { ...source, anchors: [shortProject] };
  expect(unconfirmedPdfFactSuggestions(profile, shortSource)).toContainEqual({ text: "Projects · Tools · Tools", sourceAnchorId: shortProject.id });
});

it("keeps saved policy-2 separator claims readable while policy-3 plans exclude them", async () => {
  const parsed = await parsePdfSource(await createPdfSourceFixture());
  const base = parsed.anchors.find((anchor) => anchor.kind === "entry")!;
  const separator = { ...base, id: "saved-divider", text: "|", candidateClaim: true, kind: "entry" as const };
  const source = { ...parsed, anchors: [separator] };
  const profile = initialDemoState().profile;
  profile.facts = [{ id: "confirmed-divider", text: "|", source: "resume", sourceAnchorId: separator.id, verified: true }];
  const input = { source, profile, claims: [{ anchorId: separator.id, text: "|", factIds: ["confirmed-divider"] }], edits: [] };
  expect(validateSourcePlanEvidence({ ...input, evidencePolicyVersion: 2 })).toBe(true);
  expect(validateSourcePlanEvidence({ ...input, evidencePolicyVersion: 3 })).toBe(false);
  expect(validateSourcePlanEvidence({ ...input, claims: [], evidencePolicyVersion: 3 })).toBe(true);
});


it("retains accepted AI-grounded facts under the merged evidence policy without human confirmation", async () => {
  const source = await parseDocxSource(await createDocxSourceFixture({ secondExperience: true }));
  const profile = initialDemoState().profile;
  const anchors = source.anchors.filter((anchor) => anchor.candidateClaim);
  profile.facts = anchors.map((anchor, index) => ({ id: `accepted-${index}`, text: anchor.text, verified: false,
    source: "resume", sourceAnchorId: anchor.id, status: "accepted", grounding: { version: 1, sourceHash: source.sourceHash,
      model: "fixture", acceptedText: anchor.text, evidence: [{ anchorId: anchor.id, quote: anchor.text }] } }));
  const input = { source, profile, evidencePolicyVersion: 3 as const, edits: [],
    claims: anchors.map((anchor, index) => ({ anchorId: anchor.id, text: anchor.text, factIds: [`accepted-${index}`] })) };
  expect(validateSourcePlanEvidence(input)).toBe(true);
  profile.facts[0].grounding!.sourceHash = "f".repeat(64);
  expect(validateSourcePlanEvidence(input)).toBe(false);
});

it("rejects an accepted fact whose additional grounded excerpt comes from another employer", async () => {
  const source = await parseDocxSource(await createDocxSourceFixture({ secondExperience: true }));
  const profile = initialDemoState().profile;
  const anchors = source.anchors.filter((anchor) => anchor.candidateClaim);
  profile.facts = anchors.map((anchor, index) => ({ id: `accepted-${index}`, text: anchor.text, verified: false,
    source: "resume", sourceAnchorId: anchor.id, status: "accepted", grounding: { version: 1, sourceHash: source.sourceHash,
      model: "fixture", acceptedText: anchor.text, evidence: [{ anchorId: anchor.id, quote: anchor.text }] } }));
  const first = anchors.findIndex((anchor) => anchor.kind === "bullet");
  const other = anchors.find((anchor) => anchor.kind === "bullet" && anchor.entryId !== anchors[first].entryId)!;
  profile.facts[first].grounding!.evidence.push({ anchorId: other.id, quote: other.text });
  expect(validateSourcePlanEvidence({ source, profile, evidencePolicyVersion: 3, edits: [],
    claims: anchors.map((anchor, index) => ({ anchorId: anchor.id, text: anchor.text, factIds: [`accepted-${index}`] })) })).toBe(false);
});
