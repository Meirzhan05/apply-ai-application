import type { Application, Profile, ProfileDetailKey, SavedProfileAnswer } from "@/lib/types";
import { profileLinkAnswers } from "@/lib/profile-links";

export const profileDetailKeys = ["name", "contactEmail", "phone", "school", "graduationYear", "headline", "location", "linkedinUrl", "githubUrl", "portfolioUrl"] as const;
export const profileDetailLabels: Record<ProfileDetailKey, string> = {
  name: "Full name", contactEmail: "Application email", phone: "Phone", school: "School", graduationYear: "Graduation year",
  headline: "Short headline", location: "Current location", linkedinUrl: "LinkedIn", githubUrl: "GitHub", portfolioUrl: "Portfolio / website",
};

export function normalizeProfileDetail(key: ProfileDetailKey, value: string): string {
  value = value.trim();
  return key.endsWith("Url") && value && !/^[a-z][a-z\d+.-]*:/i.test(value) ? `https://${value}` : value;
}

export function validProfileDetail(key: ProfileDetailKey, value: string): boolean {
  if (!value || value.length > 500 || /[\r\n\u0000-\u001f]/.test(value)) return false;
  if (key === "contactEmail") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (key === "phone") return /^[+\d().\s-]+$/.test(value) && value.replace(/\D/g, "").length >= 7;
  if (key === "graduationYear") return /\b(?:19|20)\d{2}\b/.test(value) && value.length <= 40;
  if (key.endsWith("Url")) {
    try {
      const url = new URL(normalizeProfileDetail(key, value));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".")) return false;
      if (key === "linkedinUrl") return /^(?:www\.)?linkedin\.com$/.test(url.hostname) && /^\/in\/[^/]+\/?$/.test(url.pathname);
      if (key === "githubUrl") return /^(?:www\.)?github\.com$/.test(url.hostname) && /^\/[\w-]+\/?$/.test(url.pathname);
      return true;
    } catch { return false; }
  }
  return true;
}

export function profileDetailValue(profile: Profile, key: ProfileDetailKey): string {
  // An explicit clear is intentional and must not resurrect a previously learned answer.
  if (profile.detailSources?.[key]?.source === "user") return profile[key] ?? "";
  const saved = profile[key] || profile.savedAnswers?.find(answer => answer.key === key)?.value;
  if (saved) return saved;
  const legacyLink = key === "linkedinUrl" ? "linkedin" : key === "githubUrl" ? "github" : key === "portfolioUrl" ? "portfolio" : undefined;
  if (legacyLink) return profileLinkAnswers(profile)[legacyLink] ?? "";
  return key === "contactEmail" ? profile.email : "";
}

/** Conservative personal question vocabulary. Job, employer, consent and declarations stay application-scoped. */
export function personalQuestionKey(question: string): SavedProfileAnswer["key"] | undefined {
  const label = question.toLowerCase().trim().replace(/\s*\((?:optional|required)\)\s*$/g, "").replace(/[?*:]+$/g, "").replace(/\s+/g, " ")
    .replace(/^(?:please (?:provide|enter|share)|provide|enter|share|what is) /, "");
  if (/company|employer|organization|reference|referrer|manager|supervisor|recruiter|job|position|role|sponsor|authoriz|citizen|visa|consent|gender|ethnic|disab|veteran|salary|relocat|willing|preferred/.test(label)) return;
  if (/^(?:(?:your|personal|candidate|applicant) )?(?:linkedin|linked in)(?: (?:profile|profile url|url|link))?$/.test(label)) return "linkedinUrl";
  if (/^(?:(?:your|personal|candidate|applicant) )?github(?: (?:profile|profile url|url|link))?$/.test(label)) return "githubUrl";
  if (/^(?:(?:your|personal) )?(?:portfolio(?: \/ website)?|website|personal website)(?: (?:url|link))?$/.test(label)) return "portfolioUrl";
  if (/^(?:(?:your|current|home) )?(?:location|city|city and state|city, state)$/.test(label)) return "location";
  if (/^(?:full name|your name|candidate name|applicant name|name)$/.test(label)) return "name";
  if (/^(?:(?:your|contact|personal) )?e-?mail(?: address)?$/.test(label)) return "contactEmail";
  if (/^(?:(?:your|contact|personal|mobile) )?(?:phone|telephone|mobile)(?: number)?$/.test(label)) return "phone";
  if (/^(?:(?:your|current) )?(?:school|university|college)(?: name)?$/.test(label) || /^(?:what|which) (?:school|university|college) (?:do you (?:currently )?attend|are you (?:currently )?attending)$/.test(label)) return "school";
  if (/^(?:(?:your|expected) )?graduation (?:year|date)$/.test(label)) return "graduationYear";
  if (/^(?:languages(?: spoken)?|(?:which|what) languages do you speak)$/.test(label)) return "languages";
  if (/^(?:name pronunciation|how (?:do you pronounce|is) your name(?: pronounced)?)$/.test(label)) return "namePronunciation";
  return;
}

export function rememberPersonalAnswer(profile: Profile, applicationId: string, question: string, value: string): void {
  const key = personalQuestionKey(question);
  value = profileDetailKeys.includes(key as ProfileDetailKey) ? normalizeProfileDetail(key as ProfileDetailKey, value) : value.trim();
  if (!key || !value || value.length > 500 || /[\r\n\u0000-\u001f]/.test(value) ||
      (profileDetailKeys.includes(key as ProfileDetailKey) && !validProfileDetail(key as ProfileDetailKey, value))) return;
  // Manual profile values win; learning never changes active packet/profile authorizations.
  profile.savedAnswers = [...(profile.savedAnswers ?? []).filter(answer => answer.key !== key),
    { key, question, value, applicationId, savedAt: new Date().toISOString() }];
}

export function profileMemorySnapshot(profile: Profile): Record<string, string> {
  const values = Object.fromEntries(profileDetailKeys.map(key => [key, profileDetailValue(profile, key)]));
  for (const answer of profile.savedAnswers ?? []) if (!profileDetailKeys.includes(answer.key as ProfileDetailKey)) values[answer.key] = answer.value;
  return values;
}

export function applicationPersonalValues(profile: Profile, application: Application): Record<string, string> {
  // Legacy applications cannot pick up newly learned answers while already in progress.
  return application.profileMemory ?? Object.fromEntries(profileDetailKeys.map(key => [key, profile[key] || (key === "contactEmail" ? profile.email : "")]));
}

export function profileDraftValues(profile: Profile): Profile {
  return { ...structuredClone(profile), ...Object.fromEntries(profileDetailKeys.map(key => [key, profileDetailValue(profile, key)])) };
}
