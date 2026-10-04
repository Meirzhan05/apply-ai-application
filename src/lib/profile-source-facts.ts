import type { Profile } from "@/lib/types";

/** Refresh source data and append worker-discovered facts without discarding draft edits. */
export function mergeCurrentSourceFacts(current: Profile, latest: Profile): Profile {
  if (current.id !== latest.id) return current;
  const knownFactIds = new Set(current.facts.map((fact) => fact.id));
  return {
    ...current,
    resumeFileName: latest.resumeFileName,
    resumeText: latest.resumeText,
    resumeSource: latest.resumeSource,
    resumeSourceDocument: latest.resumeSourceDocument,
    facts: [...current.facts, ...latest.facts.filter((fact) => !knownFactIds.has(fact.id))],
  };
}
