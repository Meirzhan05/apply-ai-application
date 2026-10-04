import type {
  AutomationAuthorization,
  AutomationSettings,
  CoverLetterMode,
  EssayMode,
  FactualDeclaration,
  OnboardingQuestionnaire,
  Profile,
  VerifiedFact,
} from "@/lib/types";

const defaultSettings = (): AutomationSettings => ({
  version: 1,
  resumeTailoring: true,
  coverLetterMode: "required-only",
  essayMode: "automatic-truthful",
});

const defaultQuestionnaire = (): OnboardingQuestionnaire => ({});

export function ensureOnboardingDefaults(profile: Profile): void {
  profile.automationVersion ??= profile.automationSettings?.version ?? 1;
  profile.automationSettings ??= defaultSettings();
  profile.onboarding ??= { questionnaire: defaultQuestionnaire() };
  profile.onboarding.questionnaire ??= defaultQuestionnaire();
}

export function onboardingCompleteness(profile: Profile): {
  complete: boolean;
  missing: string[];
  confirmedFactCount: number;
} {
  ensureOnboardingDefaults(profile);
  const missing: string[] = [];
  const questionnaire = profile.onboarding!.questionnaire;
  if (!questionnaire.workAuthorization || questionnaire.workAuthorization === "unknown") missing.push("workAuthorization");
  if (!questionnaire.requiresSponsorship || questionnaire.requiresSponsorship === "unknown") missing.push("requiresSponsorship");
  const confirmedFactCount = profile.facts.filter((fact) => fact.verified).length;
  if (!confirmedFactCount) missing.push("confirmedResumeFact");
  return { complete: missing.length === 0, missing, confirmedFactCount };
}

const missingLabels: Record<string, string> = {
  workAuthorization: "work authorization answer",
  requiresSponsorship: "sponsorship answer",
  confirmedResumeFact: "one confirmed résumé fact",
};

export function onboardingMissingLabel(key: string): string {
  return missingLabels[key] ?? key;
}

export function saveOnboarding(
  profile: Profile,
  input: {
    questionnaire?: OnboardingQuestionnaire;
    facts?: VerifiedFact[];
  },
): void {
  ensureOnboardingDefaults(profile);
  if (input.questionnaire) {
    const questionnaire = input.questionnaire;
    profile.onboarding!.questionnaire = {
      ...profile.onboarding!.questionnaire,
      ...(questionnaire.workAuthorization !== undefined
        ? { workAuthorization: questionnaire.workAuthorization }
        : {}),
      ...(questionnaire.requiresSponsorship !== undefined
        ? { requiresSponsorship: questionnaire.requiresSponsorship }
        : {}),
      ...(questionnaire.availability !== undefined
        ? { availability: questionnaire.availability.trim().slice(0, 200) }
        : {}),
      ...(questionnaire.graduationYear !== undefined
        ? { graduationYear: questionnaire.graduationYear.trim().slice(0, 20) }
        : {}),
    };
    if (questionnaire.graduationYear?.trim()) profile.graduationYear = questionnaire.graduationYear.trim().slice(0, 20);
    if (questionnaire.workAuthorization === "yes") profile.workAuthorization = "Authorized to work in the US";
    if (questionnaire.workAuthorization === "no") profile.workAuthorization = "Not authorized to work in the US";
    if (questionnaire.workAuthorization === "unknown") profile.workAuthorization = "Unspecified";
  }
  if (input.facts) profile.facts = input.facts;
  profile.onboarding!.completedAt = onboardingCompleteness(profile).complete
    ? new Date().toISOString()
    : undefined;
  bumpAutomationVersion(profile);
}

