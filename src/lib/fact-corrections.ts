import { z } from "zod";
import type { VerifiedFact } from "@/lib/types";

export const sourceFactSchema = z.object({
  id: z.string().min(1), text: z.string().min(1).max(500),
  verified: z.boolean(), source: z.enum(["resume", "user"]),
  sourceAnchorId: z.string().max(160).optional(),
});

const factPatchSchema = z.object({
  expected: z.array(sourceFactSchema).min(1).max(80),
  updated: z.array(sourceFactSchema).min(1).max(80),
});

export function sameSourceFact(a: VerifiedFact, b: VerifiedFact) {
  return a.id === b.id && a.text === b.text && a.verified === b.verified &&
    a.source === b.source && a.sourceAnchorId === b.sourceAnchorId;
}

/** Replace only the reviewed facts, atomically, without overwriting newer edits. */
export function applyFactCorrection(current: VerifiedFact[], input: unknown): VerifiedFact[] {
  const { expected, updated } = factPatchSchema.parse(input);
  const ids = new Set(expected.map(fact => fact.id));
  if (ids.size !== expected.length || new Set(updated.map(fact => fact.id)).size !== updated.length ||
      updated.length !== expected.length || updated.some(fact => !ids.has(fact.id))) {
    throw new Error("The source fact selection changed. Close corrections and review the current facts.");
  }
  if (expected.some(fact => !current.some(item => sameSourceFact(item, fact)))) {
    throw new Error("These source facts changed since you opened them. Your corrections are preserved; copy any wording you need, then close and review the current facts.");
  }
  return current.map(fact => updated.find(item => item.id === fact.id) ?? fact);
}
