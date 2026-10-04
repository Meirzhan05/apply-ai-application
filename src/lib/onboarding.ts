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
      ...(questionnaire.immigrationStatus !== undefined ? { immigrationStatus: questionnaire.immigrationStatus } : {}),
      ...(questionnaire.visaType !== undefined ? { visaType: questionnaire.visaType.trim().slice(0, 200) } : {}),
      ...(questionnaire.immigrationStatusDetails !== undefined ? { immigrationStatusDetails: questionnaire.immigrationStatusDetails.trim().slice(0, 500) } : {}),
      ...(questionnaire.sponsorshipNow !== undefined ? { sponsorshipNow: questionnaire.sponsorshipNow } : {}),
      ...(questionnaire.sponsorshipFuture !== undefined ? { sponsorshipFuture: questionnaire.sponsorshipFuture } : {}),
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
    if (profile.onboarding!.questionnaire.immigrationStatus !== "visa-holder") delete profile.onboarding!.questionnaire.visaType;
    if (profile.onboarding!.questionnaire.immigrationStatus !== "other") delete profile.onboarding!.questionnaire.immigrationStatusDetails;
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
  for (const key of ["immigrationStatus", "visaType", "immigrationStatusDetails", "sponsorshipNow", "sponsorshipFuture", "sponsorshipEither"]) delete values[key];
  const declaration = (value: FactualDeclaration | undefined): string | undefined =>
    value === "yes" ? "Yes" : value === "no" ? "No" : undefined;
  const sponsorship = declaration(questionnaire.requiresSponsorship);
  if (sponsorship) values.requiresSponsorship = sponsorship;
  else if (questionnaire.requiresSponsorship === "unknown") delete values.requiresSponsorship;
  const authorization = declaration(questionnaire.workAuthorization);
  if (authorization) values.workAuthorization = authorization;
  else if (questionnaire.workAuthorization === "unknown") delete values.workAuthorization;
  const statusLabels = { "us-citizen": "US citizen", "permanent-resident": "Permanent resident", "visa-holder": "Visa holder", other: "Other" };
  if (questionnaire.immigrationStatus) values.immigrationStatus = statusLabels[questionnaire.immigrationStatus];
  if (questionnaire.immigrationStatus === "visa-holder" && questionnaire.visaType?.trim()) values.visaType = questionnaire.visaType.trim();
  if (questionnaire.immigrationStatus === "other" && questionnaire.immigrationStatusDetails?.trim()) values.immigrationStatusDetails = questionnaire.immigrationStatusDetails.trim();
  const now = declaration(questionnaire.sponsorshipNow);
  const future = declaration(questionnaire.sponsorshipFuture);
  if (now) values.sponsorshipNow = now;
  if (future) values.sponsorshipFuture = future;
  // An either-period question is negative only when both declared periods are negative.
  if (now === "Yes" || future === "Yes") values.sponsorshipEither = "Yes";
  else if (now === "No" && future === "No") values.sponsorshipEither = "No";
  else if (questionnaire.sponsorshipNow === undefined && questionnaire.sponsorshipFuture === undefined && /^(Yes|No)$/i.test(values.requiresSponsorship ?? "")) values.sponsorshipEither = values.requiresSponsorship;
  if (questionnaire.availability?.trim() && !values.availability) values.availability = questionnaire.availability.trim();
  return values;
}

export function factualAnswerKeyForQuestion(question: string): string | undefined {
  const label = question.toLowerCase().trim().replace(/\s+/g, " ");
  const sponsorship = /sponsor/.test(label);
  const authorization = /authorized.*work|work.*authoriz/.test(label);
  if (sponsorship && authorization) return undefined;
  if (sponsorship) {
    const now = /\bnow\b|current|present|\btoday\b|at this time/.test(label);
    const future = /future|later|eventually/.test(label);
    if ((now && future) || /at any (?:point|time)|ever require|ever need/.test(label)) return "sponsorshipEither";
    if (future) return "sponsorshipFuture";
    if (now) return "sponsorshipNow";
    return "requiresSponsorship";
  }
  if (authorization) return "workAuthorization";
  if (/visa.*(?:type|category)|(?:type|category).*visa/.test(label)) return "visaType";
  if (/immigration.*(?:details|explain)|(?:details|explain).*immigration/.test(label)) return "immigrationStatusDetails";
  if (/(?:immigration|citizenship).*status/.test(label)) return "immigrationStatus";
  return undefined;
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
