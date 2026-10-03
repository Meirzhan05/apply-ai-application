import { describe, expect, it } from "vitest";
import { applyFactCorrection } from "./fact-corrections";
import type { VerifiedFact } from "./types";

describe("source fact corrections", () => {
  const original: VerifiedFact = { id: "a", text: "Built a survey tool", verified: true, source: "resume", sourceAnchorId: "anchor-a" };
  const corrected: VerifiedFact = { id: "a", text: "Built a coursework survey tool", verified: false, source: "user" };
  const unrelated: VerifiedFact = { id: "b", text: "New fact from another session", verified: true, source: "user" };
  it("applies and undoes only reviewed facts while preserving unrelated edits", () => {
    const next = applyFactCorrection([original, unrelated], { expected: [original], updated: [corrected] });
    expect(next).toEqual([corrected, unrelated]);
    const newer = { ...unrelated, text: "Another concurrent edit" };
    expect(applyFactCorrection([corrected, newer], { expected: [corrected], updated: [original] })).toEqual([original, newer]);
  });
  it.each<VerifiedFact>([
    { ...original, text: "Changed" }, { ...original, verified: false },
    { ...original, source: "user" }, { ...original, sourceAnchorId: "other-anchor" },
  ])("rejects stale fact attributes before applying", changed => {
    expect(() => applyFactCorrection([changed], { expected: [original], updated: [corrected] })).toThrow(/changed since/);
  });
  it("rejects missing facts and inconsistent selections", () => {
    expect(() => applyFactCorrection([], { expected: [original], updated: [corrected] })).toThrow(/changed since/);
    for (const updated of [[unrelated], [corrected, corrected], []]) {
      expect(() => applyFactCorrection([original], { expected: [original], updated })).toThrow();
    }
    expect(() => applyFactCorrection([original], { expected: [original, original], updated: [corrected, corrected] })).toThrow(/selection changed/);
  });
});
