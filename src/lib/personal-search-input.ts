import type { Profile } from "@/lib/types";
import { hashJson } from "@/lib/crypto";
import { redactedProfile } from "@/lib/jev";

export function personalSearchInput(profile: Profile) {
  const safe = redactedProfile(profile);
  // Explicit allowlist: never send the résumé document, contact information,
  // protected characteristics, school identifier, or legal declarations to web search.
  return {
    preferredTitles: safe.preferredTitles, preferredLocations: safe.preferredLocations,
    remoteOnly: safe.remoteOnly, strictLocations: safe.strictLocations ?? false,
    workArrangements: safe.workArrangements,
    headline: safe.headline, skills: safe.skills, graduationYear: safe.graduationYear,
    confirmedExperience: safe.facts.map((fact) => fact.text),
  };
}

export function personalSearchKey(profile: Profile) {
  return hashJson({ search: personalSearchInput(profile),
    workAuthorization: profile.onboarding?.questionnaire.workAuthorization,
    requiresSponsorship: profile.onboarding?.questionnaire.requiresSponsorship });
}
