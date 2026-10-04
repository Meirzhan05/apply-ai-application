// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BrowserQuestionsDialog } from "@/app/browser-questions-dialog";
import { browserQuestions } from "@/lib/browser-questions";
import { initialDemoState } from "@/lib/demo-data";
import { essayContentHash, essayEvidenceHash } from "@/lib/answer-policy";
import type { Application, ScreeningAnswer } from "@/lib/types";

it("shows the essay question and keeps a blank LinkedIn answer separate through confirmation", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  const state = initialDemoState();
  const fact = state.profile.facts.find(item => item.verified)!;
  const fullQuestion = "Tell us more: Tell us about something you built that no one asked you to. What was it, why did you build it, and what did you learn?";
  const app: Application = { id: "synthetic-app", userId: state.profile.id, jobId: state.jobs[0].id, status: "needs_user_action", approvals: [], createdAt: "now", updatedAt: "now", browserSessionId: "synthetic-browser", packetHash: "packet",
    form: { version: 1, hash: "form", url: "https://jobs.example/apply", attachments: [], capturedAt: "now", readyToSubmit: false, fields: [
      { identifier: "essay", label: fullQuestion, kind: "textarea", required: true, value: "", valid: false },
      { identifier: "linkedin", label: "LinkedIn", kind: "text", required: true, value: "", valid: false },
      { identifier: "location", label: "Are you based in US or Canada?", kind: "yesno", options: ["Yes", "No"], required: true, value: "", valid: false },
    ] } };
  const questions = browserQuestions(app.form), essay = questions[0];
  const draft: ScreeningAnswer = { question: fullQuestion, answer: fact.text, author: "ai", factIds: [fact.id], requiresUserInput: true,
    aiDraft: { version: 1, model: "fixture", evidenceHash: essayEvidenceHash(state.profile, [fact.id]), contentHash: "", sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }] } };
  draft.aiDraft!.contentHash = essayContentHash(draft);
  app.browserQuestionDrafts = { formHash: "form", sessionId: "synthetic-browser", packetHash: "packet", answers: { [essay.id]: draft } };
  const actRequest = vi.fn().mockResolvedValue({ ok: true });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<BrowserQuestionsDialog application={app} busy="" error="" facts={state.profile.facts} act={actRequest} />));
    expect(container.textContent).toContain(fullQuestion);
    const sections = Array.from(container.querySelectorAll(".browser-question"));
    const linkedin = sections[1].querySelector("input")!;
    expect(linkedin.value).toBe("");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(linkedin, "https://www.linkedin.com/in/synthetic-applicant");
    await act(async () => linkedin.dispatchEvent(new Event("input", { bubbles: true })));
    const select = sections[2].querySelector("select")!;
    await act(async () => { select.value = "No"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => sections[0].querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(actRequest).toHaveBeenCalledWith("answerBrowserQuestions", { applicationId: app.id, formHash: "form", answers: [
      { questionId: essay.id, confirmEssay: true, answerHash: draft.aiDraft!.contentHash },
      { questionId: questions[1].id, value: "https://www.linkedin.com/in/synthetic-applicant" },
      { questionId: questions[2].id, value: "No" },
    ] });
  } finally {
    await act(async () => root.unmount()); container.remove();
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  }
});
