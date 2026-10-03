import type { Profile } from "@/lib/types";

export function personalSearchReadiness(profile: Profile): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!profile.name.trim()) missing.push("your name");
  if (!profile.facts.some((fact) => fact.verified && fact.text.trim())) missing.push("confirmed experience");
  // Existing explicit preferences count as saved; empty preferences require an
  // explicit save (meaning use confirmed experience to choose relevant roles).
  if (!profile.searchPreferencesConfirmedAt && !profile.preferredTitles.length && !profile.preferredLocations.length && !profile.remoteOnly)
    missing.push("saved search preferences");
  return { ready: missing.length === 0, missing };
}
