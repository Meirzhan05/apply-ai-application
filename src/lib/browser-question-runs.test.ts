import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { approveFill, selectApplication, setFormSnapshot, setPacket } from "@/lib/workflow";
import { browserQuestions } from "@/lib/browser-questions";
import { withPacketFiles } from "@/lib/packet-files";
import type { AppState, ScreeningAnswer } from "@/lib/types";
import { essayContentHash, essayEvidenceHash } from "@/lib/answer-policy";
import { approveBrowserAnswers } from "@/lib/browser-question-approval";

const mocks = vi.hoisted(() => ({ state: null as AppState | null, fill: vi.fn(), draft: vi.fn(), reserve: vi.fn() }));
vi.mock("@/lib/repository", () => ({ loadState: async () => structuredClone(mocks.state), mutateState: async (_owner: string, change: (state: AppState) => unknown) => change(mocks.state!) }));
vi.mock("@/lib/browser-runner", () => ({ fillApprovedBrowserAnswers: mocks.fill }));
vi.mock("@/lib/essay-drafting", () => ({ draftEssayAnswers: mocks.draft }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: mocks.reserve }));
import { answerBrowserQuestions, reviseBrowserEssay, writeBrowserQuestionEssays } from "@/lib/browser-question-runs";

beforeEach(() => { vi.clearAllMocks(); mocks.state = initialDemoState(); mocks.reserve.mockResolvedValue(true); });
async function fixture() {
  const state = mocks.state!; const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  const fact = state.profile.facts[0];
  setPacket(state, app, await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Existing approved packet", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] }));
  approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl); app.browserSessionId = "saved-session";
  setFormSnapshot(app, { version: 1, capturedAt: new Date().toISOString(), url: state.jobs[0].applyUrl, readyToSubmit: false, blockers: [], attachments: [], fields: [{ identifier: "clearance", label: "Do you hold a secret clearance?", kind: "text", required: true, value: "", valid: false }] });
  return { state, app, inputs: [{ questionId: browserQuestions(app.form)[0].id, value: "No" }] };
}

it("writes all essays when the employer asks more than five", async () => {
  const { state, app } = await fixture();
  setFormSnapshot(app, { ...app.form!, fields: Array.from({ length: 6 }, (_, index) => ({ identifier: `essay-${index}`, label: `Why are you interested in this role? Essay ${index}`, kind: "textarea", required: true, value: "" })) });
  mocks.draft.mockImplementation(async (_profile, _job, answers) => answers.map((answer: ScreeningAnswer) => ({ ...answer, answer: "Grounded essay" })));
  await writeBrowserQuestionEssays(state.profile.id, app.id, app.form!.hash);
  expect(mocks.draft).toHaveBeenCalledOnce();
  expect(mocks.draft.mock.calls[0][2]).toHaveLength(6);
  expect(Object.keys(app.browserQuestionDrafts!.answers)).toHaveLength(6);
  expect(app.browserQuestionRun).toBeUndefined();
});

it("continues in the same session, saves scoped answers, and requires a fresh final approval", async () => {
  const { state, app, inputs } = await fixture(); const packet = structuredClone(app.packet);
  mocks.fill.mockImplementation(async (application) => ({ ...application.form, readyToSubmit: true, fields: application.form.fields.map((field: object) => ({ ...field, value: "No", valid: true })) }));
  await answerBrowserQuestions(state.profile.id, app.id, app.form!.hash, inputs);
  expect(app.status).toBe("final_review"); expect(app.browserSessionId).toBe("saved-session");
  expect(app.browserAnswerApprovals![0].answer.answer).toBe("No");
  expect(app.packet).toEqual(packet); expect(app.browserQuestionRun).toBeUndefined();
  expect(app.approvals.map(approval => approval.kind)).toEqual(["fill"]);
});

it("claims once and refuses concurrent or replayed continuations", async () => {
  const { state, app, inputs } = await fixture();
  mocks.fill.mockImplementation(async application => ({ ...application.form, readyToSubmit: true }));
  const results = await Promise.allSettled([answerBrowserQuestions(state.profile.id, app.id, app.form!.hash, inputs), answerBrowserQuestions(state.profile.id, app.id, app.form!.hash, inputs)]);
  expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(mocks.fill).toHaveBeenCalledOnce();
});

