import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { parse }; } }));
import { initialDemoState } from "@/lib/demo-data";
import { completeOnboardingFixture } from "@/lib/testing/onboarding";
import { draftAiEssay, draftEssayAnswers } from "@/lib/essay-drafting";
import { confirmAiEssay, validateAiEssay } from "@/lib/answer-policy";
import { draftPacket } from "@/lib/drafting";
import { draftAutonomousEssays, prepareAutonomousFormEssays } from "@/lib/autonomous-essays";
import { activateAutomation } from "@/lib/onboarding";
import type { ApplicationPacket, ScreeningAnswer } from "@/lib/types";

const question = "Why are you excited to join us?";
function providerDraft() {
  const fact = initialDemoState().profile.facts[0];
  return { output_parsed: { sentences: [{ text: "I want to build useful tools with this team.", kind: "perspective", factIds: [] }, { text: fact.text, kind: "fact", factIds: [fact.id] }] } };
}
function successfulResponses() {
  parse.mockResolvedValueOnce(providerDraft()).mockResolvedValueOnce({ output_parsed: { grounded: true, unsupportedClaims: [] } });
}
beforeEach(() => { vi.stubEnv("OPENAI_API_KEY", "synthetic-key"); parse.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe("AI essay generation", () => {
  it("repairs a rejected draft using audit feedback and audits the replacement", async () => {
    const state = initialDemoState();
    const rejected = providerDraft();
    rejected.output_parsed.sentences[0].text = "Replit is the largest software platform in the world.";
    parse.mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce({ output_parsed: { grounded: false, unsupportedClaims: ["The posting does not support the largest-platform claim."] } })
      .mockResolvedValueOnce(providerDraft())
      .mockResolvedValueOnce({ output_parsed: { grounded: true, unsupportedClaims: [] } });
    const result = await draftAiEssay(state.profile, state.jobs[0], "Why are you interested in Replit?");
    expect(result.aiDraft).toBeDefined();
    expect(result.answer).not.toContain("largest");
    expect(parse).toHaveBeenCalledTimes(4);
    const repair = JSON.parse(parse.mock.calls[2][0].input.find((message: { role: string }) => message.role === "user").content);
    expect(repair.unsupportedClaims).toEqual(["The posting does not support the largest-platform claim."]);
    expect(repair.previousSentences).toEqual(rejected.output_parsed.sentences);
    expect(() => validateAiEssay(state.profile, result)).not.toThrow();
  });

  it("allows a checked motivation-only answer for applicant confirmation", async () => {
    const state = initialDemoState();
    parse.mockResolvedValueOnce({ output_parsed: { sentences: [
      { text: "I am interested in helping people turn ideas into useful software.", kind: "perspective", factIds: [] },
      { text: "I would like to contribute to tools that make that process easier.", kind: "perspective", factIds: [] },
    ] } }).mockResolvedValueOnce({ output_parsed: { grounded: true, unsupportedClaims: [] } });
    const result = await draftAiEssay(state.profile, { ...state.jobs[0], company: "Replit" }, "Why are you interested in Replit?");
    expect(result.aiDraft).toBeDefined();
    expect(result.answer).toContain("I am interested");
    expect(result.requiresUserInput).toBe(true);
    expect(result.confirmedAt).toBeUndefined();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(() => validateAiEssay(state.profile, result)).not.toThrow();
  });

  it("fails closed after two rejected drafts", async () => {
    const state = initialDemoState();
    for (let index = 0; index < 2; index++) {
      parse.mockResolvedValueOnce(providerDraft()).mockResolvedValueOnce({ output_parsed: { grounded: false, unsupportedClaims: ["Unsupported applicant history"] } });
    }
    const result = await draftAiEssay(state.profile, state.jobs[0], question);
    expect(result.aiDraft).toBeUndefined();
    expect(result.answer).toBe("");
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it("does not repair a refused audit or run beyond the deadline", async () => {
    const state = initialDemoState();
    parse.mockResolvedValueOnce(providerDraft()).mockResolvedValueOnce({ output_parsed: null });
    expect((await draftAiEssay(state.profile, state.jobs[0], question)).aiDraft).toBeUndefined();
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockReset();
    const deadline = Date.now() + 10_000;
    parse.mockResolvedValueOnce(providerDraft()).mockImplementationOnce(async () => {
      vi.spyOn(Date, "now").mockReturnValue(deadline);
      return { output_parsed: { grounded: false, unsupportedClaims: ["Unsupported claim"] } };
    });
    try {
      expect((await draftAiEssay(state.profile, state.jobs[0], question, deadline)).aiDraft).toBeUndefined();
      expect(parse).toHaveBeenCalledTimes(2);
    } finally { vi.restoreAllMocks(); }
  });

  it("keeps automatic motivation rules and checks authorization again before a repair", async () => {
    const state = initialDemoState();
    const guard = vi.fn().mockResolvedValue(undefined);
    parse.mockResolvedValueOnce(providerDraft()).mockResolvedValueOnce({ output_parsed: { grounded: false, unsupportedClaims: ["Invented motivation"] } });
    guard.mockImplementation(async () => { if (parse.mock.calls.length === 2) throw new Error("Authorization changed"); });
    const result = await draftAiEssay(state.profile, state.jobs[0], question, undefined, { automatic: true, beforeModelCall: guard });
    expect(result.aiDraft).toBeUndefined();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenCalledTimes(5);
    expect(parse.mock.calls[0][0].input[0].content).toContain("Do not invent applicant motivations");
    expect(parse.mock.calls[1][0].input[0].content).toContain("reject invented applicant preferences");
  });

  it("drafts more than five essays in one application", async () => {
    const state = initialDemoState();
    state.profile = completeOnboardingFixture(state.profile);
    const questions: ScreeningAnswer[] = Array.from({ length: 6 }, (_, index) => ({ question: `Why are you interested in this role? Essay ${index}`, answer: "", factIds: [], author: "ai", requiresUserInput: true }));
    questions.forEach(() => successfulResponses());
    const drafts = await draftEssayAnswers(state.profile, state.jobs[0], questions);
    expect(drafts).toHaveLength(6);
    expect(drafts.every(draft => draft.aiDraft && draft.answer.trim())).toBe(true);
    expect(parse).toHaveBeenCalledTimes(12);
  });

  it("authorizes and binds more than five automatic essays to the observed form", async () => {
    const state = initialDemoState();
    state.profile = completeOnboardingFixture(state.profile);
    const profile = state.profile;
    activateAutomation(profile, "Synthetic essay test");
    const questions: ScreeningAnswer[] = Array.from({ length: 6 }, (_, index) => ({ question: `Why are you interested in this role? Essay ${index}`, answer: "", factIds: [], author: "ai", requiresUserInput: true }));
    questions.forEach(() => successfulResponses());
    const drafts = await draftAutonomousEssays(profile, state.jobs[0], questions, async () => {});
    expect(drafts).toHaveLength(6);
    const app = { ...state.applications[0], browserSessionId: "large-essay-session", packet: { schemaVersion: 1 as const, version: 1, summary: "Large essay fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [], answers: drafts } };
    const bound = await prepareAutonomousFormEssays(profile, state.jobs[0], app, { version: 1, url: state.jobs[0].applyUrl, attachments: [], capturedAt: new Date().toISOString(), fields: questions.map((question, index) => ({ identifier: `essay-${index}`, label: question.question, kind: "textarea", required: true, value: "" })) }, async () => {});
    expect(bound.answers).toHaveLength(6);
    expect(bound.answers.map(answer => answer.autonomousEssayAuthorization?.control?.identifier)).toEqual(questions.map((_, index) => `essay-${index}`));
    expect(parse).toHaveBeenCalledTimes(12);
  });

  it("writes prose, checks grounded claims separately, and waits for confirmation", async () => {
    const state = initialDemoState();
    successfulResponses();
    const result = await draftAiEssay(state.profile, state.jobs[0], question);
    expect(result.answer).toContain("I want to build useful tools");
    expect(result.aiDraft?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.confirmedAt).toBeUndefined();
    expect(result.requiresUserInput).toBe(true);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(parse.mock.calls[0][0].model).toBe("gpt-6-luna");
    expect(parse.mock.calls[1][0].model).toBe("gpt-6-luna");
    expect(result.aiDraft?.model).toBe("gpt-6-luna");
    expect(parse.mock.calls[0][0].store).toBe(false);
    const context = JSON.parse(parse.mock.calls[0][0].input[1].content);
    expect(context).not.toHaveProperty("name");
    expect(context).not.toHaveProperty("email");
    expect(context).not.toHaveProperty("sensitiveAnswers");
    expect(() => validateAiEssay(state.profile, result)).not.toThrow();
  });

  it("never calls AI to answer authorization, even when asked as an essay", async () => {
    const state = initialDemoState();
    await expect(draftAiEssay(state.profile, state.jobs[0], "Describe your work authorization and why you need visa sponsorship.")).rejects.toThrow(/own answer/);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(["bad-citation", "unsupported-claim", "refusal", "provider-error", "unconfirmed-facts"])("fails closed for %s without accepting human-written fallback essays", async (mode) => {
    const state = initialDemoState();
    if (mode === "bad-citation") { const draft = providerDraft(); draft.output_parsed.sentences[1].factIds = ["invented-id"]; parse.mockResolvedValueOnce(draft); }
    if (mode === "unsupported-claim") parse.mockResolvedValueOnce(providerDraft()).mockResolvedValueOnce({ output_parsed: { grounded: false, unsupportedClaims: ["Invented outcome"] } });
    if (mode === "refusal") parse.mockResolvedValueOnce({ output_parsed: null });
    if (mode === "provider-error") parse.mockRejectedValueOnce(new Error("Unavailable"));
    if (mode === "unconfirmed-facts") state.profile.facts.forEach((f) => { f.verified = false; });
    const result = await draftAiEssay(state.profile, state.jobs[0], question);
    expect(result).toEqual({ question, answer: "", factIds: [], author: "ai", requiresUserInput: true });
  });

  it("preserves valid confirmed essays, human answers and the legacy resume on rebuild", async () => {
    const state = initialDemoState();
    successfulResponses();
    const oldEssay = confirmAiEssay(state.profile, await draftAiEssay(state.profile, state.jobs[0], question));
    const human: ScreeningAnswer = { question: "Which office would you prefer?", answer: "New York", factIds: [], author: "human", userProvided: true, requiresUserInput: false };
    const previous: ApplicationPacket = { schemaVersion: 1, version: 3, model: "fixture", summary: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: state.profile.facts[0].text, factIds: [state.profile.facts[0].id] }], answers: [human, oldEssay] };
    successfulResponses();
    const result = await draftPacket(state.profile, state.jobs[0], previous);
    expect(result.version).toBe(4);
    expect(result.resumeLines).toEqual(previous.resumeLines);
    expect(result.answers[0]).toBe(human);
    expect(result.answers[1].question).toBe(question);
    expect(result.answers[1]).toBe(oldEssay);
    expect(result.answers[1].requiresUserInput).toBe(false);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(await draftEssayAnswers(state.profile, state.jobs[0], [human])).toEqual([human]);
  });
});
