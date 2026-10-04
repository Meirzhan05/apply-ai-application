import { isUsableFact } from "@/lib/fact-evidence";
import { hashJson } from "@/lib/crypto";
import type { Profile, ScreeningAnswer } from "@/lib/types";
import { answerOwner } from "@/lib/answer-responsibility";
export { answerOwner, answerNeedsAction } from "@/lib/answer-responsibility";

export function essayContentHash(answer: ScreeningAnswer): string {
  return hashJson({ question: answer.question, answer: answer.answer, factIds: answer.factIds, mode: answer.aiDraft?.mode, preferenceSources: answer.aiDraft?.preferenceSources, sentences: answer.aiDraft?.sentences });
}

export function essaySources(profile: Profile, preferenceSources = false): Array<{ id: string; text: string }> {
  const facts = profile.facts.filter((fact) => isUsableFact(fact) && (!preferenceSources || !fact.id.startsWith("profile-preference:"))).map(({ id, text }) => ({ id, text }));
  if (!preferenceSources || !profile.onboarding?.completedAt || profile.automationAuthorization?.status !== "enabled" || profile.automationAuthorization.version !== profile.automationVersion) return facts;
  return [...facts,
    ...(profile.preferredTitles.length ? [{ id: "profile-preference:titles", text: `Preferred role titles: ${profile.preferredTitles.join(", ")}.` }] : []),
    ...(profile.preferredLocations.length ? [{ id: "profile-preference:locations", text: `Preferred locations: ${profile.preferredLocations.join(", ")}.` }] : []),
    { id: "profile-preference:remote", text: profile.remoteOnly ? "Remote roles only." : "Remote-only search restriction: disabled." },
  ];
}

export function essayEvidenceHash(profile: Profile, factIds: string[], preferenceSources = false): string {
  const sources = essaySources(profile, preferenceSources);
  return hashJson(factIds.map((id) => sources.find((fact) => fact.id === id) ?? null));
}

export function validateAiEssay(profile: Profile, answer: ScreeningAnswer): void {
  const draft = answer.aiDraft;
  const sources = essaySources(profile, draft?.preferenceSources);
  if (answerOwner(answer.question) !== "ai" || answer.author !== "ai" || answer.userProvided || !draft || draft.version !== 1 ||
    (!answer.factIds.length && draft.mode !== "general-truthful") || (draft.mode === "general-truthful" && (answer.factIds.length > 0 || draft.sentences.some((sentence) => sentence.kind !== "perspective" || sentence.factIds.length))) || draft.evidenceHash !== essayEvidenceHash(profile, answer.factIds, draft.preferenceSources) ||
    answer.factIds.some((id) => !sources.some((fact) => fact.id === id)) ||
    answer.answer !== draft.sentences.map((s) => s.text).join(" ") || draft.contentHash !== essayContentHash(answer) ||
    draft.sentences.some((s) => !s.text.trim() || (s.kind === "fact" && !s.factIds.length) || s.factIds.some((id) => !answer.factIds.includes(id))) ||
    hashJson([...new Set(draft.sentences.flatMap((s) => s.factIds))]) !== hashJson(answer.factIds))
    throw new Error("This AI essay changed or lost its verified sources. Generate a new draft.");
}

export function confirmAiEssay(profile: Profile, answer: ScreeningAnswer): ScreeningAnswer {
  validateAiEssay(profile, answer);
  return { ...answer, confirmedAt: new Date().toISOString(), requiresUserInput: false };
}

function revisionContentHash(answer: ScreeningAnswer): string {
  return hashJson({ question: answer.question, answer: answer.answer,
    originalAnswer: answer.userRevision?.originalAnswer,
    originalFactIds: answer.userRevision?.originalFactIds,
    originalDraftHash: answer.userRevision?.originalDraftHash });
}

export function validateUserEssay(answer: ScreeningAnswer): void {
  const revision = answer.userRevision;
  if (answerOwner(answer.question) !== "ai" || answer.author !== "human" || !answer.userProvided ||
    answer.aiDraft || answer.factIds.length || !revision || revision.version !== 1 ||
    !answer.answer.trim() || answer.answer.length > 4000 || !revision.originalAnswer.trim() ||
    !/^[a-f0-9]{64}$/.test(revision.originalDraftHash) || revision.contentHash !== revisionContentHash(answer) ||
    (!answer.requiresUserInput && !answer.confirmedAt))
    throw new Error("Your edited essay changed. Save and confirm its current wording.");
}

// Applicant prose remains application-specific, never a verified source claim.
export function reviseEssay(profile: Profile, previous: ScreeningAnswer, text: string): ScreeningAnswer {
  if (previous.userRevision) validateUserEssay(previous);
  else validateAiEssay(profile, previous);
  if (!text.trim() || text.length > 4000) throw new Error("Enter an essay between 1 and 4,000 characters.");
  const answer: ScreeningAnswer = { question: previous.question, answer: text.trim(),
    author: "human", userProvided: true, requiresUserInput: true, factIds: [],
    userRevision: previous.userRevision ? { ...previous.userRevision, contentHash: "" } : {
      version: 1, contentHash: "", originalAnswer: previous.answer,
      originalFactIds: [...previous.factIds], originalDraftHash: previous.aiDraft!.contentHash,
    } };
  answer.userRevision!.contentHash = revisionContentHash(answer);
  validateUserEssay(answer);
  return answer;
}

export function confirmReviewedEssay(profile: Profile, answer: ScreeningAnswer): ScreeningAnswer {
  if (!answer.userRevision) return confirmAiEssay(profile, answer);
  validateUserEssay(answer);
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
