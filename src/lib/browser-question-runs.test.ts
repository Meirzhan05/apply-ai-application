import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { approveFill, selectApplication, setFormSnapshot, setPacket } from "@/lib/workflow";
import { browserQuestions } from "@/lib/browser-questions";
import { withPacketFiles } from "@/lib/packet-files";
import type { AppState } from "@/lib/types";

const mocks = vi.hoisted(() => ({ state: null as AppState | null, fill: vi.fn(), draft: vi.fn(), reserve: vi.fn() }));
vi.mock("@/lib/repository", () => ({ loadState: async () => structuredClone(mocks.state), mutateState: async (_owner: string, change: (state: AppState) => unknown) => change(mocks.state!) }));
vi.mock("@/lib/browser-runner", () => ({ fillApprovedBrowserAnswers: mocks.fill }));
vi.mock("@/lib/essay-drafting", () => ({ draftEssayAnswers: mocks.draft }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: mocks.reserve }));
import { answerBrowserQuestions, writeBrowserQuestionEssays } from "@/lib/browser-question-runs";

beforeEach(() => { vi.clearAllMocks(); mocks.state = initialDemoState(); mocks.reserve.mockResolvedValue(true); });
async function fixture() {
  const state = mocks.state!; const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  const fact = state.profile.facts[0];
  setPacket(state, app, await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Existing approved packet", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] }));
  approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl); app.browserSessionId = "saved-session";
  setFormSnapshot(app, { version: 1, capturedAt: new Date().toISOString(), url: state.jobs[0].applyUrl, readyToSubmit: false, blockers: [], attachments: [], fields: [{ identifier: "clearance", label: "Do you hold a secret clearance?", kind: "text", required: true, value: "", valid: false }] });
  return { state, app, inputs: [{ questionId: browserQuestions(app.form)[0].id, value: "No" }] };
}

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
