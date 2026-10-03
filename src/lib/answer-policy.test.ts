import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { answerNeedsAction, answerOwner, applyHumanAnswerEdits, confirmAiEssay, confirmReviewedEssay, reviseEssay, validateUserEssay, essayContentHash, essayEvidenceHash, validateAiEssay } from "@/lib/answer-policy";
import { approveFill, selectApplication, setPacket } from "@/lib/workflow";
import { withPacketFiles } from "@/lib/packet-files";
import { packetProfileHash } from "@/lib/drafting";
import type { Profile, ScreeningAnswer } from "@/lib/types";

function fixtureEssay(profile: Profile): ScreeningAnswer {
  const fact = profile.facts.find((f) => f.verified)!;
  const sentences = [{ text: fact.text, kind: "fact" as const, factIds: [fact.id] }, { text: "I want to bring this experience to the team.", kind: "perspective" as const, factIds: [] }];
  const answer: ScreeningAnswer = { question: "Why are you excited to join us?", answer: sentences.map((s) => s.text).join(" "), factIds: [fact.id], requiresUserInput: true, author: "ai", aiDraft: { version: 1, model: "controlled-fixture", sentences, evidenceHash: essayEvidenceHash(profile, [fact.id]), contentHash: "" } };
  answer.aiDraft!.contentHash = essayContentHash(answer);
  return answer;
}

describe("answer responsibility and confirmation", () => {
  it("keeps applicant revisions separate from AI evidence and requires fresh confirmation after every edit", async () => {
    const state = initialDemoState();
    const facts = structuredClone(state.profile.facts);
    const original = confirmAiEssay(state.profile, fixtureEssay(state.profile));
    const revised = reviseEssay(state.profile, original, "I would like to use my survey project experience on this team.");
    expect(revised).toMatchObject({ author: "human", userProvided: true, factIds: [], requiresUserInput: true });
    expect(revised.aiDraft).toBeUndefined();
    expect(revised.confirmedAt).toBeUndefined();
    expect(revised.userRevision).toMatchObject({ originalAnswer: original.answer, originalDraftHash: original.aiDraft!.contentHash, originalFactIds: original.factIds });
    expect(answerNeedsAction(revised)).toBe(true);
    expect(() => validateAiEssay(state.profile, revised)).toThrow();
    expect(() => validateUserEssay({ ...revised, answer: "Changed without saving" })).toThrow(/changed/);
    expect(() => reviseEssay(state.profile, original, " ")).toThrow(/between/);
    expect(() => reviseEssay(state.profile, original, "x".repeat(4001))).toThrow(/between/);
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    const packet = await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", summary: "fixture", createdAt: new Date().toISOString(), profileHash: packetProfileHash(state.profile), resumeLines: [{ text: facts[0].text, factIds: [facts[0].id] }], answers: [revised] });
    setPacket(state, app, packet);
    expect(() => approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl)).toThrow(/confirm/);
    const confirmed = confirmReviewedEssay(state.profile, revised);
    expect(answerNeedsAction(confirmed)).toBe(false);
    setPacket(state, app, await withPacketFiles(state.profile, { ...packet, version: 2, answers: [confirmed] }));
    approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
    const next = reviseEssay(state.profile, confirmed, "I want to bring my survey analysis experience to this role.");
    expect(next.confirmedAt).toBeUndefined();
    expect(next.userRevision?.originalAnswer).toBe(original.answer);
    expect(next.userRevision?.contentHash).not.toBe(revised.userRevision?.contentHash);
    expect(state.profile.facts).toEqual(facts);
    expect(app.approvals.some((approval) => approval.kind === "submit")).toBe(false);
  });
  it.each([
    "Are you legally authorized to work in the United States?",
    "Will you now or in the future require visa sponsorship?",
    "Describe your immigration status and work experience.",
    "Can Metaview transcribe all your interviews?",
    "Which Sierra office would you prefer to work from?",
    "Name pronounciation", "How did you hear about this opportunity?", "An unfamiliar question",
  ])("keeps human control of %s", (question) => expect(answerOwner(question)).toBe("human"));
  it.each([
    "Why are you excited to join us at Sierra?",
    "What qualities do you believe make someone a great Agent Engineer, and how do your skills and experiences make you the best candidate for this role?",
    "Describe a challenging project.",
  ])("assigns the essay %s to AI", (question) => expect(answerOwner(question)).toBe("ai"));

  it("blocks fill until the exact AI essay is confirmed, without adding prose as profile facts", async () => {
    const state = initialDemoState();
    const facts = structuredClone(state.profile.facts);
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    const essay = fixtureEssay(state.profile);
    setPacket(state, app, await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", summary: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: facts[0].text, factIds: [facts[0].id] }], answers: [essay], profileHash: packetProfileHash(state.profile) }));
    expect(answerNeedsAction(essay)).toBe(true);
    expect(() => approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl)).toThrow(/confirm every AI essay/);
    const confirmed = confirmAiEssay(state.profile, essay);
    expect(confirmed.confirmedAt).toBeTruthy();
    expect(answerNeedsAction(confirmed)).toBe(false);
    expect(state.profile.facts).toEqual(facts);
    expect(app.approvals).toHaveLength(0);
  });

  it("rejects edited text, revoked or changed sources and false citations", () => {
    const state = initialDemoState();
    const essay = fixtureEssay(state.profile);
    expect(() => validateAiEssay(state.profile, essay)).not.toThrow();
    expect(() => confirmAiEssay(state.profile, { ...essay, answer: "I invented a career." })).toThrow(/changed/);
    const changed = structuredClone(state.profile);
    changed.facts[0].text = "A new claim.";
    expect(() => confirmAiEssay(changed, essay)).toThrow(/sources/);
    changed.facts[0].verified = false;
    expect(() => confirmAiEssay(changed, essay)).toThrow(/sources/);
    const falseCitation = structuredClone(essay);
    falseCitation.aiDraft!.sentences[0].factIds = [];
    falseCitation.aiDraft!.contentHash = essayContentHash(falseCitation);
    expect(() => validateAiEssay(state.profile, falseCitation)).toThrow(/sources/);
  });

  it("lets humans answer personal questions but rejects essay edits, renames and forged confirmation", () => {
    const profile = initialDemoState().profile;
    const factsBefore = structuredClone(profile.facts);
    const essay = fixtureEssay(profile);
    const human: ScreeningAnswer = { question: "Are you legally authorized to work in the United States?", answer: "", factIds: [], requiresUserInput: true };
    const result = applyHumanAnswerEdits([essay, human], [ { ...essay, confirmedAt: "forged", author: "human" }, { ...human, answer: "I will provide my own authorization details." } ]);
    expect(result[0]).toBe(essay);
    expect(result[0].confirmedAt).toBeUndefined();
    expect(result[1].author).toBe("human");
    expect(result[1].userProvided).toBe(true);
    expect(result[1].requiresUserInput).toBe(false);
    expect(result[1].factIds).toEqual([]);
    expect(profile.facts).toEqual(factsBefore);
    expect(() => applyHumanAnswerEdits([essay], [{ ...essay, answer: "Human-written essay" }])).toThrow(/AI writes essays/);
    expect(() => applyHumanAnswerEdits([essay], [{ ...essay, question: "Preferred office?" }])).toThrow(/labels/);
    expect(() => applyHumanAnswerEdits([essay], [])).toThrow(/questions changed/);
  });
});
