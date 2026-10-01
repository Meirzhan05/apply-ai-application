import { browserQuestions } from "@/lib/browser-questions";
import { hashJson } from "@/lib/crypto";
import { essayContentHash, validateAiEssay } from "@/lib/answer-policy";
import { answerOwner } from "@/lib/answer-responsibility";
import { assertAutomationEnabled, autonomyJobHash, autonomyProfileHash } from "@/lib/autonomous-policy";
import { draftAiEssay } from "@/lib/essay-drafting";
import type { Application, FormFieldSnapshot, Job, Profile, ScreeningAnswer, FormSnapshot, BrowserQuestion } from "@/lib/types";

export function assertAutonomousEssay(profile: Profile, job: Job, answer: ScreeningAnswer): void {
  assertAutomationEnabled(profile);
  validateAiEssay(profile, answer);
  const seal = answer.autonomousEssayAuthorization;
  if (!seal || seal.version !== 1 || seal.profileVersion !== profile.automationVersion ||
      seal.profileHash !== autonomyProfileHash(profile) || seal.jobHash !== autonomyJobHash(job) || seal.targetUrl !== job.applyUrl ||
      seal.questionHash !== hashJson(answer.question) || seal.contentHash !== essayContentHash(answer) || seal.evidenceHash !== answer.aiDraft!.evidenceHash)
    throw new Error("The automatic essay changed or lost its current authorization.");
}

export async function draftAutonomousEssays(profile: Profile, job: Job, questions: ScreeningAnswer[], beforeModelCall: () => Promise<void>, deadline = Date.now() + 200_000): Promise<ScreeningAnswer[]> {
  if (questions.length > 5) throw new Error("This form requires more than five essays.");
  const answers: ScreeningAnswer[] = [];
  for (const question of questions) {
    if (answerOwner(question.question) !== "ai") throw new Error("A required factual or sensitive question needs a confirmed applicant answer.");
    await beforeModelCall();
    if (question.autonomousEssayAuthorization) {
      assertAutonomousEssay(profile, job, question); answers.push(structuredClone(question)); continue;
    }
    const answer = await draftAiEssay(profile, job, question.question, deadline, { automatic: true, beforeModelCall });
    if (!answer.aiDraft) throw new Error("An automatic essay could not be grounded truthfully. No answer was submitted.");
    answer.autonomousEssayAuthorization = { version: 1, profileVersion: profile.automationVersion!, profileHash: autonomyProfileHash(profile), jobHash: autonomyJobHash(job), targetUrl: job.applyUrl, questionHash: hashJson(answer.question), contentHash: essayContentHash(answer), evidenceHash: answer.aiDraft.evidenceHash };
    assertAutonomousEssay(profile, job, answer);
    answers.push(answer);
  }
  await beforeModelCall();
  return answers;
}

export function essayFormStructureHash(fields: FormFieldSnapshot[]): string {
  return hashJson(fields.map(({ identifier, kind, label, required, options, editable, autocomplete }) => ({ identifier, kind, label, required, options, editable, autocomplete })));
}

export function hasBoundAutonomousEssayControl(application: Application | undefined, field: FormFieldSnapshot, fields: FormFieldSnapshot[]): boolean {
  const answer = application?.packet?.answers.find((item) => item.autonomousEssayAuthorization?.control?.identifier === field.identifier && item.question.trim().toLowerCase() === field.label.trim().toLowerCase());
  const control = answer?.autonomousEssayAuthorization?.control;
  return Boolean(control && control.sessionId === application?.browserSessionId && control.identifier === field.identifier && control.kind === field.kind && control.label === field.label && control.formStructureHash === essayFormStructureHash(fields) && control.observedFormHash && fields.filter((item) => item.identifier === field.identifier).length === 1);
}

export function automaticEssayQuestions(application: Application, form: Omit<FormSnapshot, "hash">): BrowserQuestion[] {
  const questions = browserQuestions({ ...form, readyToSubmit: false, hash: "observed" }).filter((question) => question.owner === "ai");
  // A new conditional control can change the structure after an earlier essay
  // was filled. Rebind that exact authorized value without generating it again.
  for (const field of form.fields) {
    if (!field.required || !field.identifier || !["text", "textarea"].includes(field.kind) || answerOwner(field.label) !== "ai" || form.fields.filter((item) => item.identifier === field.identifier).length !== 1) continue;
    const answer = application.packet?.answers.find((item) => item.question === field.label && item.answer === field.value && item.autonomousEssayAuthorization?.control?.identifier === field.identifier);
    if (answer && !questions.some((question) => question.identifier === field.identifier)) questions.push({ id: JSON.stringify([field.identifier, field.kind, field.label]), identifier: field.identifier, kind: field.kind, label: field.label, owner: "ai", options: [], value: field.value });
  }
  return questions;
}

export async function prepareAutonomousFormEssays(profile: Profile, job: Job, application: Application, form: Omit<FormSnapshot, "hash">, beforeModelCall: () => Promise<void>): Promise<NonNullable<Application["packet"]>> {
  const { formDigest } = await import("@/lib/workflow");
  const questions = automaticEssayQuestions(application, form);
  if (!questions.length || questions.some((question) => !["text", "textarea"].includes(question.kind) || /cover\s*letter/i.test(question.label))) throw new Error("No supported automatic essay is awaiting an answer.");
  const pending = questions.map((question) => application.packet!.answers.find((answer) => answer.question === question.label && (!answer.autonomousEssayAuthorization?.control || answer.autonomousEssayAuthorization.control.identifier === question.identifier)) ?? { question: question.label, answer: "", factIds: [], requiresUserInput: true, author: "ai" as const });
  if (application.packet!.answers.filter((answer) => !questions.some((question) => question.label === answer.question)).length + questions.length > 5) throw new Error("This form requires more than five essays.");
  const drafts = await draftAutonomousEssays(profile, job, pending, beforeModelCall);
  const bound = drafts.map((answer, index) => ({ ...answer, autonomousEssayAuthorization: { ...answer.autonomousEssayAuthorization!, control: { identifier: questions[index].identifier, kind: questions[index].kind, label: questions[index].label, formStructureHash: essayFormStructureHash(form.fields), observedFormHash: formDigest(form), sessionId: application.browserSessionId! } } }));
  const replaced = new Set(bound.map((answer) => answer.question));
  return { ...application.packet!, version: application.packet!.version + 1, createdAt: new Date().toISOString(), answers: [...application.packet!.answers.filter((answer) => !replaced.has(answer.question)), ...bound] };
}

export function hasAutonomousEssayValue(application: Application | undefined, field: FormFieldSnapshot, fields: FormFieldSnapshot[]): boolean {
  if (!application?.autonomousAuthorization || answerOwner(field.label) !== "ai" || !["text", "textarea"].includes(field.kind) || !field.identifier || fields.filter((item) => item.identifier === field.identifier).length !== 1) return false;
  const answer = application.packet?.answers.find((item) => item.autonomousEssayAuthorization?.control?.identifier === field.identifier && item.question.trim().toLowerCase() === field.label.trim().toLowerCase());
  return Boolean(hasBoundAutonomousEssayControl(application, field, fields) && answer?.autonomousEssayAuthorization && answer.answer === field.value && answer.aiDraft && answer.autonomousEssayAuthorization.contentHash === essayContentHash(answer));
}
