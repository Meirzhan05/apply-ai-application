import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { mergeCurrentSourceFacts } from "@/lib/profile-source-facts";

it("adds worker-discovered source facts to profile review without discarding local confirmations", () => {
  const current = structuredClone(initialDemoState().profile);
  current.facts = [{ id: "existing", text: "Locally edited fact", verified: true, source: "resume" }];
  const latest = structuredClone(current);
  latest.resumeFileName = "source.pdf";
  latest.resumeText = "Current extracted source";
  latest.facts.push({ id: "pending-source-fact", text: "Confirm this source claim", verified: false, source: "resume", sourceAnchorId: "anchor-1" });

  const merged = mergeCurrentSourceFacts(current, latest);

  expect(merged.resumeFileName).toBe("source.pdf");
  expect(merged.resumeText).toBe("Current extracted source");
  expect(merged.facts).toEqual([
    { id: "existing", text: "Locally edited fact", verified: true, source: "resume" },
    { id: "pending-source-fact", text: "Confirm this source claim", verified: false, source: "resume", sourceAnchorId: "anchor-1" },
  ]);
  expect(mergeCurrentSourceFacts(current, { ...latest, id: "another-account" })).toBe(current);
});
