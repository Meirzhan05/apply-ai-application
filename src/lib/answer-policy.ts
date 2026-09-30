import { hashJson } from "@/lib/crypto";
import type { Profile, ScreeningAnswer } from "@/lib/types";
import { answerOwner } from "@/lib/answer-responsibility";
export { answerOwner, answerNeedsAction } from "@/lib/answer-responsibility";

export function essayContentHash(answer: ScreeningAnswer): string {
  return hashJson({ question: answer.question, answer: answer.answer, factIds: answer.factIds, sentences: answer.aiDraft?.sentences });
}

export function essayEvidenceHash(profile: Profile, factIds: string[]): string {
  return hashJson(factIds.map((id) => profile.facts.find((f) => f.id === id && f.verified)).map((f) => f ? { id: f.id, text: f.text } : null));
}

export function validateAiEssay(profile: Profile, answer: ScreeningAnswer): void {
  const draft = answer.aiDraft;
  if (answerOwner(answer.question) !== "ai" || answer.author !== "ai" || answer.userProvided || !draft || draft.version !== 1 ||
    !answer.factIds.length || draft.evidenceHash !== essayEvidenceHash(profile, answer.factIds) ||
    answer.factIds.some((id) => !profile.facts.some((f) => f.id === id && f.verified)) ||
    answer.answer !== draft.sentences.map((s) => s.text).join(" ") || draft.contentHash !== essayContentHash(answer) ||
    draft.sentences.some((s) => !s.text.trim() || (s.kind === "fact" && !s.factIds.length) || s.factIds.some((id) => !answer.factIds.includes(id))) ||
    hashJson([...new Set(draft.sentences.flatMap((s) => s.factIds))]) !== hashJson(answer.factIds))
    throw new Error("This AI essay changed or lost its verified sources. Generate a new draft.");
}

export function confirmAiEssay(profile: Profile, answer: ScreeningAnswer): ScreeningAnswer {
  validateAiEssay(profile, answer);
  return { ...answer, confirmedAt: new Date().toISOString(), requiresUserInput: false };
}

export function applyHumanAnswerEdits(current: ScreeningAnswer[], submitted: ScreeningAnswer[]): ScreeningAnswer[] {
  if (current.length !== submitted.length) throw new Error("The screening questions changed. Reload the packet.");
  return current.map((previous, index) => {
    const next = submitted[index];
    if (next.question !== previous.question) throw new Error("Screening question labels cannot be changed.");
    if (answerOwner(previous.question) === "ai") {
      if (next.answer !== previous.answer || next.userProvided !== previous.userProvided || next.requiresUserInput !== previous.requiresUserInput || hashJson(next.factIds) !== hashJson(previous.factIds))
        throw new Error("AI writes essays. Review and confirm the draft or generate another one.");
      return previous;
    }
    if (next.answer === previous.answer) return previous;
    if (!next.answer.trim()) return { question: previous.question, answer: "", factIds: [], author: "human", requiresUserInput: true };
    // Human-supplied screening answers are confirmed only for this question.
    // They must never become reusable resume facts or essay source material.
    return { question: previous.question, answer: next.answer, factIds: [], author: "human", userProvided: true, requiresUserInput: false };
  });
}