export function reusableFactualAnswers(profile: Profile): Record<string, string> {
  ensureOnboardingDefaults(profile);
  const values: Record<string, string> = { ...profile.sensitiveAnswers };
  const questionnaire = profile.onboarding!.questionnaire;
  const declaration = (value: FactualDeclaration | undefined): string | undefined =>
    value === "yes" ? "Yes" : value === "no" ? "No" : undefined;
  const sponsorship = declaration(questionnaire.requiresSponsorship);
  if (sponsorship) values.requiresSponsorship = sponsorship;
  else if (questionnaire.requiresSponsorship === "unknown") delete values.requiresSponsorship;
  const authorization = declaration(questionnaire.workAuthorization);
  if (authorization) values.workAuthorization = authorization;
  else if (questionnaire.workAuthorization === "unknown") delete values.workAuthorization;
  if (questionnaire.availability?.trim() && !values.availability) values.availability = questionnaire.availability.trim();
  if (typeof profile.willingToRelocate === "boolean") values.willingToRelocate = profile.willingToRelocate ? "Yes" : "No";
  if (profile.currentLocation) {
    const { city, region, country } = profile.currentLocation;
    if (city.trim()) values.currentCity = city.trim();
    if (region.trim()) values.currentRegion = region.trim();
    if (country.trim()) values.currentCountry = country.trim();
    if (city.trim() && region.trim() && country.trim()) values.currentLocation = [city, region, country].map((value) => value.trim()).join(", ");
  }
  return values;
}

export function updateAutomationSettings(
  profile: Profile,
  input: Partial<AutomationSettings> & {
    preferredTitles?: string[];
    preferredLocations?: string[];
    remoteOnly?: boolean;
    strictLocations?: boolean;
  },
): void {
  ensureOnboardingDefaults(profile);
  const current = profile.automationSettings!;
  if (input.resumeTailoring !== undefined) current.resumeTailoring = input.resumeTailoring;
  if (input.coverLetterMode !== undefined) current.coverLetterMode = input.coverLetterMode;
  if (input.essayMode !== undefined) current.essayMode = input.essayMode;
  // Search filters are still stored on Profile for compatibility with the
  // existing matcher. Empty arrays intentionally mean "use resume matching".
  if (input.preferredTitles !== undefined) profile.preferredTitles = [...input.preferredTitles];
  if (input.preferredLocations !== undefined) profile.preferredLocations = [...input.preferredLocations];
  if (input.remoteOnly !== undefined) profile.remoteOnly = input.remoteOnly;
  if (input.strictLocations !== undefined) profile.strictLocations = input.strictLocations;
  bumpAutomationVersion(profile);
}

export function activateAutomation(profile: Profile, reason: string): AutomationAuthorization {
  ensureOnboardingDefaults(profile);
  const completeness = onboardingCompleteness(profile);
  if (!completeness.complete) {
    if (completeness.missing.includes("confirmedResumeFact"))
      throw new Error("Confirm at least one resume fact before enabling automation.");
    throw new Error(`Complete onboarding before enabling automation: ${completeness.missing.map(onboardingMissingLabel).join(", ")}.`);
  }
  const now = new Date().toISOString();
  const authorization: AutomationAuthorization = {
    version: profile.automationVersion,
    status: "enabled",
    reason: reason.trim().slice(0, 200) || "applicant-confirmed",
    authorizedAt: now,
  };
  profile.automationAuthorization = authorization;
  return authorization;
}

export function pauseAutomation(profile: Profile): void {
  ensureOnboardingDefaults(profile);
  if (!profile.automationAuthorization) return;
  profile.automationAuthorization = {
    ...profile.automationAuthorization,
    status: "paused",
    pausedAt: new Date().toISOString(),
  };
}

export function automationStatus(profile: Profile): {
  enabled: boolean;
  paused: boolean;
  version: number;
  settings: AutomationSettings;
  authorization?: AutomationAuthorization;
} {
  ensureOnboardingDefaults(profile);
  const authorization = profile.automationAuthorization;
  return {
    enabled: authorization?.status === "enabled" && authorization.version === profile.automationVersion,
    paused: authorization?.status === "paused",
    version: profile.automationVersion,
    settings: { ...profile.automationSettings! },
    authorization: authorization ? { ...authorization } : undefined,
  };
}

export function bumpAutomationVersion(profile: Profile): number {
  ensureOnboardingDefaults(profile);
  profile.automationVersion += 1;
  profile.automationSettings!.version = profile.automationVersion;
  if (profile.automationAuthorization) profile.automationAuthorization.version = profile.automationVersion;
  return profile.automationVersion;
}

export function isDeclaration(value: unknown): value is FactualDeclaration {
  return value === "yes" || value === "no" || value === "unknown";
}

export function isCoverLetterMode(value: unknown): value is CoverLetterMode {
  return value === "disabled" || value === "required-only" || value === "enabled";
}

export function isEssayMode(value: unknown): value is EssayMode {
  return value === "automatic-truthful";
}
