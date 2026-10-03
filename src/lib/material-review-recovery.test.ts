import { expect, it } from "vitest";
import { initialDemoState } from "./demo-data";
import { selectApplication } from "./workflow";
import { canReturnToMaterials, returnToMaterials } from "./material-review-recovery";

it("returns idle pre-submission attempts to review and removes earlier permission", () => {
  for (const status of ["authorized_to_fill", "needs_user_action", "final_review", "approved_to_submit"] as const) {
    const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = status; app.browserSessionId = "old-session";
    app.approvals = [{ version: 1, id: "approval", kind: "fill", userId: app.userId, applicationId: app.id, targetUrl: "https://example.com", reviewHash: "old", createdAt: new Date().toISOString() }];
    returnToMaterials(app);
    expect(app.status).toBe("draft_review"); expect(app.approvals).toEqual([]); expect(app.browserSessionId).toBeUndefined();
  }
});

it("preserves attempts that have started submission or have active work", () => {
  const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  app.status = "final_review"; app.submissionAttemptedAt = new Date().toISOString();
  expect(canReturnToMaterials(app)).toBe(false); expect(() => returnToMaterials(app)).toThrow(/cannot return/);
  expect(app.status).toBe("final_review");
  app.submissionAttemptedAt = undefined; app.browserQuestionRun = { token: "work", startedAt: new Date().toISOString(), kind: "answers" };
  expect(canReturnToMaterials(app)).toBe(false);
  for (const status of ["filling", "submitting", "uncertain", "awaiting_verification", "submitted", "cancelled"] as const) {
    app.status = status; expect(canReturnToMaterials(app)).toBe(false);
  }
});
