import { z } from "zod";
import type { OnboardingQuestionnaire } from "@/lib/types";

const declaration = z.enum(["yes", "no", "unknown"]).optional();

// Partial drafts are valid; required answers are checked at final completion.
export const onboardingQuestionnaireSchema = z.object({
  immigrationStatus: z.enum(["us-citizen", "permanent-resident", "visa-holder", "other"]).optional(),
  visaType: z.string().trim().max(200).optional(),
  immigrationStatusDetails: z.string().trim().max(500).optional(),
  workAuthorization: declaration,
  sponsorshipNow: declaration,
  sponsorshipFuture: declaration,
  requiresSponsorship: declaration,
  availability: z.string().max(200).optional(),
  graduationYear: z.string().max(20).optional(),
});

export function immigrationQuestionnaireMissingFields(questionnaire: OnboardingQuestionnaire): string[] {
  const missing: string[] = [];
  if (!questionnaire.immigrationStatus) missing.push("immigrationStatus");
  if (questionnaire.immigrationStatus === "visa-holder" && !questionnaire.visaType?.trim()) missing.push("visaType");
  if (questionnaire.immigrationStatus === "other" && !questionnaire.immigrationStatusDetails?.trim()) missing.push("immigrationStatusDetails");
  for (const key of ["workAuthorization", "sponsorshipNow", "sponsorshipFuture"] as const) {
    if (!questionnaire[key] || questionnaire[key] === "unknown") missing.push(key);
  }
  return missing;
}
