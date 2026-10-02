import { describe, expect, it } from "vitest";
import { demoJobs } from "@/lib/demo-data";
import { matchView, type MatchFilter } from "@/lib/match-view";
import type { JobFeedback, MatchAssessment } from "@/lib/types";

const jobs = [...demoJobs, { ...demoJobs[0], id: "closed", active: false }];
const matches = new Map<string, Pick<MatchAssessment, "category">>([
  [jobs[0].id, { category: "possible" }], [jobs[1].id, { category: "strong" }],
  [jobs[2].id, { category: "possible" }], ["closed", { category: "strong" }],
  ["no-longer-in-catalog", { category: "strong" }],
]);
const feedback = new Map<string, Pick<JobFeedback, "kind">>([
  [jobs[0].id, { kind: "dismissed" }], [jobs[1].id, { kind: "saved" }],
  ["closed", { kind: "saved" }], ["no-longer-in-catalog", { kind: "saved" }],
]);

describe("Matches result counts", () => {
  it("excludes dismissed, closed and stale records from every count", () => {
    const view = matchView({ jobs, matches, feedback, filter: "all", search: "" });
    expect(view.availableCount).toBe(2);
    expect(view.counts).toEqual({ all: 2, strong: 1, possible: 1, uncertain: 0, saved: 1 });
    expect(view.jobs.map(job => job.id)).toEqual([jobs[1].id, jobs[2].id]);
  });
  it("counts the searched population and keeps every category consistent with its rows", () => {
    for (const filter of ["all", "strong", "possible", "uncertain", "saved"] as MatchFilter[]) {
      const view = matchView({ jobs, matches, feedback, filter, search: "  CEDAR engineering  " });
      expect(view.counts).toEqual({ all: 1, strong: 1, possible: 0, uncertain: 0, saved: 1 });
      expect(view.jobs).toHaveLength(view.counts[filter]);
    }
  });
  it("keeps hard-rule conflicts visible under All without calling them an uncertain fit", () => {
    const conflicts = new Map(matches);
    conflicts.set(jobs[2].id, { category: "excluded" });
    const view = matchView({ jobs, matches: conflicts, feedback, filter: "all", search: "" });
    expect(view.jobs).toHaveLength(2);
    expect(view.counts.possible).toBe(0);
    expect(view.counts.uncertain).toBe(0);
  });
});
