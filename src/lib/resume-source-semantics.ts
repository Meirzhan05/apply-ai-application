import type { ResumeSourceAnchor, ResumeSourceDocument } from "@/lib/types";

const sectionHeadings = new Set([
  "education", "academic background", "publications", "research", "work experience", "professional experience",
  "experience", "internship experience", "open source experience", "projects", "personal projects", "technical skills",
  "skills", "languages", "certifications", "awards", "leadership", "volunteering", "summary", "profile",
]);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const url = /^(?:https?:\/\/)?(?:www\.)?[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i;
const phone = /^\+?[\d() .-]{7,}$/;
const nameWord = /^[\p{Lu}][\p{Ll}]+(?:['’-][\p{Lu}]?[\p{Ll}]+)*$/u;
const qualificationOrRole = /^(?:aws|azure|gcp|cfa|cpa|pmp|certified|certification|certificate|developer|engineer|architect|practitioner|professional|specialist|analyst|administrator|associate|expert|scientist|consultant|bachelor|master|phd|mba)$/i;
const formatOnly = /^(?:résumé|resume|curriculum vitae|cv|confidential(?:\s+candidate\s+record)?|page\s+\d+(?:\s+of\s+\d+)?)$/i;

function likelyPersonName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 4 && words.every((word) => nameWord.test(word) && !qualificationOrRole.test(word));
}

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
  const hasIdentity = parts.some(likelyPersonName);
  if (firstBodyParagraph && parts.length > 0 && parts.every((part) => formatOnly.test(part))) return true;
  if (firstBodyParagraph && hasIdentity && parts.every((part) => likelyPersonName(part) || formatOnly.test(part))) return true;
  const contactParts = parts.filter((part) => email.test(part) || url.test(part) || phone.test(part));
  if (contactParts.length > 0 && parts.every((part) => email.test(part) || url.test(part) || phone.test(part) || likelyPersonName(part) || formatOnly.test(part))) return true;
  return firstBodyParagraph && likelyPersonName(normalized);
}

export function isSubstantiveSourceText(text: string, options: { isSection?: boolean; firstBodyParagraph?: boolean } = {}): boolean {
  return !options.isSection && !isResumeSectionHeading(text) && !isTrustedIdentityOrContact(text, options.firstBodyParagraph);
}

/** Re-evaluate legacy stored flags as well as current parser output. */
export function evidenceRequiredAnchorIds(source: ResumeSourceDocument): Set<string> {
  const firstBodyAnchor = source.format === "docx"
    ? source.anchors.filter((anchor) => "partName" in anchor && anchor.partName === "word/document.xml").sort((left, right) => left.paragraphIndex - right.paragraphIndex)[0]
    : source.anchors.filter((anchor) => "pageNumber" in anchor && anchor.pageNumber === 1 && typeof anchor.readingOrder === "number" && !anchor.repeatedRole).sort((left, right) => (left.readingOrder ?? 0) - (right.readingOrder ?? 0))[0];
  return new Set(source.anchors.filter((anchor) => requiresSourceEvidence(anchor, anchor.id === firstBodyAnchor?.id)).map((anchor) => anchor.id));
}

export function requiresSourceEvidence(anchor: ResumeSourceAnchor, firstVisibleBodyAnchor = false): boolean {
  const identityPosition = firstVisibleBodyAnchor || ("repeatedRole" in anchor && Boolean(anchor.repeatedRole));
  return isSubstantiveSourceText(anchor.text, { firstBodyParagraph: identityPosition });
}
