import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { draftPacket } from "@/lib/drafting";
import { approveFill, approveSubmit, selectApplication, setFormSnapshot, setPacket, transition } from "@/lib/workflow";
import type { AppState } from "@/lib/types";
import { submitApplicationForm } from "../../trigger/browser";

const mocks = vi.hoisted(() => ({ state: undefined as unknown as AppState, submit: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@trigger.dev/sdk", () => ({ task: (config: unknown) => config }));
vi.mock("@/lib/application-runs", () => ({ runFill: vi.fn() }));
vi.mock("@/lib/repository", () => ({ loadState: async () => structuredClone(mocks.state), mutateState: async (_id: string, change: (state: AppState) => unknown) => change(mocks.state) }));
vi.mock("@/lib/browser-runner", () => ({ submitBrowser: mocks.submit, cancelBrowser: mocks.cancel, refreshBrowserSnapshot: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

const run = (submitApplicationForm as unknown as { run: (payload: { userId: string; applicationId: string }) => Promise<Record<string, unknown>> }).run;

describe("eligibility changes after form review", () => {
  it("persists a post-click challenge as awaiting verification and skips duplicate workers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    mocks.state = initialDemoState(); const state = mocks.state; const job = state.jobs[0];
    const app = selectApplication(state, job.id, state.profile.id);
    const packet = await draftPacket(state.profile, job); packet.answers = [];
    setPacket(state, app, packet); approveFill(app, app.userId, app.packetHash!, job.applyUrl);
    setFormSnapshot(app, { version: 1, url: job.applyUrl, fields: [], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: true });
    approveSubmit(app, app.userId, app.form!.hash); transition(app, ["approved_to_submit"], "submitting");
    app.submissionStartedAt = new Date().toISOString(); app.browserSessionId = "reviewed-session";
    mocks.submit.mockImplementationOnce(async (copy) => {
      copy.submissionAttemptedAt = new Date().toISOString();
      return { confirmed: false, evidence: "Complete employer verification", receipt: { version: 1, url: job.applyUrl, text: "Verification", capturedAt: new Date().toISOString() }, verification: { version: 1, kind: "captcha", sessionId: copy.browserSessionId, attemptedAt: copy.submissionAttemptedAt, targetUrl: job.applyUrl, beforeHash: "before", beforeHadConfirmation: false } };
    });
    expect(await run({ userId: app.userId, applicationId: app.id })).toMatchObject({ awaitingVerification: true });
    expect(app.status).toBe("awaiting_verification"); expect(app.submissionAttemptedAt).toBeTruthy();
    expect(app.submissionVerification?.attemptedAt).toBe(app.submissionAttemptedAt);
    expect(app.browserSessionId).toBe("reviewed-session"); expect(app.submissionReceipt?.text).toBe("Verification");
    expect(await run({ userId: app.userId, applicationId: app.id })).toEqual({ skipped: true });
    expect(mocks.submit).toHaveBeenCalledOnce(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each(["closed", "deadline", "required rule", "employment sponsorship"])("pauses %s before the submit click and releases the browser", async (scenario) => {
    vi.stubEnv("OPENAI_API_KEY", "");
    mocks.state = initialDemoState();
    const state = mocks.state;
    const job = state.jobs[0];
    const app = selectApplication(state, job.id, state.profile.id);
    const packet = await draftPacket(state.profile, job);
    packet.answers = [];
    setPacket(state, app, packet);
    approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
    setFormSnapshot(app, { version: 1, url: job.applyUrl, fields: [], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: true });
    approveSubmit(app, state.profile.id, app.form!.hash);
    transition(app, ["approved_to_submit"], "submitting");
    app.submissionStartedAt = new Date().toISOString();
    app.browserSessionId = "synthetic-reviewed-session";
    if (scenario === "closed") job.active = false;
    else if (scenario === "deadline") job.deadline = new Date(Date.now() - 1000).toISOString();
    else if (scenario === "employment sponsorship") { state.profile.workAuthorization = "Requires sponsorship"; job.description = "No visa sponsorship is available."; }
    else { state.profile.remoteOnly = true; job.remote = false; }
    const result = await run({ userId: app.userId, applicationId: app.id });
    expect(result.blocked).toBe(true);
    expect(app.status).toBe("needs_user_action");
    expect(app.error).toContain("No submission was attempted.");
    expect(app.submissionAttemptedAt).toBeUndefined();
    expect(app.submissionStartedAt).toBeUndefined();
    expect(app.browserSessionId).toBeUndefined();
    expect(app.form).toBeUndefined();
    expect(app.approvals.map((approval) => approval.kind)).toEqual(["fill"]);
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(await run({ userId: app.userId, applicationId: app.id })).toEqual({ skipped: true });
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });
});
