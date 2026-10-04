import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { updateJobFeedback } from "@/lib/job-feedback";

describe("reversible job feedback", () => {
  it("rejects a batch from a previous workspace without changing this owner", () => {
    const state = initialDemoState();
    expect(() => updateJobFeedback(state, { jobId: state.jobs[0].id, kind: "saved", expectedOwnerId: "another-owner" })).toThrow("workspace changed");
    expect(state.feedback).toEqual([]);
  });
  it("rejects a stale batch save without overwriting a concurrent dismissal", () => {
    const state = initialDemoState(); const jobId = state.jobs[0].id;
    updateJobFeedback(state, { jobId, kind: "dismissed", reason: "Not my role" });
    const before = structuredClone(state.feedback);
    expect(() => updateJobFeedback(state, { jobId, kind: "saved", expectedKind: "clear" })).toThrow("collection changed");
    expect(state.feedback).toEqual(before);
  });
  it("allows a guarded save when a role is still unsaved", () => {
    const state = initialDemoState();
    updateJobFeedback(state, { jobId: state.jobs[0].id, kind: "saved", expectedKind: "clear" });
    expect(state.feedback[0].kind).toBe("saved");
  });
  it("removes a save without leaving a ranking signal or touching other roles", () => {
    const state = initialDemoState();
    for (const job of state.jobs.slice(0, 2)) updateJobFeedback(state, { jobId: job.id, kind: "saved" });
    const other = structuredClone(state.feedback[1]);
    expect(updateJobFeedback(state, { jobId: state.jobs[0].id, kind: "clear" }).label).toBe("Removed from saved");
    expect(state.feedback).toEqual([other]);
  });
  it("restores dismissed roles and can undo dismissal back to a saved state", () => {
    const state = initialDemoState();
    const jobId = state.jobs[0].id;
    updateJobFeedback(state, { jobId, kind: "dismissed", reason: "Wrong role" });
    expect(updateJobFeedback(state, { jobId, kind: "clear" }).label).toBe("Role restored");
    expect(state.feedback).toEqual([]);
    updateJobFeedback(state, { jobId, kind: "saved" });
    updateJobFeedback(state, { jobId, kind: "dismissed", reason: "Wrong role" });
    updateJobFeedback(state, { jobId, kind: "saved" });
    expect(state.feedback).toHaveLength(1);
    expect(state.feedback[0].kind).toBe("saved");
    expect(state.feedback[0].reason).toBeUndefined();
  });
  it("rejects unavailable jobs without changing existing feedback", () => {
    const state = initialDemoState();
    updateJobFeedback(state, { jobId: state.jobs[0].id, kind: "saved" });
    const previous = structuredClone(state.feedback);
    expect(() => updateJobFeedback(state, { jobId: "other-owner-only-job", kind: "clear" })).toThrow("Job not found.");
    expect(state.feedback).toEqual(previous);
  });
});
