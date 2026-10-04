// This comparator deliberately leaves unsupported or ambiguous geography
// unresolved. It must never turn a failed text match into a hard rejection.
export type LocationFit = "compatible" | "conflict" | "unknown";
type Place = { state: string; city?: string };

const states: Record<string, string> = Object.fromEntries([
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["PR", "Puerto Rico"], ["GU", "Guam"], ["VI", "US Virgin Islands"],
].flatMap(([code, name]) => [[code.toLowerCase(), code], [name.toLowerCase(), code]]));

const cities: Record<string, Place> = {
  nyc: { city: "new york city", state: "NY" }, "new york city": { city: "new york city", state: "NY" },
  sf: { city: "san francisco", state: "CA" }, "san francisco": { city: "san francisco", state: "CA" },
  "los angeles": { city: "los angeles", state: "CA" },
  boston: { city: "boston", state: "MA" }, chicago: { city: "chicago", state: "IL" },
  seattle: { city: "seattle", state: "WA" }, austin: { city: "austin", state: "TX" },
  atlanta: { city: "atlanta", state: "GA" }, denver: { city: "denver", state: "CO" },
  miami: { city: "miami", state: "FL" }, philadelphia: { city: "philadelphia", state: "PA" },
  pittsburgh: { city: "pittsburgh", state: "PA" }, "washington dc": { city: "washington", state: "DC" },
};

function normalized(text: string) {
  return text.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

export function unitedStatesRegion(region: string): string | undefined {
  return states[normalized(region)];
}

function place(raw: string): Place | undefined {
  if (/^(?:united states(?: of america)?|usa|us)$/.test(normalized(raw))) return { state: "US" };
  const text = normalized(raw).replace(/[\s,]+(?:united states(?: of america)?|usa|us)$/, "").trim();
  if (!text) return;
  // "LA" can mean Los Angeles or Louisiana. A full state/city or a city
  // followed by a state resolves it; the bare abbreviation does not.
  if (text === "la") return;
  if (cities[text]) return cities[text];
  if (states[text]) return { state: states[text] };
  if (/remote|hybrid|area|region|metro|multiple|various|unknown|unspecified|not listed|anywhere|\s(?:or|and)\s/.test(text)) return;
  const parts = text.split(",").map((part) => part.trim());
  const state = parts.length === 2 ? states[parts[1]] : undefined;
  if (!state || !/^[a-z][a-z\s'-]+$/.test(parts[0])) return;
  const alias = cities[parts[0]];
  // Contradictory aliases are uncertain rather than silently corrected.
  if (alias && alias.state !== state) return;
  const city = state === "NY" && parts[0] === "new york" ? "new york city" : alias?.city ?? parts[0];
  return { state, city };
}

function compare(actual: Place, allowed: Place): LocationFit {
  if (allowed.state === "US") return "compatible";
  if (actual.state === "US") return "unknown";
  if (actual.state !== allowed.state) return "conflict";
  if (!allowed.city) return "compatible";
  if (!actual.city) return "unknown"; // A statewide posting doesn't confirm a required city.
  return actual.city === allowed.city ? "compatible" : "conflict";
}

export type UnitedStatesDestination = "verified_us" | "outside_us" | "unresolved";

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const foreignCountries = new Set(["uk", "united kingdom", "great britain", "england", "scotland", "wales", "uae"]);
for (let first = 65; first <= 90; first++) {
  for (let second = 65; second <= 90; second++) {
    const code = String.fromCharCode(first, second);
    const name = countryNames.of(code);
    if (name && name !== code && !["US", "PR", "GU", "VI"].includes(code) && !states[normalized(name)])
      foreignCountries.add(normalized(name));
  }
}

/** A work arrangement or candidate residence is never destination evidence. */
export function unitedStatesDestination(location: string): UnitedStatesDestination {
  const text = normalized(location);
  const tokens = text.split(/[,;\n|/()·]+/).map((part) => part.trim());
  if (tokens.some((part) => foreignCountries.has(part) || [...foreignCountries].some((country) => part.endsWith(` ${country}`))))
    return "outside_us";
  if (/\b(?:worldwide|global|anywhere|international|emea|apac|latam)\b/.test(text)) return "unresolved";
  const alternatives = text.split(/\s*[;\n|/]\s*/).map((alternative) => alternative
    .replace(/\b(?:remote|hybrid|on[ -]?site)\b/g, "").replace(/[()]/g, " ")
    .split(/\s*·\s*/).map((part) => part.replace(/^[\s,:-]+|[\s,:-]+$/g, "")).filter(Boolean));
  return alternatives.every((destinations) => destinations.length && destinations.every((part) =>
    /(?:^|[\s,])(?:united states(?: of america)?|usa|us)$/.test(part) || Boolean(place(part))))
    ? "verified_us" : "unresolved";
}

export function isUnitedStatesLocation(location: string): boolean {
  return unitedStatesDestination(location) === "verified_us";
}

export function locationFit(location: string, preferences: string[]): LocationFit {
  if (!preferences.length) return "unknown";
  const actual = location.split(/\s*[;\n|/]\s*/).map(place);
  const allowed = preferences.map(place);
  const outcomes = actual.flatMap((candidate) => allowed.map((preference) =>
    candidate && preference ? compare(candidate, preference) : "unknown" as LocationFit));
  if (outcomes.includes("compatible")) return "compatible";
  // Every possible location and allowed preference must be unambiguously
  // disjoint. An unparsed alternative could still meet the owner's rule.
  return outcomes.length && outcomes.every((outcome) => outcome === "conflict") ? "conflict" : "unknown";
}
