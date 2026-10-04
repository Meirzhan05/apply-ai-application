import type { ScreeningAnswer } from "@/lib/types";

export function answerOwner(question: string): "human" | "ai" {
  if (/authoriz|sponsor|visa|citizenship|immigration|eligible.*work|\bage\b|birth|certif|licen[cs]e|availability|available.*start|start.*date|earliest.*start|background.*check|criminal|felony|privacy|terms.*(?:agree|accept)|cover\s*letter|consent|transcri|metaview|record.*interview|office|relocat|location|pron[ou]+nci|pronoun|gender|ethnic|disab|veteran|race\b|salary|compensation|hear about|first.*name|last.*name|preferred.*name|email|phone|linkedin|github|website|graduation|university|school|gpa/i.test(question)) return "human";
  return /motivat|why\s+(?:us|(?:this|the|your)\s+(?:company|role|team|position|opportunity))\b|why.*(?:interest|excit|join|apply|want|work)|what qualities|(?:describe|tell|share).*(?:experience|project|challenge|achievement|yourself|something you (?:built|created|made|developed))|relevant experience|how.*(?:skills|experienc|background)|what.*(?:bring|contribut)/i.test(question) ? "ai" : "human";
}

export function answerNeedsAction(answer: ScreeningAnswer): boolean {
  return !answer.answer.trim() || answer.requiresUserInput ||
    (answerOwner(answer.question) === "ai" && (!answerReviewHash(answer) || !answer.confirmedAt));
}

export function answerReviewHash(answer: ScreeningAnswer): string | undefined {
  return answer.userRevision?.contentHash ?? answer.aiDraft?.contentHash;
}
