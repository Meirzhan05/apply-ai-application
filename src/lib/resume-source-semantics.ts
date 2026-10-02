import type { ResumeSourceAnchor } from "@/lib/types";

const sectionHeadings = new Set([
  "education", "academic background", "publications", "research", "work experience", "professional experience",
  "experience", "internship experience", "open source experience", "projects", "personal projects", "technical skills",
  "skills", "languages", "certifications", "awards", "leadership", "volunteering", "summary", "profile",
]);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const url = /^(?:https?:\/\/)?(?:www\.)?[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i;
const phone = /^\+?[\d() .-]{7,}$/;
const personName = /^[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,3}$/u;

function normalizedHeading(text: string) {
  return text.normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();
}

export function isResumeSectionHeading(text: string): boolean {
  return sectionHeadings.has(normalizedHeading(text));
}

export function isTrustedIdentityOrContact(text: string, firstBodyParagraph = false): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  const parts = normalized.split(/\s*[|·•]\s*/).filter(Boolean);
  const contactParts = parts.filter((part) => email.test(part) || url.test(part) || phone.test(part));
  if (contactParts.length > 0 && parts.every((part) => email.test(part) || url.test(part) || phone.test(part) || personName.test(part))) return true;
  return firstBodyParagraph && personName.test(normalized);
}

export function isSubstantiveSourceText(text: string, options: { isSection?: boolean; firstBodyParagraph?: boolean } = {}): boolean {
  return !options.isSection && !isResumeSectionHeading(text) && !isTrustedIdentityOrContact(text, options.firstBodyParagraph);
}

/** Re-evaluate legacy stored flags as well as current parser output. */
export function requiresSourceEvidence(anchor: ResumeSourceAnchor): boolean {
  const firstBodyParagraph = "paragraphIndex" in anchor
    ? anchor.paragraphIndex === 0
    : anchor.pageNumber === 1 && anchor.readingOrder === 0;
  return isSubstantiveSourceText(anchor.text, { firstBodyParagraph });
}
