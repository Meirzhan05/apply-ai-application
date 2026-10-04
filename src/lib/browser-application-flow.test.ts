import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  prepare: vi.fn<typeof import("@/lib/browser-runner").prepareBrowser>(),
  submit: vi.fn<typeof import("@/lib/browser-runner").submitBrowser>(),
}));
vi.mock("@/lib/repository", () => ({
  isDemo: () => true,
  loadState: async () => structuredClone(fixture.state!),
  mutateState: async (_owner: string, change: (state: AppState) => unknown) => change(fixture.state!),
}));
vi.mock("@/lib/browser-runner", () => ({
  prepareBrowser: fixture.prepare,
  submitBrowser: fixture.submit,
  cancelBrowser: vi.fn(),
  refreshBrowserSnapshot: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn() }));

import { initialDemoState } from "@/lib/demo-data";
import { draftPacket, packetProfileHash } from "@/lib/drafting";
import { approveFill, approveSubmit, selectApplication, setPacket, transition } from "@/lib/workflow";
import { runFill } from "@/lib/application-runs";
import { runSubmission } from "@/lib/application-submission";
import { completeOnboardingFixture } from "@/lib/testing/onboarding";

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("EMAIL_FROM", "");
  vi.stubEnv("DEMO_MODE", "true");
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected direct employer request"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each([
  ["greenhouse", "https://job-boards.greenhouse.io/example/jobs/12345"],
  ["lever", "https://jobs.lever.co/example/12345"],
  ["ashby", "https://jobs.ashbyhq.com/example/12345"],
] as const)("prepares and submits %s applications through the reviewed browser once", async (provider, url) => {
  const state = initialDemoState();
  const packet = await draftPacket(state.profile, state.jobs[0]);
  state.profile = completeOnboardingFixture(state.profile);
  packet.profileHash = packetProfileHash(state.profile);
  packet.answers = [];
  const job = { ...state.jobs[0], id: `${provider}:example:12345`, source: provider,
    sourceId: "12345", url, applyUrl: url };
  state.jobs[0] = job;
  const app = selectApplication(state, job.id, state.profile.id);
  setPacket(state, app, packet);
  approveFill(app, state.profile.id, app.packetHash!, url);
  transition(app, ["authorized_to_fill"], "filling");
  app.runToken = "browser-fill-test";
  fixture.state = state;
  const resume = app.packet!.files!.find((file) => file.kind === "resume")!;
  const attachment = `${resume.filename}:${resume.size}:${resume.sha256}`;
  fixture.prepare.mockResolvedValue({
    sessionId: "reviewed-browser", needsAction: false, needsCoverLetter: false,
    form: { version: 1, url, capturedAt: new Date().toISOString(), readyToSubmit: true, blockers: [],
      fields: [
        { identifier: "email", label: "Email", kind: "email", value: state.profile.email },
        { identifier: "resume", label: "Resume", kind: "file", value: resume.filename, fileHashes: [attachment] },
      ], attachments: [attachment], submitControl: { label: "Submit application", identifier: "submit" } },
  });

  expect(await runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken })).toEqual({ needsAction: false });
  expect(fixture.prepare).toHaveBeenCalledTimes(1);
  expect(app.status).toBe("final_review");
  expect(app.browserSessionId).toBe("reviewed-browser");
  expect(app.form?.url).toBe(url);
  expect(app.submissionAttemptedAt).toBeUndefined();

  // A delivered submit task cannot bypass final approval.
  app.status = "submitting";
  expect(await runSubmission({ userId: state.profile.id, applicationId: app.id })).toEqual({ skipped: true });
  expect(fixture.submit).not.toHaveBeenCalled();
  app.status = "final_review";
  approveSubmit(app, state.profile.id, app.form!.hash);
  transition(app, ["approved_to_submit"], "submitting");
  fixture.submit.mockImplementation(async (application, options) => {
    expect(application.browserSessionId).toBe("reviewed-browser");
    const accepted = await options!.beforeAttempt({ version: 1, kind: "captcha", sessionId: "reviewed-browser",
      targetUrl: url, attemptedAt: new Date().toISOString(), beforeHash: application.form!.hash, beforeHadConfirmation: false });
    expect(accepted).toBe(true);
    return { confirmed: true, evidence: "Application received", receipt: {
      version: 1, url, text: "Application received", capturedAt: new Date().toISOString() } };
  });

  expect(await runSubmission({ userId: state.profile.id, applicationId: app.id })).toEqual({ confirmed: true, awaitingVerification: false });
  expect(app.status).toBe("submitted");
  expect(app.submissionAttemptedAt).toBeTruthy();
  expect(app.submissionMaterials?.files).toEqual([resume]);
  expect(await runSubmission({ userId: state.profile.id, applicationId: app.id })).toEqual({ skipped: true });
  expect(fixture.submit).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});
