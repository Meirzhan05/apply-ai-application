import { z } from "zod";
import { hashJson } from "@/lib/crypto";
import { applyFactCorrection } from "@/lib/fact-corrections";
import { locationFit } from "@/lib/location-fit";
import { bumpAutomationVersion, ensureOnboardingDefaults, saveOnboarding } from "@/lib/onboarding";
import { immigrationQuestionnaireMissingFields, onboardingQuestionnaireSchema } from "@/lib/onboarding-questionnaire";
import { normalizeProfileLinks } from "@/lib/resume-profile-basics";
import type { Profile, VerifiedFact } from "@/lib/types";

export const RESUME_ONBOARDING_VERSION = 2;
export const onboardingDraftSchema = z.object({
  name: z.string().trim().max(200).optional(), email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(100).optional(), links: z.array(z.string().max(2048)).max(20).optional(),
  currentLocation: z.object({ city: z.string().trim().max(120), region: z.string().trim().max(120), country: z.string().trim().max(120) }).optional(),
  preferredLocations: z.array(z.string().trim().max(160)).max(30).optional(),
  workArrangements: z.array(z.enum(["remote", "hybrid", "on-site"])).max(3).optional(),
  willingToRelocate: z.boolean().nullable().optional(), questionnaire: onboardingQuestionnaireSchema.optional(),
  factPatch: z.unknown().optional(), expectedReviewHash: z.string().length(64).optional(),
  stage: z.enum(["resume", "profile", "answers", "review"]).optional(),
});

export function importedOnboardingFacts(profile: Profile): VerifiedFact[] {
  const anchors = new Set(profile.resumeSourceDocument?.anchors.map(anchor => anchor.id) ?? []);
  return profile.facts.filter(fact => fact.source === "resume" && fact.sourceAnchorId && anchors.has(fact.sourceAnchorId));
}

function reviewHash(profile: Profile): string {
  return hashJson({
    owner: profile.id, version: RESUME_ONBOARDING_VERSION,
    source: profile.resumeSource?.sha256, document: profile.resumeSourceDocument?.sourceHash,
    resumeImport: profile.resumeImport, resumeText: profile.resumeSourceDocument?.text,
    name: profile.name, email: profile.email, phone: profile.phone, links: profile.links,
    facts: importedOnboardingFacts(profile), currentLocation: profile.currentLocation,
    preferredLocations: profile.preferredLocations, workArrangements: profile.workArrangements,
    willingToRelocate: profile.willingToRelocate, questionnaire: profile.onboarding?.questionnaire,
  });
}

export function resumeOnboardingStatus(profile: Profile) {
  ensureOnboardingDefaults(profile);
  const missing: string[] = [];
  const source = profile.resumeSource;
  const document = profile.resumeSourceDocument;
  if (!source?.sha256 || !source.size || !profile.resumeFileName || !document?.text.trim() || document.sourceHash !== source.sha256) missing.push("resume");
  if (profile.resumeImport) missing.push("resumeImport");
  if (!profile.name.trim()) missing.push("name");
  if (!z.email().safeParse(profile.email.trim()).success) missing.push("email");
  if (!profile.phone.trim()) missing.push("phone");
  for (const key of ["city", "region", "country"] as const) if (!profile.currentLocation?.[key].trim()) missing.push(`currentLocation.${key}`);
  if (!profile.preferredLocations.length || profile.preferredLocations.some(location => locationFit(location, ["United States"]) !== "compatible")) missing.push("preferredLocations");
  if (!profile.workArrangements?.length) missing.push("workArrangements");
  missing.push(...immigrationQuestionnaireMissingFields(profile.onboarding!.questionnaire));
  return {
    complete: profile.onboarding!.completedVersion === RESUME_ONBOARDING_VERSION && Boolean(profile.onboarding!.completedAt) &&
      missing.length === 0 && profile.onboarding!.completedResumeHash === source?.sha256,
    missing, confirmedFactCount: profile.facts.filter(fact => fact.verified).length,
    reviewHash: reviewHash(profile), version: RESUME_ONBOARDING_VERSION,
    importedFacts: importedOnboardingFacts(profile),
  };
}

export function saveOnboardingDraft(profile: Profile, payload: unknown): void {
  const input = onboardingDraftSchema.parse(payload);
  ensureOnboardingDefaults(profile);
  if (input.expectedReviewHash && input.expectedReviewHash !== reviewHash(profile)) throw new Error("Your saved profile changed. Reload the current review before saving.");
  for (const key of ["name", "email", "phone"] as const) if (input[key] !== undefined) profile[key] = input[key];
  if (input.links !== undefined) profile.links = normalizeProfileLinks(input.links);
  if (input.currentLocation !== undefined) profile.currentLocation = input.currentLocation;
  if (input.preferredLocations !== undefined) profile.preferredLocations = [...new Set(input.preferredLocations.filter(Boolean))];
  if (input.workArrangements !== undefined) {
    profile.workArrangements = [...new Set(input.workArrangements)];
    profile.remoteOnly = profile.workArrangements.length === 1 && profile.workArrangements[0] === "remote";
  }
  if (input.willingToRelocate !== undefined) profile.willingToRelocate = input.willingToRelocate ?? undefined;
  if (input.factPatch !== undefined) {
    const facts = applyFactCorrection(profile.facts, input.factPatch);
    const imported = new Set(importedOnboardingFacts(profile).map(fact => fact.id));
    if (facts.some((fact, index) => {
      const previous = profile.facts[index];
      return (fact.text !== previous.text || fact.source !== previous.source || fact.sourceAnchorId !== previous.sourceAnchorId || fact.verified !== previous.verified) &&
        (!imported.has(fact.id) || fact.source !== previous.source || fact.sourceAnchorId !== previous.sourceAnchorId || fact.verified !== previous.verified);
    })) throw new Error("Only the displayed imported professional information can be corrected here.");
    profile.facts = facts;
  }
  const completedAt = profile.onboarding!.completedAt;
  if (input.questionnaire) saveOnboarding(profile, { questionnaire: input.questionnaire });
  else bumpAutomationVersion(profile);
  profile.onboarding!.completedAt = completedAt;
  if (input.stage) profile.onboarding!.draftStage = input.stage;
  profile.updatedAt = new Date().toISOString();
}

export class OnboardingCompletionError extends Error {
  constructor(message: string, public missing: string[] = []) { super(message); }
}

export function finishResumeOnboarding(profile: Profile, expectedReviewHash: string): void {
  const status = resumeOnboardingStatus(profile);
  if (status.missing.length) throw new OnboardingCompletionError("Complete the required information before finishing onboarding.", status.missing);
  if (status.reviewHash !== expectedReviewHash) throw new OnboardingCompletionError("The resume or profile changed since this review. Review the saved information again.");
  const ids = new Set(status.importedFacts.map(fact => fact.id));
  profile.facts = profile.facts.map(fact => ids.has(fact.id) ? { ...fact, verified: true } : fact);
  const now = new Date().toISOString();
  profile.onboarding = { ...profile.onboarding!, completedAt: now, completedVersion: RESUME_ONBOARDING_VERSION,
    completedResumeHash: profile.resumeSource!.sha256, reviewedHash: expectedReviewHash, draftStage: "review" };
  profile.searchPreferencesConfirmedAt = now;
  profile.updatedAt = now;
  bumpAutomationVersion(profile);
}
