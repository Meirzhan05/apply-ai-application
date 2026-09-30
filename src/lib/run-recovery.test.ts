import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication } from "@/lib/workflow";
import { recoverStaleRuns } from "@/lib/run-recovery";

describe("stalled run recovery", () => {
  it("recovers drafts and fills but never retries a possibly successful submit", () => {
    const state = initialDemoState();
    for (const [index, status] of (["drafting", "filling", "submitting"] as const).entries()) {
      const app = selectApplication(state, state.jobs[index].id, state.profile.id);
      app.status = status; app.updatedAt = new Date(Date.now() - (status === "drafting" ? 13 : 11) * 60 * 1000).toISOString();
    }
    expect(recoverStaleRuns(state)).toHaveLength(3);
    expect(state.applications.map((app) => app.status)).toEqual(["uncertain", "authorized_to_fill", "selected"]);
    expect(state.applications[0].error).toMatch(/no automatic retry/);
    expect(recoverStaleRuns(state)).toEqual([]);
  });
  it("lets the longer LaTeX draft finish before recovery", () => {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "drafting"; app.updatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect(recoverStaleRuns(state)).toEqual([]);
    expect(app.status).toBe("drafting");
  });
  it("expires a reviewed session and removes final approval", () => {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "approved_to_submit";
    app.browserSessionId = "old-session";
    app.browserSessionCreatedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    app.approvals.push({ version: 1, id: "test", kind: "submit", userId: app.userId, applicationId: app.id, targetUrl: "https://example.org", reviewHash: "old", createdAt: app.updatedAt });
    expect(recoverStaleRuns(state)).toHaveLength(1);
    expect(app.status).toBe("needs_user_action");
    expect(app.browserSessionId).toBeUndefined();
    expect(app.approvals).toHaveLength(0);
  });
});
