import { hashJson } from "@/lib/crypto";
import type { Profile } from "@/lib/types";

export function packetProfileHash(profile: Profile): string {
  return hashJson({ name: profile.name, email: profile.email, phone: profile.phone, links: profile.links, school: profile.school, graduationYear: profile.graduationYear, skills: profile.skills, facts: profile.facts.filter((fact) => fact.verified), sensitiveAnswers: profile.sensitiveAnswers, automationVersion: profile.automationVersion, automationSettings: profile.automationSettings, resumeSource: profile.resumeSource, resumeFileName: profile.resumeFileName });
}
