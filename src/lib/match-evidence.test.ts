import { describe, expect, it } from "vitest";
import { initialDemoState } from "./demo-data";
import { matchEvidence } from "./match-evidence";

describe("visible match evidence", () => {
  it("shows a literal confirmed fact instead of repeating the title", () => {
    const { profile, jobs } = initialDemoState();
    const job = jobs.find(item => item.id === "demo-engineering-intern")!;
    const evidence = matchEvidence(profile, job);
    expect(evidence.comparisons).toContainEqual({ requirement: "React", fact: "Built a React portfolio project", factId: "fact-react" });
    expect(evidence.headline).toContain("Your confirmed experience: Built a React portfolio project");
  });
  it("does not promote unconfirmed facts or partial words to supporting evidence", () => {
    const { profile, jobs } = initialDemoState();
    profile.facts = [{ id: "draft", text: "React", verified: false, source: "user" }, { id: "partial", text: "Reacting", verified: true, source: "user" }];
    expect(matchEvidence(profile, { ...jobs[0], requirements: ["React"] }).comparisons).toEqual([]);
  });
  it("labels listed skills separately when no confirmed fact mentions the term", () => {
    const { profile, jobs } = initialDemoState();
    const result = matchEvidence(profile, { ...jobs[0], requirements: ["User research"] });
    expect(result.comparisons).toEqual([]);
    expect(result.headline).toBe("Posting: User research · Skill you listed: User research");
  });
});
