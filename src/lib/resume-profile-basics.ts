import { isResumeSectionHeading } from "@/lib/resume-source-semantics";
import type { Profile, ResumeSourceDocument } from "@/lib/types";

export function normalizeProfileLinks(links: string[]): string[] {
  return [...new Set(links.map((link) => {
    const value = link.trim();
    if (!value) return "";
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes("."))
      throw new Error("Enter a valid HTTP or HTTPS profile link.");
    return url.href;
  }).filter(Boolean))];
}

/** Contact suggestions come from source text, never from the account or professional claims. */
export function resumeProfileBasics(source: ResumeSourceDocument): Pick<Profile, "name" | "email" | "phone" | "links"> {
  const text = source.text.normalize("NFKC");
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = rows.slice(0, rows.findIndex(isResumeSectionHeading) < 0 ? 8 : rows.findIndex(isResumeSectionHeading));
  const contactText = header.join("\n");
  const email = contactText.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] ?? "";
  const phone = [...contactText.matchAll(/(?:[+(]?\d[\d() .-]{5,}\d)(?:\s*(?:ext\.?|x)\s*\d+)?/gi)]
    .map((match) => match[0].trim()).find((value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 18 && value.length <= 40 && !/^(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}$/.test(value);
    }) ?? "";
  const rawLinks = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s|<>]+|(?<![\w@.])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s|<>]*)?/gi)]
    .map((match) => match[0].replace(/[),.;]+$/, ""));
  const links = rawLinks.flatMap((link) => {
    try { return normalizeProfileLinks([link]); } catch { return []; }
  });
  const candidate = (header[0] ?? "").split(/\s*[|·•]\s*/)[0].replace(/^(?:name\s*:\s*)/i, "").trim();
  const name = !isResumeSectionHeading(candidate) && !/\b(?:engineer|developer|nurse|manager|analyst|specialist|consultant|certified|registered|resume|curriculum|vitae|confidential)\b/i.test(candidate) &&
    /^[\p{L}\p{M}][\p{L}\p{M}.'-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}.'-]*){1,5}$/u.test(candidate) ? candidate : "";
  return { name, email, phone, links: [...new Set(links)] };
}
