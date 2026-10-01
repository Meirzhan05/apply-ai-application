import { newId } from "@/lib/crypto";
import { loadState, mutateState } from "@/lib/repository";
import { browserQuestions } from "@/lib/browser-questions";
import { approveBrowserAnswers, assertQuestionSession, type BrowserAnswerInput } from "@/lib/browser-question-approval";
import { fillApprovedBrowserAnswers } from "@/lib/browser-runner";
import { draftEssayAnswers } from "@/lib/essay-drafting";
import { packetProfileHash } from "@/lib/drafting";
import { reserveServiceBudget } from "@/lib/budget";
import { setFormSnapshot, transition } from "@/lib/workflow";
import type { AppState } from "@/lib/types";

function find(state: AppState, userId: string, applicationId: string) {
  const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
  if (!app) throw new Error("Application not found.");
  return app;
}

export async function writeBrowserQuestionEssays(userId: string, applicationId: string, formHash: string) {
  const token = newId();
  const state = await loadState(userId);
  const app = find(state, userId, applicationId);
  assertQuestionSession(app, state.profile, formHash);
  const questions = browserQuestions(app.form).filter((question) => question.owner === "ai");
  if (!questions.length) return;
  if (questions.length > 5) throw new Error("This form needs more than five essays. Review its questions before continuing.");
  const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
  if (!job?.active) throw new Error("The job is closed or unavailable.");
  await mutateState(userId, (current) => {
    const target = find(current, userId, applicationId);
    assertQuestionSession(target, current.profile, formHash);
    target.browserQuestionRun = { token, kind: "essays", startedAt: new Date().toISOString() };
    target.updatedAt = new Date().toISOString();
    target.error = undefined;
  });
  try {
    if (!await reserveServiceBudget(userId, `browser-essays:${applicationId}:${token}`, Number(process.env.PROJECTED_DRAFT_USD || "0.20")))
      throw new Error("AI drafting is paused at the service spending limit. Your answers and browser are saved; try again later.");
    const drafts = await draftEssayAnswers(state.profile, job, questions.map((question) => ({
      question: question.label, answer: "", factIds: [], author: "ai", requiresUserInput: true,
    })));
    await mutateState(userId, (current) => {
      const target = find(current, userId, applicationId);
      if (target.browserQuestionRun?.token !== token) return;
      target.browserQuestionRun = undefined;
      if (target.status !== "needs_user_action" || target.form?.hash !== formHash ||
        target.browserSessionId !== app.browserSessionId || target.packetHash !== app.packetHash ||
        packetProfileHash(current.profile) !== packetProfileHash(state.profile)) return;
      target.browserQuestionDrafts = { formHash, sessionId: app.browserSessionId!, packetHash: app.packetHash!,
        answers: Object.fromEntries(questions.map((question, index) => [question.id, drafts[index]])) };
      if (drafts.some((draft) => !draft.aiDraft)) target.error = "An essay could not be grounded in your confirmed facts. Check your profile facts, then retry AI drafting.";
    });
  } catch (error) {
    await mutateState(userId, (current) => {
      const target = find(current, userId, applicationId);
      if (target.browserQuestionRun?.token === token) {
        target.browserQuestionRun = undefined;
        if (target.status === "needs_user_action") target.error = error instanceof Error ? error.message : "AI drafting paused. Try again.";
      }
    });
    throw error;
  }
}

export async function answerBrowserQuestions(userId: string, applicationId: string, formHash: string, inputs: BrowserAnswerInput[]) {
  const token = newId();
  const approvals = await mutateState(userId, (state) => {
    const app = find(state, userId, applicationId);
    const records = approveBrowserAnswers(app, state.profile, formHash, inputs);
    app.browserAnswerApprovals = [...(app.browserAnswerApprovals ?? []), ...records].slice(-200);
    app.approvals = app.approvals.filter((approval) => approval.kind !== "submit");
    app.browserQuestionRun = { token, kind: "answers", startedAt: new Date().toISOString() };
    app.error = undefined;
    transition(app, ["needs_user_action"], "filling");
    return records;
  });
  try {
    const state = await loadState(userId);
    const app = find(state, userId, applicationId);
    const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
    if (!job?.active) throw new Error("The job is closed or unavailable.");
    const active = async () => {
      const latest = await loadState(userId);
      const target = find(latest, userId, applicationId);
      return target.status === "filling" && target.browserQuestionRun?.token === token &&
        target.browserSessionId === app.browserSessionId && target.packetHash === app.packetHash &&
        packetProfileHash(latest.profile) === packetProfileHash(state.profile);
    };
    const form = await fillApprovedBrowserAnswers(app, job, state.profile, approvals, active);
    await mutateState(userId, (current) => {
      const target = find(current, userId, applicationId);
      if (target.status !== "filling" || target.browserQuestionRun?.token !== token) return;
      target.browserQuestionRun = undefined;
      target.browserQuestionDrafts = undefined;
      setFormSnapshot(target, form);
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: form.readyToSubmit === false ? "More input needed" : "Form ready for review", detail: job.title });
    });
  } catch (error) {
    await mutateState(userId, (current) => {
      const target = find(current, userId, applicationId);
      if (target.status === "filling" && target.browserQuestionRun?.token === token) {
        target.browserQuestionRun = undefined;
        transition(target, ["filling"], "needs_user_action");
        target.error = error instanceof Error ? error.message : "The agent paused. Refresh the form to continue.";
      }
    });
    throw error;
  }
}
