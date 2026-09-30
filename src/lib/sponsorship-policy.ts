export type SponsorshipPolicy = "available" | "unavailable" | "unknown";

// Only employment-related objects establish a conflict. Generic sponsorship
// language may concern events, sports or relocation instead of work visas.
const employmentSponsorship = "(?:visa|work(?: visa)?|employment|immigration|h-?1b) sponsorship";
const refusal = "(?:do(?:es)? not|will not|cannot|can't|unable to)";
const negative = new RegExp([
  `\\bno ${employmentSponsorship}(?: (?:is|will be))? (?:available|provided|offered)\\b`,
  `\\bno ${employmentSponsorship}(?=$|[.,;!])`,
  `\\b${refusal} (?:offer|provide) ${employmentSponsorship}\\b`,
  `\\b${employmentSponsorship} (?:is|will be) (?:unavailable|not (?:available|provided|offered))\\b`,
  `\\b${refusal} sponsor (?:visas|work visas|h-?1b(?: visas)?|applicants|candidates|employees)\\b`,
  `\\b(?:no sponsorship(?: (?:is|will be))? (?:available|provided|offered)|${refusal} (?:offer|provide) sponsorship) for (?:this|the) (?:role|position|job)\\b`,
  "\\bmust (?:already )?be authorized(?: to work)? without (?:visa )?sponsorship\\b",
].join("|"), "gi");
const positive = new RegExp([
  `\\b${employmentSponsorship} (?:is|will be) (?:available|provided|offered)\\b`,
  `\\b(?:we|the company|the employer|this (?:role|position|employer)) (?:can |will |do )?(?:offer|provide|support) ${employmentSponsorship}\\b`,
  "\\bsponsorship (?:is|will be) available for (?:this|the) (?:role|position|job)\\b",
].join("|"), "i");

export function sponsorshipPolicy(text: string): SponsorshipPolicy {
  const normalized = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  const refusals = [...normalized.matchAll(negative)];
  // Remove negative spans before looking for positive statements; the inner
  // words in "no visa sponsorship is available" are not affirmative evidence.
  const remaining = normalized.replace(negative, " ");
  const affirmatives = [...remaining.matchAll(new RegExp(positive.source, "gi"))];
  const available = affirmatives.length > 0;
  const qualified = (source: string, index: number) => {
    const start = source.lastIndexOf(".", index) + 1;
    const end = source.indexOf(".", index);
    const clause = source.slice(start, end < 0 ? undefined : end);
    return /\b(?:if|unless|except|only|may|might|(?:cannot|can't) (?:confirm|guarantee|promise)|not guaranteed|no guarantee)\b/.test(clause);
  };
  if (refusals.length && available) return "unknown";
  if (refusals.length) {
    // Conditional or exception-bearing policies need applicant/role context.
    // Do not turn them into an unconditional eligibility rejection.
    const conditional = refusals.some((match) => qualified(normalized, match.index));
    return conditional ? "unknown" : "unavailable";
  }
  return available && !affirmatives.some((match) => qualified(remaining, match.index)) ? "available" : "unknown";
}
