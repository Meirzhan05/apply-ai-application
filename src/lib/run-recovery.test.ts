import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication } from "@/lib/workflow";
import { recoverStaleRuns } from "@/lib/run-recovery";

describe("stalled run recovery", () => {
  it("expires post-submit verification without authorizing another attempt", () => {
    const state = initialDemoState(); const now = Date.now();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "awaiting_verification"; app.browserSessionId = "saved-attempt";
    app.browserSessionExpiresAt = new Date(now - 1).toISOString(); app.submissionAttemptedAt = new Date(now - 60_000).toISOString();
    app.submissionReceipt = { version: 1, url: "https://example.org", text: "CAPTCHA", capturedAt: new Date(now).toISOString() };
    expect(recoverStaleRuns(state, now)).toHaveLength(1);
    expect(app.status).toBe("uncertain");
    expect(app.submissionAttemptedAt).toBeTruthy();
    expect(app.submissionReceipt?.text).toBe("CAPTCHA");
    expect(app.browserSessionId).toBeUndefined();
    expect(app.confirmation).toMatch(/no automatic retry/);
  });
  it("keeps the same browser after a stopped question continuation and clears its lock", () => {
    const state = initialDemoState(); const now = Date.now();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "filling"; app.browserSessionId = "saved-session";
    app.browserSessionCreatedAt = new Date(now).toISOString();
    app.browserQuestionRun = { token: "stopped", kind: "answers", startedAt: new Date(now - 6 * 60_000).toISOString() };
    expect(recoverStaleRuns(state, now)).toEqual([]);
    expect(app.status).toBe("needs_user_action");
    expect(app.browserSessionId).toBe("saved-session");
    expect(app.browserQuestionRun).toBeUndefined();
    expect(app.error).toMatch(/refresh the form/);
  });
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
  it("uses the cloud provider deadline even when the local creation time differs", () => {
    const now = Date.now();
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "approved_to_submit";
    app.browserProvider = "browser-use";
    app.browserSessionId = "cloud-session";
    app.browserLiveUrl = "https://live.browser-use.com/";
    app.browserConnectUrl = "https://session.cdp.browser-use.com/";
    app.browserSessionCreatedAt = new Date(now - 31 * 60_000).toISOString();
    app.browserSessionExpiresAt = new Date(now + 1000).toISOString();
    app.approvals.push({ version: 1, id: "test", kind: "submit", userId: app.userId, applicationId: app.id, targetUrl: "https://example.org", reviewHash: "old", createdAt: app.updatedAt });
    expect(recoverStaleRuns(state, now)).toEqual([]);
    expect(app.approvals).toHaveLength(1);
    const [closed] = recoverStaleRuns(state, now + 1000);
    expect(closed.browserProvider).toBe("browser-use");
    expect(closed.browserSessionId).toBe("cloud-session");
    expect(app.status).toBe("needs_user_action");
    expect(app.browserLiveUrl).toBeUndefined();
    expect(app.browserConnectUrl).toBeUndefined();
    expect(app.approvals).toHaveLength(0);
  });
});

it("recovers a durable pre-click claim as observation only without closing the original unexpired session", () => {
  const state = initialDemoState(); const now = Date.now(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  app.status = "submitting"; app.updatedAt = new Date(now - 11 * 60_000).toISOString(); app.browserSessionId = "original"; app.browserSessionExpiresAt = new Date(now + 60_000).toISOString(); app.submissionAttemptedAt = new Date(now - 11 * 60_000).toISOString();
  app.submissionVerification = { version: 1, kind: "captcha", sessionId: "original", targetUrl: state.jobs[0].applyUrl, attemptedAt: app.submissionAttemptedAt, beforeHash: "before", beforeHadConfirmation: false };
  expect(recoverStaleRuns(state, now)).toEqual([]); expect(app.status).toBe("awaiting_verification"); expect(app.browserSessionId).toBe("original"); expect(app.submissionAttemptedAt).toBeTruthy();
});
