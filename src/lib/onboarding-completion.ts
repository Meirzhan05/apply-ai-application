import { z } from "zod";
import { hashJson } from "@/lib/crypto";
import { applyFactCorrection } from "@/lib/fact-corrections";
import { isUnitedStatesLocation } from "@/lib/location-fit";
import { bumpAutomationVersion, ensureOnboardingDefaults, saveOnboarding } from "@/lib/onboarding";
import { immigrationQuestionnaireMissingFields, onboardingQuestionnaireSchema } from "@/lib/onboarding-questionnaire";
import { applyProfileDraft, profileDraftSchema } from "@/lib/profile-draft";
import type { Profile, VerifiedFact } from "@/lib/types";

export const RESUME_ONBOARDING_VERSION = 2;
export const onboardingDraftSchema = profileDraftSchema.extend({
  questionnaire: onboardingQuestionnaireSchema.optional(),
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
    resumeImport: profile.resumeImport, resumeExtraction: profile.resumeExtraction && { id: profile.resumeExtraction.id, status: profile.resumeExtraction.status, profileSourceHash: profile.resumeExtraction.profileSourceHash }, resumeText: profile.resumeSourceDocument?.text,
    name: profile.name, email: profile.contactEmail ?? profile.email, phone: profile.phone, links: profile.links,
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
  const reviewedCurrentSource = profile.onboarding!.completedVersion === RESUME_ONBOARDING_VERSION && Boolean(profile.onboarding!.completedAt) &&
    Boolean(source?.sha256) && profile.onboarding!.completedResumeHash === source?.sha256;
  const pending = profile.resumeExtraction?.pending;
  // The reviewed snapshot stays active during same-source recovery, including retries.
  const refreshingReviewedSource = reviewedCurrentSource && (profile.resumeImport
    ? profile.resumeImport.reusedSourceHash === source?.sha256
    : pending?.onboardingImport?.reused === true && pending.source.sha256 === source?.sha256);
  if (!source?.sha256 || !source.size || !profile.resumeFileName || !document?.text.trim() || document.sourceHash !== source.sha256) missing.push("resume");
  if (profile.resumeImport && !refreshingReviewedSource) missing.push("resumeImport");
  if (profile.resumeExtraction && profile.resumeExtraction.status !== "ready" && !refreshingReviewedSource) missing.push("resumeExtraction");
  if (!profile.name.trim()) missing.push("name");
  if (!z.email().safeParse((profile.contactEmail ?? profile.email).trim()).success) missing.push("email");
  if (!profile.phone.trim()) missing.push("phone");
  for (const key of ["city", "region", "country"] as const) if (!profile.currentLocation?.[key].trim()) missing.push(`currentLocation.${key}`);
  if (!profile.preferredLocations.length || profile.preferredLocations.some(location => !isUnitedStatesLocation(location))) missing.push("preferredLocations");
  if (!profile.workArrangements?.length) missing.push("workArrangements");
  missing.push(...immigrationQuestionnaireMissingFields(profile.onboarding!.questionnaire));
  return {
    complete: reviewedCurrentSource && missing.length === 0,
    missing, confirmedFactCount: profile.facts.filter(fact => fact.verified).length,
    reviewHash: reviewHash(profile), version: RESUME_ONBOARDING_VERSION,
    importedFacts: importedOnboardingFacts(profile),
  };
}

export function saveOnboardingDraft(profile: Profile, payload: unknown): void {
  const input = onboardingDraftSchema.parse(payload);
  ensureOnboardingDefaults(profile);
  if (input.expectedReviewHash && input.expectedReviewHash !== reviewHash(profile)) throw new Error("Your saved profile changed. Reload the current review before saving.");
  applyProfileDraft(profile, input);
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
