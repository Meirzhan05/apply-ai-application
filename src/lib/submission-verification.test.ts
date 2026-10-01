import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication, canSubmit } from "@/lib/workflow";
import { checkSubmissionResult } from "@/lib/submission-verification";
import { hasActiveBrowser } from "@/lib/application-queue";
import type { AppState } from "@/lib/types";

const mocks = vi.hoisted(() => ({ state: undefined as unknown as AppState, check: vi.fn(), cancel: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/repository", () => ({ isDemo: () => true, loadState: async () => structuredClone(mocks.state), mutateState: async (_id: string, change: (state: AppState) => unknown) => change(mocks.state) }));
vi.mock("@/lib/browser-runner", () => ({ checkBrowserSubmission: mocks.check, cancelBrowser: mocks.cancel }));
vi.mock("@/lib/browser-provider", () => ({ remoteBrowserStatus: mocks.status }));
afterEach(() => vi.resetAllMocks());

function fixture() {
  mocks.state = initialDemoState();
  const app = selectApplication(mocks.state, mocks.state.jobs[0].id, mocks.state.profile.id);
  app.status = "awaiting_verification";
  app.browserSessionId = "existing-session";
  app.browserSessionExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  app.browserLiveUrl = "https://live.browser-use.com/fixture";
  app.submissionAttemptedAt = new Date().toISOString();
  app.submissionVerification = { version: 1, kind: "captcha", sessionId: app.browserSessionId, targetUrl: "https://employer.example/apply", attemptedAt: app.submissionAttemptedAt, beforeHash: "before", beforeHadConfirmation: false };
  app.submissionReceipt = { version: 1, url: "https://employer.example/apply", text: "Verification needed", capturedAt: new Date().toISOString() };
  mocks.cancel.mockResolvedValue(undefined);
  mocks.status.mockResolvedValue("active");
  mocks.check.mockResolvedValue({ confirmed: false, evidence: "Still verifying", verification: app.submissionVerification, receipt: app.submissionReceipt });
  return app;
}

describe("observation of an existing submission", () => {
  it("keeps the same attempt and browser after a repeated check, reserving the user's browser slot", async () => {
    const app = fixture(); const attemptedAt = app.submissionAttemptedAt;
    await checkSubmissionResult(app.userId, app.id);
    await checkSubmissionResult(app.userId, app.id);
    expect(app.status).toBe("awaiting_verification");
    expect(app.browserSessionId).toBe("existing-session");
    expect(app.submissionAttemptedAt).toBe(attemptedAt);
    expect(app.submissionVerificationCheck).toBeUndefined();
    expect(canSubmit(app)).toBe(false);
    expect(hasActiveBrowser(mocks.state, "another-application")).toBe(true);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });
  it("records proof only when observation confirms success, and refuses a second check", async () => {
    const app = fixture();
    mocks.check.mockResolvedValue({ confirmed: true, evidence: "Confirmation visible", receipt: { ...app.submissionReceipt, text: "Application received" } });
    await checkSubmissionResult(app.userId, app.id);
    expect(app.status).toBe("submitted");
    expect(app.submittedAt).toBeTruthy();
    expect(app.submissionReceipt?.text).toBe("Application received");
    expect(app.submissionVerification).toBeUndefined();
    expect(app.browserLiveUrl).toBeUndefined();
    expect(app.submissionAttemptedAt).toBeTruthy();
    await expect(checkSubmissionResult(app.userId, app.id)).rejects.toThrow(/No active verification/);
    expect(mocks.check).toHaveBeenCalledOnce();
  });
  it.each(["stop", "expiry"])("ends %s without reopening or losing the receipt", async (mode) => {
    const app = fixture(); const receipt = structuredClone(app.submissionReceipt);
    if (mode === "expiry") app.browserSessionExpiresAt = new Date(Date.now() - 1).toISOString();
    await checkSubmissionResult(app.userId, app.id, mode === "stop");
    expect(app.status).toBe("uncertain");
    expect(app.submissionReceipt).toEqual(receipt);
    expect(app.submissionAttemptedAt).toBeTruthy();
    expect(app.submissionVerification).toBeUndefined();
    expect(app.browserSessionId).toBeUndefined();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("preserves an active session when the read fails, then allows another observation", async () => {
    const app = fixture();
    mocks.check.mockRejectedValueOnce(new Error("Connection interrupted"));
    await expect(checkSubmissionResult(app.userId, app.id)).rejects.toThrow(/without resubmitting/);
    expect(app.status).toBe("awaiting_verification");
    expect(app.browserSessionId).toBe("existing-session");
    expect(app.submissionVerificationCheck).toBeUndefined();
    await checkSubmissionResult(app.userId, app.id);
    expect(app.error).toBeUndefined();
  });
  it("ends a known stopped provider session without clearing the submission attempt", async () => {
    const app = fixture();
    mocks.check.mockRejectedValue(new Error("Session missing")); mocks.status.mockResolvedValue("stopped");
    await expect(checkSubmissionResult(app.userId, app.id)).rejects.toThrow(/will not be retried/);
    expect(app.status).toBe("uncertain");
    expect(app.submissionAttemptedAt).toBeTruthy();
    expect(app.browserSessionId).toBeUndefined();
  });
  it.each(["other user", "wrong attempt", "wrong session", "concurrent check"])("refuses %s before contacting the browser", async (mode) => {
    const app = fixture();
    if (mode === "wrong attempt") app.submissionAttemptedAt = "different-attempt";
    if (mode === "wrong session") app.browserSessionId = "different-session";
    if (mode === "concurrent check") app.submissionVerificationCheck = { token: "other-request", startedAt: new Date().toISOString() };
    await expect(checkSubmissionResult(mode === "other user" ? "stranger" : app.userId, app.id)).rejects.toThrow();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
