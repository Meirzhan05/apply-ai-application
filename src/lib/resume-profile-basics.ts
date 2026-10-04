import { isResumeSectionHeading } from "@/lib/resume-source-semantics";
import { locationFit, unitedStatesRegion } from "@/lib/location-fit";
import type { Profile, ResumeSourceDocument } from "@/lib/types";

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countries = new Map<string, string>([
  ["us", "United States"], ["usa", "United States"], ["u.s.", "United States"], ["u.s.a.", "United States"],
  ["united states of america", "United States"], ["uk", "United Kingdom"], ["u.k.", "United Kingdom"],
  ["uae", "United Arab Emirates"],
]);
for (let first = 65; first <= 90; first++) {
  for (let second = 65; second <= 90; second++) {
    const code = String.fromCharCode(first, second);
    const name = countryNames.of(code);
    if (name && name !== code) countries.set(name.toLowerCase(), name);
  }
}

function currentLocationFromHeader(header: string[]): Profile["currentLocation"] {
  const candidates = new Map<string, NonNullable<Profile["currentLocation"]>>();
  const bodyStart = header.findIndex(row => /^(?:employment(?: history)?|work history|career history|professional background):?$/i.test(row));
  for (const segment of header.slice(0, bodyStart < 0 ? 8 : Math.min(bodyStart, 8)).flatMap(row => row.split(/[|·•;\t]/))) {
    const value = segment.trim().replace(/^(?:(?:current\s+)?location|residence|address)\s*:\s*|^based in\s+/i, "");
    if (value.length > 160 || /\b(?:remote|hybrid|relocat\w*|preferred|university|college|school|labs|inc|llc|company|engineer|intern|manager|developer)\b/i.test(value)) continue;
    const parts = value.split(",").map(part => part.trim());
    if (parts.length < 2 || parts.length > 3 || parts.some(part => !part)) continue;
    const [city, rawRegion, rawCountry] = parts;
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,79}$/u.test(city)) continue;
    let region = rawRegion.replace(/\s+\d{5}(?:-\d{4})?$/, "");
    const usRegion = unitedStatesRegion(region);
    const country = countries.get((rawCountry ?? rawRegion).toLowerCase());
    let location: NonNullable<Profile["currentLocation"]>;
    if (rawCountry) {
      if (!country || !/^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,79}$/u.test(region) || (country === "United States" && !usRegion)) continue;
      if (country === "United States") region = usRegion!;
      location = { city, region, country };
    } else if (usRegion && !country) {
      location = { city, region: usRegion, country: "United States" };
    } else if (country && !usRegion) {
      location = { city, region: "", country };
    } else continue;
    if (location.country === "United States" && locationFit(city, [location.region]) === "conflict") continue;
    candidates.set(JSON.stringify(location), location);
  }
  // Conflicting header locations and missing regions need the applicant's review.
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}

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
export function resumeProfileBasics(source: ResumeSourceDocument): Pick<Profile, "name" | "email" | "phone" | "links" | "currentLocation"> {
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
  return { name, email, phone, links: [...new Set(links)], currentLocation: currentLocationFromHeader(header) };
}
