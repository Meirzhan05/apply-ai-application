import type { ResumeSourceAnchor, ResumeSourceDocument } from "@/lib/types";

const sectionHeadings = new Set([
  "education", "academic background", "publications", "research", "work experience", "professional experience",
  "experience", "internship experience", "open source experience", "projects", "personal projects", "technical skills",
  "skills", "languages", "certifications", "awards", "leadership", "volunteering", "summary", "profile",
]);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const url = /^(?:https?:\/\/)?(?:www\.)?[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i;
const phone = /^\+?[\d() .-]{7,}$/;
const formatOnly = /^(?:résumé|resume|curriculum vitae|cv|confidential(?:\s+candidate\s+record)?|page\s+\d+(?:\s+of\s+\d+)?)$/i;

function normalizeIdentity(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function normalizedHeading(text: string) {
  return text.normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().replace(/:$/, "").toLowerCase();
}

const skillCategoryHeadings = new Set(["languages", "frameworks", "tools", "libraries"]);

function samePdfRow(left: ResumeSourceAnchor, right: ResumeSourceAnchor): boolean {
  if (left.pageNumber !== right.pageNumber || !left.regionId || left.regionId !== right.regionId ||
      !Number.isFinite(left.readingOrder) || !Number.isFinite(right.readingOrder)) return false;
  const a = "boundsPt" in left ? left.boundsPt : undefined;
  const b = "boundsPt" in right ? right.boundsPt : undefined;
  return Boolean(a && b && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 2.5);
}

/** Return PDF-only separator/category anchors that are layout, not applicant claims. */
export function pdfNonClaimArtifactAnchorIds(anchors: ResumeSourceAnchor[]): Set<string> {
  const ignored = new Set(anchors.filter((anchor) => !/[\p{L}\p{N}]/u.test(anchor.text)).map((anchor) => anchor.id));
  const lanes = new Map<string, ResumeSourceAnchor[]>();
  for (const anchor of anchors) {
    if (anchor.pageNumber === undefined || !anchor.regionId || !Number.isFinite(anchor.readingOrder)) continue;
    const lane = `${anchor.pageNumber}:${anchor.regionId}`;
    lanes.set(lane, [...(lanes.get(lane) ?? []), anchor]);
  }
  for (const lane of lanes.values()) {
    lane.sort((left, right) => (left.readingOrder ?? 0) - (right.readingOrder ?? 0));
    let inSkills = false;
    for (let index = 0; index < lane.length; index++) {
      const anchor = lane[index];
      const heading = normalizedHeading(anchor.text);
      const value = lane[index + 1];
      const inlineSkillCategory = skillCategoryHeadings.has(heading) && Boolean(value && samePdfRow(anchor, value) && /^\s*:/.test(value.text));
      if (anchor.kind === "section") {
        if (heading === "technical skills" || heading === "skills") inSkills = true;
        else if (!(inSkills && inlineSkillCategory)) inSkills = false;
      }
      if (inSkills && inlineSkillCategory) ignored.add(anchor.id);
    }
  }
  return ignored;
}

/** The exact text shown for a PDF source-fact suggestion. */
export function canonicalPdfSourceFactText(anchor: ResumeSourceAnchor): string {
  return [anchor.sectionHeading, anchor.entryHeading, anchor.text].filter(Boolean).join(" · ")
    .replace(/[\u0000\u200b\u00ad]/g, "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function isResumeSectionHeading(text: string): boolean {
  return sectionHeadings.has(normalizedHeading(text));
}

export function isTrustedIdentityOrContact(text: string, firstBodyParagraph = false, trustedName?: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  const parts = normalized.split(/\s*[|·•]\s*/).filter(Boolean);
  if (firstBodyParagraph && parts.length > 0 && parts.every((part) => formatOnly.test(part))) return true;
  const trustedIdentity = trustedName ? normalizeIdentity(trustedName) : "";
  const hasTrustedIdentity = trustedIdentity.length > 0 && parts.some((part) => normalizeIdentity(part) === trustedIdentity);
  const allowedContactRowPart = (part: string) => email.test(part) || url.test(part) || phone.test(part) || formatOnly.test(part);
  if (hasTrustedIdentity && parts.every((part) => normalizeIdentity(part) === trustedIdentity || allowedContactRowPart(part))) return true;

  // Without a known profile name, don't infer identity from title case. A credential
  // can have the same shape as a person's name, so only contact-only/format rows are safe.
  return parts.every((part) => allowedContactRowPart(part)) && parts.some((part) => email.test(part) || url.test(part) || phone.test(part));
}

export function isSubstantiveSourceText(text: string, options: { isSection?: boolean; firstBodyParagraph?: boolean; trustedName?: string } = {}): boolean {
  return !options.isSection && !isResumeSectionHeading(text) && !isTrustedIdentityOrContact(text, options.firstBodyParagraph, options.trustedName);
}

/** Re-evaluate legacy stored flags as well as current parser output. */
export function evidenceRequiredAnchorIds(source: ResumeSourceDocument, trustedName?: string): Set<string> {
  const nonClaimArtifacts = source.format === "pdf" ? pdfNonClaimArtifactAnchorIds(source.anchors) : new Set<string>();
  const firstBodyAnchor = source.format === "docx"
    ? source.anchors.filter((anchor) => "partName" in anchor && anchor.partName === "word/document.xml").sort((left, right) => left.paragraphIndex - right.paragraphIndex)[0]
    : source.anchors.filter((anchor) => "pageNumber" in anchor && anchor.pageNumber === 1 && typeof anchor.readingOrder === "number" && !anchor.repeatedRole).sort((left, right) => (left.readingOrder ?? 0) - (right.readingOrder ?? 0))[0];
  return new Set(source.anchors.filter((anchor) => !nonClaimArtifacts.has(anchor.id) &&
    requiresSourceEvidence(anchor, anchor.id === firstBodyAnchor?.id, trustedName)).map((anchor) => anchor.id));
}

export function requiresSourceEvidence(anchor: ResumeSourceAnchor, firstVisibleBodyAnchor = false, trustedName?: string): boolean {
  const identityPosition = firstVisibleBodyAnchor || ("repeatedRole" in anchor && Boolean(anchor.repeatedRole));
  return isSubstantiveSourceText(anchor.text, { firstBodyParagraph: identityPosition, trustedName });
}
