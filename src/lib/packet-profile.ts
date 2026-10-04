import { isUsableFact } from "@/lib/fact-evidence";
import { hashJson } from "@/lib/crypto";
import type { Profile } from "@/lib/types";

export function packetProfileHash(profile: Profile): string {
  return hashJson({ name: profile.name, email: profile.email, phone: profile.phone, links: profile.links, school: profile.school, graduationYear: profile.graduationYear, skills: profile.skills, facts: profile.facts.filter((fact) => isUsableFact(fact)), sensitiveAnswers: profile.sensitiveAnswers, ...(profile.detailSources || profile.contactEmail || profile.linkedinUrl || profile.githubUrl || profile.portfolioUrl || profile.location ? { contactEmail: profile.contactEmail, linkedinUrl: profile.linkedinUrl, githubUrl: profile.githubUrl, portfolioUrl: profile.portfolioUrl, location: profile.location, detailSources: profile.detailSources } : {}), automationVersion: profile.automationVersion, automationSettings: profile.automationSettings, resumeSource: profile.resumeSource, resumeFileName: profile.resumeFileName });
}