it("preserves the packet and browser on failure and does not overwrite cancellation", async () => {
  const { state, app, inputs } = await fixture(); const packet = structuredClone(app.packet);
  mocks.fill.mockRejectedValueOnce(new Error("A form control changed. Refresh before answering again."));
  await expect(answerBrowserQuestions(state.profile.id, app.id, app.form!.hash, inputs)).rejects.toThrow(/changed/);
  expect(app.status).toBe("needs_user_action"); expect(app.browserQuestionRun).toBeUndefined(); expect(app.packet).toEqual(packet);
  mocks.fill.mockImplementationOnce(async application => { app.status = "cancelled"; return { ...application.form, readyToSubmit: true }; });
  await answerBrowserQuestions(state.profile.id, app.id, app.form!.hash, inputs);
  expect(app.status).toBe("cancelled");
});

it("bounds AI spending and clears its lock while preserving the user's form", async () => {
  const { state, app } = await fixture();
  app.form!.fields = [{ identifier: "why", label: "Why are you excited to join us?", kind: "textarea", required: true, value: "" }];
  mocks.reserve.mockResolvedValueOnce(false);
  await expect(writeBrowserQuestionEssays(state.profile.id, app.id, app.form!.hash)).rejects.toThrow(/spending limit/);
  expect(mocks.draft).not.toHaveBeenCalled(); expect(app.browserQuestionRun).toBeUndefined();
  expect(app.status).toBe("needs_user_action"); expect(app.browserSessionId).toBe("saved-session");
});

it("scopes essay revisions to the saved browser draft and rejects stale, cross-owner and replayed edits", async () => {
  const { state, app } = await fixture();
  app.form!.fields = [{ identifier: "why", label: "Why are you excited to join us?", kind: "textarea", required: true, value: "" }];
  const question = browserQuestions(app.form)[0];
  const fact = state.profile.facts[0];
  const answer: ScreeningAnswer = { question: question.label, answer: fact.text, author: "ai", factIds: [fact.id], requiresUserInput: true,
    aiDraft: { version: 1, model: "fixture", contentHash: "", evidenceHash: essayEvidenceHash(state.profile, [fact.id]), sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }] } };
  answer.aiDraft!.contentHash = essayContentHash(answer);
  app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId!, packetHash: app.packetHash!, answers: { [question.id]: answer } };
  const bindings = { sessionId: app.browserSessionId!, packetHash: app.packetHash! };
  const before = structuredClone(app.packet);
  const facts = structuredClone(state.profile.facts);
  await expect(reviseBrowserEssay(state.profile.id, app.id, "stale", question.id, answer.aiDraft!.contentHash, "My revision", bindings)).rejects.toThrow(/changed/);
  await expect(reviseBrowserEssay("another-owner", app.id, app.form!.hash, question.id, answer.aiDraft!.contentHash, "My revision", bindings)).rejects.toThrow(/not found/);
  await expect(reviseBrowserEssay(state.profile.id, app.id, app.form!.hash, question.id, answer.aiDraft!.contentHash, "My revision", { ...bindings, sessionId: "stale-session" })).rejects.toThrow(/changed/);
  await reviseBrowserEssay(state.profile.id, app.id, app.form!.hash, question.id, answer.aiDraft!.contentHash, "I want to bring my survey experience to this team.", bindings);
  const revised = app.browserQuestionDrafts.answers[question.id];
  expect(revised).toMatchObject({ author: "human", userProvided: true, requiresUserInput: true, factIds: [] });
  expect(revised.confirmedAt).toBeUndefined();
  await expect(reviseBrowserEssay(state.profile.id, app.id, app.form!.hash, question.id, answer.aiDraft!.contentHash, "Replay", bindings)).rejects.toThrow(/changed/);
  expect(() => approveBrowserAnswers(app, state.profile, app.form!.hash, [{ questionId: question.id, confirmEssay: true, answerHash: answer.aiDraft!.contentHash }])).toThrow(/current AI essay/);
  const approved = approveBrowserAnswers(app, state.profile, app.form!.hash, [{ questionId: question.id, confirmEssay: true, answerHash: revised.userRevision!.contentHash }]);
  expect(approved[0].answer.answer).toBe(revised.answer);
  expect(approved[0].answer.confirmedAt).toBeTruthy();
  expect(app.packet).toEqual(before);
  expect(state.profile.facts).toEqual(facts);
  expect(mocks.fill).not.toHaveBeenCalled();
  expect(app.approvals.map((approval) => approval.kind)).toEqual(["fill"]);
});
