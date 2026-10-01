import { browserQuestions } from "@/lib/browser-questions";
import { confirmAiEssay } from "@/lib/answer-policy";
import { hasFillApproval } from "@/lib/workflow";
import { validatePacket } from "@/lib/drafting";
import type { Application, BrowserAnswerApproval, Profile } from "@/lib/types";

export interface BrowserAnswerInput { questionId: string; value?: string; confirmEssay?: boolean; answerHash?: string }

export function assertQuestionSession(app: Application, profile: Profile, formHash: string): void {
  if (app.userId !== profile.id || app.status !== "needs_user_action" || app.browserQuestionRun || !app.form ||
    app.form.hash !== formHash || !app.browserSessionId || app.submissionStartedAt || app.submissionAttemptedAt ||
    app.submittedAt || app.submissionReceipt || (app.manualSubmissionReport && !app.manualSubmissionReport.resolution) ||
    (app.browserSessionExpiresAt && Date.parse(app.browserSessionExpiresAt) <= Date.now()) ||
    !hasFillApproval(app, profile.id, app.jobSnapshot?.applyUrl))
    throw new Error("The browser or form changed. Refresh its current state before answering.");
  validatePacket(profile, app.packet!);
}

export function approveBrowserAnswers(app: Application, profile: Profile, formHash: string, inputs: BrowserAnswerInput[]): BrowserAnswerApproval[] {
  assertQuestionSession(app, profile, formHash);
  const questions = browserQuestions(app.form);
  if (!questions.length || questions.length > 20 || inputs.length !== questions.length || new Set(inputs.map((input) => input.questionId)).size !== inputs.length)
    throw new Error("Answer each current question once before continuing.");
  return questions.map((question) => {
    const input = inputs.find((item) => item.questionId === question.id);
    if (!input) throw new Error("The questions changed. Review them again.");
    let answer;
    if (question.owner === "ai") {
      const drafts = app.browserQuestionDrafts;
      if (!input.confirmEssay || input.value !== undefined || drafts?.formHash !== formHash ||
        drafts.sessionId !== app.browserSessionId || drafts.packetHash !== app.packetHash || !drafts.answers[question.id] ||
        drafts.answers[question.id].question !== question.label || input.answerHash !== drafts.answers[question.id].aiDraft?.contentHash)
        throw new Error("Review and confirm the current AI essay before continuing.");
      answer = confirmAiEssay(profile, drafts.answers[question.id]);
    } else {
      const value = input.value?.trim();
      if (!value || value.length > 4000 || (question.kind === "checkbox" && value !== "Yes") || (question.options.length && !question.options.includes(value)))
        throw new Error(`Enter an answer or choose an exact option for: ${question.label}`);
      answer = { question: question.label, answer: value, factIds: [], author: "human" as const, userProvided: true, requiresUserInput: false };
    }
    return { version: 1, userId: profile.id, applicationId: app.id, targetUrl: app.form!.url, sessionId: app.browserSessionId!, packetHash: app.packetHash!,
      formHash, question, answer, approvedAt: new Date().toISOString() };
  });
}
