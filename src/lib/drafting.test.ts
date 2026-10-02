import { describe, it, expect } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { applyHumanAnswerEdits } from "@/lib/answer-policy";
import { draftPacket, validatePacket } from "@/lib/drafting";

describe("truthful application facts", () => {
  it("keeps packet revisions distinct from unsupported schema versions", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    packet.version = 2;
    expect(() => validatePacket(state.profile, packet)).not.toThrow();
    Object.assign(packet, { schemaVersion: 4 });
    expect(() => validatePacket(state.profile, packet)).toThrow(/Unsupported application packet schema version/);
  });
  it("rejects an invented answer that cites a real fact", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    packet.answers = [{ question: "Experience?", answer: "I was CEO of a billion-dollar company.", factIds: [state.profile.facts[0].id], requiresUserInput: false }];
    expect(() => validatePacket(state.profile, packet)).toThrow(/confirmed facts/);
  });
  it("rejects a fact after the owner unconfirms it", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    state.profile.facts.forEach((fact) => { fact.verified = false; });
    expect(() => validatePacket(state.profile, packet)).toThrow(/confirmed profile changed/);
  });
  it("keeps essays pending for AI drafting when the provider is unavailable", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    expect(packet.answers.some((answer) => answer.author === "ai" && answer.requiresUserInput && !answer.answer)).toBe(true);
    expect(packet.coverLetter).toBeUndefined();
  });
  it("keeps a human screening answer in its question without turning it into a resume claim", async () => {
    const state = initialDemoState();
    const factsBefore = structuredClone(state.profile.facts);
    const packet = await draftPacket(state.profile, state.jobs[0]);
    const question = "Are you legally authorized to work in the United States?";
    const answer = "My explicitly supplied details. ".repeat(30);
    packet.answers = applyHumanAnswerEdits([{ question, answer: "", factIds: [], requiresUserInput: true }], [{ question, answer, factIds: [], requiresUserInput: false }]);
    expect(() => validatePacket(state.profile, packet)).not.toThrow();
    expect(state.profile.facts).toEqual(factsBefore);
    expect(packet.answers[0].factIds).toEqual([]);
    expect(packet.answers[0].answer).toBe(answer);
    const regenerated = await draftPacket(state.profile, state.jobs[0], packet);
    expect(regenerated.answers).toEqual(packet.answers);
    expect(regenerated.resumeLines).toEqual(packet.resumeLines);
    expect(regenerated.resumeLines.some((line) => line.text.includes("explicitly supplied details"))).toBe(false);
  });
  it("rejects a blank human answer falsely marked completed", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    packet.answers = [{ question: "Preferred office?", answer: " ", factIds: [], author: "human", userProvided: true, requiresUserInput: false }];
    expect(() => validatePacket(state.profile, packet)).toThrow(/Enter your own answer/);
  });
  it("does not accept a human provenance flag as an AI essay confirmation", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    packet.answers = [{ question: "Why are you interested in this role?", answer: "I wrote this myself.", factIds: [], author: "human", userProvided: true, requiresUserInput: false }];
    expect(() => validatePacket(state.profile, packet)).toThrow(/no verified source fact/);
  });

});
