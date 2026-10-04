import type { Profile } from "@/lib/types";

type LinkKind = "linkedin" | "github" | "portfolio" | "website";

export function profileLinkQuestion(question: string): LinkKind | undefined {
  if (question.length > 120 || /\b(?:tell|describe|explain|why|how|experience|project|work authorization)\b/i.test(question)) return;
  const kinds = (["linkedin", "github", "portfolio", "website"] as const).filter((kind) => new RegExp(`\\b${kind}\\b`, "i").test(question));
  return kinds.length === 1 ? kinds[0] : undefined;
}

/** Ambiguous choices stay blank; a generic URL never establishes portfolio intent. */
export function profileLinkAnswers(profile: Profile): Partial<Record<LinkKind, string>> {
  const candidates: Record<LinkKind, string[]> = { linkedin: [], github: [], portfolio: [], website: [] };
  for (const value of profile.links ?? []) {
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol)) continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "linkedin.com" && /^\/in\/[^/]+/.test(url.pathname)) candidates.linkedin.push(value);
    else if (host === "github.com" && /^\/[^/]+\/?$/.test(url.pathname)) candidates.github.push(value);
    else {
      candidates.website.push(value);
      if (/(?:^|\.)portfolio(?:\.|$)/.test(host) || /(?:^|\/)portfolio(?:\/|$)/i.test(url.pathname) || ["behance.net", "dribbble.com"].includes(host)) candidates.portfolio.push(value);
    }
  }
  return Object.fromEntries(Object.entries(candidates).flatMap(([kind, values]) => {
    const unique = [...new Set(values)];
    return unique.length === 1 ? [[kind, unique[0]]] : [];
  }));
}
