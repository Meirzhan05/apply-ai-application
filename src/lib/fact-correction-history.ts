import type { VerifiedFact } from "./types";

export type FactCorrectionHistory = {
  owner: string;
  applicationId: string;
  before: VerifiedFact[];
  after: VerifiedFact[];
};
type SessionStore = Pick<Storage, "getItem" | "setItem">;
const key = (owner: string) => `apply-ai:fact-correction:${owner}`;
const isFact = (value: unknown): value is VerifiedFact => {
  if (!value || typeof value !== "object") return false;
  const fact = value as Record<string, unknown>;
  return typeof fact.id === "string" && typeof fact.text === "string" && typeof fact.verified === "boolean"
    && (fact.source === "resume" || fact.source === "user")
    && (fact.sourceAnchorId === undefined || typeof fact.sourceAnchorId === "string");
};

export function readFactCorrectionHistory(storage: SessionStore, owner: string, applicationIds: string[], facts: VerifiedFact[]): FactCorrectionHistory | null {
  try {
    const saved = JSON.parse(storage.getItem(key(owner)) ?? "null");
    if (!saved || saved.version !== 1 || saved.owner !== owner || !applicationIds.includes(saved.applicationId)
      || !Array.isArray(saved.before) || !Array.isArray(saved.after) || !saved.before.length
      || saved.before.length !== saved.after.length || !saved.before.every(isFact) || !saved.after.every(isFact)) return null;
    if (new Set(saved.after.map((fact: VerifiedFact) => fact.id)).size !== saved.after.length) return null;
    if (!saved.before.every((fact: VerifiedFact, index: number) => fact.id === saved.after[index].id)) return null;
    if (!saved.after.every((expected: VerifiedFact) => {
      const current = facts.find(fact => fact.id === expected.id);
      return current && current.text === expected.text && current.verified === expected.verified
        && current.source === expected.source && current.sourceAnchorId === expected.sourceAnchorId;
    })) return null;
    return { owner, applicationId: saved.applicationId, before: saved.before, after: saved.after };
  } catch { return null; }
}

export function writeFactCorrectionHistory(storage: SessionStore, owner: string, history: FactCorrectionHistory | null): void {
  try { storage.setItem(key(owner), JSON.stringify(history ? { ...history, version: 1 } : null)); }
  catch { /* Current-page Undo remains usable when browser storage is unavailable. */ }
}
