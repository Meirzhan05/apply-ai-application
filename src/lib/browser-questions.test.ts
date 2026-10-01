import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { draftPacket } from "@/lib/drafting";
import { approveFill, selectApplication, setFormSnapshot, setPacket } from "@/lib/workflow";
import { browserQuestions, browserTakeoverReasons } from "@/lib/browser-questions";
import { approveBrowserAnswers } from "@/lib/browser-question-approval";
import { essayContentHash, essayEvidenceHash } from "@/lib/answer-policy";
import type { FormSnapshot, ScreeningAnswer } from "@/lib/types";

async function fixture() {
  const state = initialDemoState();
  const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  const packet = await draftPacket(state.profile, state.jobs[0]); packet.answers = [];
  setPacket(state, app, packet); approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
  app.browserSessionId = "synthetic-session";
  setFormSnapshot(app, { version: 1, url: state.jobs[0].applyUrl, fields: [{ identifier: "sponsorship", label: "Will you now or in the future require visa sponsorship?", kind: "select", required: true, valid: false, value: "", options: ["Yes", "No"] }], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: false, blockers: [] });
  return { state, app, profile: state.profile, question: browserQuestions(app.form)[0] };
}

describe("questions inside Apply", () => {
  it("asks missing required questions once, keeps optional blanks and browser challenges separate", () => {
    const form: FormSnapshot = { version: 1, url: "https://employer.test/apply", capturedAt: "now", hash: "form", attachments: [], readyToSubmit: false, fields: [
      { identifier: "office", label: "Preferred office", kind: "radio", required: true, value: "San Francisco", checked: false },
      { identifier: "office", label: "Preferred office", kind: "radio", required: true, value: "New York", checked: false },
      { identifier: "pronunciation", label: "Name pronunciation", kind: "text", value: "" },
      { identifier: "password", label: "Password", kind: "password", value: "" },
      { identifier: "resume", label: "Resume", kind: "file", required: true, value: "" },
      { identifier: "why", label: "Why are you excited to join us?", kind: "textarea", required: true, value: "" },
    ], blockers: ["Correct or complete the field: Preferred office", "Correct or complete the field: Why are you excited to join us?", "CAPTCHA requires your takeover."] };
    expect(browserQuestions(form).map((question) => [question.label, question.owner])).toEqual([["Preferred office", "human"], ["Why are you excited to join us?", "ai"]]);
    expect(browserQuestions(form)[0].options).toEqual(["San Francisco", "New York"]);
    expect(browserTakeoverReasons(form)).toEqual(["CAPTCHA requires your takeover."]);
    form.fields[1].checked = true;
    expect(browserQuestions(form)).toHaveLength(1);
  });

  it("records explicit authorization answers scoped to this form without creating profile facts", async () => {
    const { app, profile, question } = await fixture(); const before = structuredClone(profile);
    const approvals = approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, value: "No" }]);
    expect(approvals[0]).toMatchObject({ userId: profile.id, sessionId: app.browserSessionId, formHash: app.form!.hash, packetHash: app.packetHash, answer: { answer: "No", author: "human", userProvided: true, factIds: [] } });
    expect(profile).toEqual(before);
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, value: "Not now, I can do OPT" }])).toThrow(/exact option/);
  });

  it("requires explicit agreement for a required checkbox without inventing employer options", async () => {
    const { app, profile } = await fixture();
    setFormSnapshot(app, { ...app.form!, fields: [{ identifier: "consent", label: "Accept application terms", kind: "checkbox", required: true, checked: false, value: "on", valid: false }] });
    const question = browserQuestions(app.form)[0];
    expect(question.options).toEqual([]);
    expect(question.owner).toBe("human");
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, value: "No" }])).toThrow(/exact option/);
    expect(approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, value: "Yes" }])[0].answer.answer).toBe("Yes");
    app.form!.fields[0].checked = true;
    expect(browserQuestions(app.form)).toEqual([]);
  });

  it("rejects stale forms, cross-user requests, duplicate/unknown questions, active runs and expired sessions", async () => {
    const { app, profile, question } = await fixture(); const input = { questionId: question.id, value: "No" };
    expect(() => approveBrowserAnswers(app, profile, "stale", [input])).toThrow(/changed/);
    expect(() => approveBrowserAnswers(app, { ...profile, id: "another-owner" }, app.form!.hash, [input])).toThrow(/changed/);
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [input, input])).toThrow(/once/);
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [{ ...input, questionId: "invented" }])).toThrow(/changed/);
    app.browserQuestionRun = { token: "active", kind: "answers", startedAt: new Date().toISOString() };
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [input])).toThrow(/changed/);
    app.browserQuestionRun = undefined; app.browserSessionExpiresAt = new Date(Date.now() - 1).toISOString();
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [input])).toThrow(/changed/);
  });

  it("requires confirmation of the exact grounded AI draft and rejects human-written replacements", async () => {
    const { app, profile } = await fixture();
    app.form!.fields = [{ identifier: "why", label: "Why are you excited to join us?", kind: "textarea", required: true, value: "" }];
    const question = browserQuestions(app.form)[0]; const fact = profile.facts.find((item) => item.verified)!;
    const answer: ScreeningAnswer = { question: question.label, answer: fact.text, author: "ai", requiresUserInput: true, factIds: [fact.id], aiDraft: { version: 1, model: "synthetic", contentHash: "", evidenceHash: essayEvidenceHash(profile, [fact.id]), sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }] } };
    answer.aiDraft!.contentHash = essayContentHash(answer);
    app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId!, packetHash: app.packetHash!, answers: { [question.id]: answer } };
    const approved = approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, confirmEssay: true, answerHash: answer.aiDraft!.contentHash }]);
    expect(approved[0].answer.confirmedAt).toBeTruthy();
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, confirmEssay: true, answerHash: "old-draft" }])).toThrow(/current AI essay/);
    expect(() => approveBrowserAnswers(app, profile, app.form!.hash, [{ questionId: question.id, value: "Invented prose", confirmEssay: true }])).toThrow(/current AI essay/);
  });
});
