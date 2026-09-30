import { describe, expect, it } from "vitest";
import { feedbackAdjustment, compareRankedJobs } from "@/lib/ranking";
import { initialDemoState } from "@/lib/demo-data";
import type { JobFeedback } from "@/lib/types";

describe("persistent feedback ranking", () => {
  it("uses the owner-reviewed context after the old posting leaves the active catalog", () => {
    const template = initialDemoState().jobs[0];
    const future = { ...template, id: "future", title: "Junior Data Analyst", requirements: ["Python analytics"] };
    const feedback: JobFeedback[] = [{ jobId: "closed", kind: "dismissed", reason: "Wrong role", updatedAt: "2026-09-29", jobSnapshot: { title: "Junior Data Analyst", requirements: ["Python analytics"], location: template.location } }];
    expect(feedbackAdjustment(future, feedback, [future])).toBe(-8);
    feedback[0].kind = "saved";
    expect(feedbackAdjustment(future, feedback, [future])).toBe(8);
  });
  it("uses the same AI score and saved-job bonus on both surfaces", () => {
    const template = initialDemoState().jobs[0];
    const saved = { ...template, id: "saved", title: "Analyst", requirements: [] };
    const other = { ...template, id: "other", title: "Engineer", requirements: [] };
    const feedback: JobFeedback[] = [{ jobId: saved.id, kind: "saved", updatedAt: "2026-09-29" }];
    const assessments = new Map([[saved.id, { score: 80 }], [other.id, { score: 90 }]]);
    expect(compareRankedJobs(saved, other, assessments, feedback, [saved, other])).toBeLessThan(0);
  });
  it("places fresh postings first when ranking scores tie", () => {
    const template = initialDemoState().jobs[0];
    const old = { ...template, id: "old", discoveredAt: "2026-09-29T00:00:00Z" };
    const fresh = { ...template, id: "fresh", discoveredAt: "2026-09-30T00:00:00Z" };
    expect(compareRankedJobs(old, fresh, new Map(), [], [old, fresh])).toBeGreaterThan(0);
  });
});
