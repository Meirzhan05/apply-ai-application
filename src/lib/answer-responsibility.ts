import type { ScreeningAnswer } from "@/lib/types";

export function answerOwner(question: string): "human" | "ai" {
  if (/authoriz|sponsor|visa|citizenship|immigration|eligible.*work|consent|transcri|metaview|record.*interview|office|relocat|location|pron[ou]+nci|pronoun|gender|ethnic|disab|veteran|race\b|salary|compensation|hear about|first.*name|last.*name|preferred.*name|email|phone|linkedin|github|website|graduation|university|school|gpa/i.test(question)) return "human";
  return /motivat|why.*(?:interest|excit|join|apply|want|work)|what qualities|(?:describe|tell|share).*(?:experience|project|challenge|achievement|yourself)|relevant experience|how.*(?:skills|experienc|background)|what.*(?:bring|contribut)/i.test(question) ? "ai" : "human";
}

export function answerNeedsAction(answer: ScreeningAnswer): boolean {
  return !answer.answer.trim() || answer.requiresUserInput ||
    (answerOwner(answer.question) === "ai" && (!answer.aiDraft || !answer.confirmedAt));
}
