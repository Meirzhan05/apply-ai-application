import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { activateAutomation, saveOnboarding } from "@/lib/onboarding";
import type { AppState, Job } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: null as AppState | null, budget: true, releases: 0, releaseMonths: [] as string[], currentMonth: "2026-10", reserveError: undefined as Error | undefined, releaseError: undefined as Error | undefined, onReserve: undefined as (() => void) | undefined }));
vi.mock("@/lib/repository", () => ({
  loadState: async () => structuredClone(fixture.state),
  mutateState: async (_userId: string, change: (state: AppState) => unknown) => change(fixture.state!),
}));
vi.mock("@/lib/budget", () => ({ serviceBudgetMonth: () => fixture.currentMonth, browserBudgetReservationId: (applicationId: string, attemptId: string) => `browser:${applicationId}:${attemptId}`, reserveBrowserBudget: async (_userId: string, _applicationId: string, _attemptId: string, month: string) => { fixture.onReserve?.(); if (fixture.reserveError) throw fixture.reserveError; if (month !== "2026-10") throw new Error(`unexpected reservation month ${month}`); return fixture.budget; }, releaseBrowserBudget: async (_userId: string, _applicationId: string, _attemptId: string, month?: string) => { fixture.releaseMonths.push(month ?? "missing"); if (fixture.releaseError) throw fixture.releaseError; fixture.releases++; return true; } }));
vi.mock("@/lib/browser-runner", () => ({ preflightBrowser: vi.fn() }));

import { runImportedPreflight, preflightStatus } from "@/lib/import-preflight";

function setup() {
  const state = initialDemoState();
  saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } });
  activateAutomation(state.profile, "preflight test");
  const job: Job = { ...state.jobs[0], id: "imported-public", source: "imported", sourceId: "public-42", sourceLabel: "Imported link", company: "Example Employer", title: "Data Analyst", url: "https://careers.example.com/jobs/42", applyUrl: "https://careers.example.com/jobs/42/apply", importUrl: "https://careers.example.com/jobs/42", importCheck: { status: "manual", checkedAt: "2026-10-01T00:00:00.000Z" } };
  state.jobs = [job];
  fixture.state = state;
  fixture.budget = true;
  fixture.releases = 0;
  fixture.releaseMonths = [];
  fixture.currentMonth = "2026-10";
  fixture.reserveError = undefined;
  fixture.releaseError = undefined;
  fixture.onReserve = undefined;
  return { state, job };
}

const result = (overrides: Record<string, unknown> = {}) => ({
  form: { version: 1 as const, url: "https://careers.example.com/jobs/42/application", fields: [{ label: "Email", value: "", identifier: "email", kind: "email", required: true, valid: false }], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: false, blockers: ["Correct or complete the field: Email"], submitControl: { label: "Submit application", identifier: "submit", action: "https://careers.example.com/jobs/42/submit", method: "post" } },
  contextHash: "context-proof",
  postingContext: { title: "Data Analyst", company: "Example Employer", location: "New York, NY", text: "Data Analyst at Example Employer" },
  postingEvidence: { postingUrl: "https://careers.example.com/jobs/42", postingIdentityHash: "posting-identity-proof", title: "Data Analyst", company: "Example Employer", markers: ["Data Analyst", "Example Employer"], identityHash: "identity-proof" },
  sessionId: "preflight-session",
  provider: "browser-use" as const,
  ...overrides,
});

describe("imported employer preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it.each(["Remote", "Worldwide", "London, United Kingdom"])("blocks filling when an inspected manual posting has no verified US destination: %s", async (location) => {
    const { job } = setup();
    job.location = "Location not listed";
    const outcome = await runImportedPreflight("demo-user", job.id, async () => result({ postingContext: { title: job.title, company: job.company, location, text: "US company hiring internationally" } }));
    expect(outcome.status).toBe("blocked");
    expect(outcome.record.blocker).toMatch(/US.*destination|destination.*US/);
    expect(fixture.state!.applications[0].packet).toBeUndefined();
    expect(fixture.state!.applications[0].autonomousAuthorization).toBeUndefined();
  });

  it("can inspect an unresolved manual import and verify its explicit US location", async () => {
    const { job } = setup();
    job.location = "Remote";
    const outcome = await runImportedPreflight("demo-user", job.id, async () => result({ postingContext: { location: "Remote (US)", text: "Data Analyst at Example Employer" } }));
    expect(outcome.status).toBe("reachable");
    expect(outcome.record.observedContext?.location).toBe("Remote (US)");
    expect(fixture.state!.applications[0].packet).toBeUndefined();
  });

  it("claims before observation and persists reachable proof without an attempt", async () => {
    const { job } = setup();
    const observe = vi.fn(async (_app, _job, onSession) => { expect(await onSession({ sessionId: "preflight-session", provider: "browser-use" })).toBe(true); return result(); });
    const outcome = await runImportedPreflight("demo-user", job.id, observe);
    const app = fixture.state!.applications[0];
    expect(outcome.status).toBe("reachable");
    expect(app.importedCompatibility).toMatchObject({ status: "reachable", formUrl: "https://careers.example.com/jobs/42/application", postingEvidence: { company: "Example Employer" } });
    expect(app.importedOutcome).toMatchObject({ kind: "reachable" });
    expect(app.importedPreflight).toBeUndefined();
    expect(app.submissionAttemptedAt).toBeUndefined();
    expect(app.browserSessionId).toBeUndefined();
    expect(fixture.releases).toBe(0);
  });

  it("blocks a page whose observed identity cannot corroborate the imported employer", async () => {
    const { job } = setup();
    const observe = vi.fn(async () => result({ postingEvidence: { postingUrl: job.url, postingIdentityHash: "other-posting", title: "Different Role", company: "Different Employer", markers: ["Different Role", "Different Employer"], identityHash: "other" } }));
    const outcome = await runImportedPreflight("demo-user", job.id, observe);
    expect(outcome.status).toBe("blocked");
    expect(fixture.state!.applications[0].importedCompatibility?.blocker).toMatch(/did not corroborate/);
    expect(fixture.state!.applications[0].autonomousAuthorization).toBeUndefined();
  });

  it("persists an ordinary login failure as a typed review blocker after the session closes", async () => {
    const { job } = setup();
    const outcome = await runImportedPreflight("demo-user", job.id, async () => { throw new Error("The employer page requires sign in before it can be checked."); });
    const app = fixture.state!.applications[0];
    expect(outcome.status).toBe("blocked");
    expect(app.importedOutcome).toMatchObject({ kind: "blocked" });
    expect(app.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "login", progress: "blocked" })]));
    expect(app.browserSessionId).toBeUndefined();
    expect(app.browserReleasePending).toBeUndefined();
    expect(app.importedPreflight).toBeUndefined();
  });

  it("does not allocate a second preflight while a durable claim is active", async () => {
    const { job } = setup();
    fixture.state!.applications.push({ id: "existing", userId: "demo-user", jobId: job.id, jobSnapshot: job, status: "selected", approvals: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), importedPreflight: { token: "held", startedAt: new Date().toISOString() } });
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/already running/);
  });

  it("does not open a browser when the budget reservation is denied", async () => {
    const { job } = setup();
    fixture.budget = false;
    const observe = vi.fn(async () => result());
    await expect(runImportedPreflight("demo-user", job.id, observe)).rejects.toThrow(/spending limit/);
    expect(observe).not.toHaveBeenCalled();
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
    expect(fixture.state!.applications[0].browserSessionId).toBeUndefined();
  });

  it("compensates a reservation when the application drifts before browser allocation", async () => {
    const { job } = setup();
    fixture.onReserve = () => { fixture.state!.applications[0].status = "cancelled"; };
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/changed before browser allocation/);
    expect(fixture.releases).toBe(1);
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
    expect(fixture.releaseMonths).toEqual(["2026-10"]);
  });

  it("keeps an uncertain allocation claim when the provider fails before returning a session", async () => {
    const { job } = setup();
    const observe = vi.fn(async () => { throw Object.assign(new Error("Browser Use Cloud could not be reached."), { allocationUncertain: true }); });
    const outcome = await runImportedPreflight("demo-user", job.id, observe);
    const app = fixture.state!.applications[0];
    expect(outcome.status).toBe("blocked");
    expect(app.importedPreflight).toMatchObject({ allocationUncertain: true, budgetMonth: "2026-10" });
    expect(app.browserSessionId).toBeUndefined();
    expect(fixture.releases).toBe(0);
  });

  it("keeps a claim when reservation transport outcome is unknown", async () => {
    const { job } = setup();
    fixture.reserveError = new Error("budget transport failed");
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow("budget transport failed");
    expect(fixture.state!.applications[0].importedPreflight).toMatchObject({ allocationUncertain: true });
    expect(fixture.releases).toBe(0);
  });

  it("clears a proven configuration failure without attempting compensation", async () => {
    const { job } = setup();
    fixture.reserveError = Object.assign(new Error("Monthly spending limit is not configured correctly."), { budgetNeverAllocated: true });
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/not configured/);
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
    expect(fixture.releases).toBe(0);
  });

  it("records a retryable compensation marker when an unused refund fails", async () => {
    const { job } = setup();
    fixture.onReserve = () => { fixture.state!.applications[0].status = "cancelled"; };
    fixture.releaseError = new Error("release transport failed");
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/changed before browser allocation/);
    expect(fixture.state!.applications[0].importedPreflight?.budgetReleasePending).toMatchObject({ month: "2026-10" });
  });

  it("uses the month captured before reservation across a UTC rollover", async () => {
    const { job } = setup();
    fixture.onReserve = () => { fixture.currentMonth = "2026-11"; fixture.state!.applications[0].status = "cancelled"; };
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/changed before browser allocation/);
    expect(fixture.releaseMonths).toEqual(["2026-10"]);
  });

  it("compensates a reservation when automation is paused before browser allocation", async () => {
    const { job } = setup();
    fixture.onReserve = () => { fixture.state!.profile.automationAuthorization!.status = "paused"; };
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/Complete onboarding and enable/);
    expect(fixture.releases).toBe(1);
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
  });

  it("compensates a reservation when the claimed application is removed before allocation", async () => {
    const { job } = setup();
    fixture.onReserve = () => { fixture.state!.applications.splice(0, 1); };
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/could not be loaded/);
    expect(fixture.releases).toBe(1);
    expect(fixture.state!.applications).toHaveLength(0);
  });

  it("blocks while another application owns an active browser or preflight claim", async () => {
    const { job } = setup();
    const otherJob = { ...job, id: "another-job", url: "https://other.example/jobs/7", applyUrl: "https://other.example/jobs/7/apply" };
    fixture.state!.jobs.push(otherJob);
    fixture.state!.applications.push({
      id: "other-active",
      userId: "demo-user",
      jobId: "another-job",
      jobSnapshot: otherJob,
      status: "needs_user_action",
      approvals: [],
      browserSessionId: "other-session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(runImportedPreflight("demo-user", job.id, async () => result())).rejects.toThrow(/browser session is active/);
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
  });

  it("rejects a session callback when another browser starts during allocation", async () => {
    const { job } = setup();
    const observe = vi.fn(async (_app, _job, onSession) => {
      fixture.state!.applications.push({
        id: "race-active",
        userId: "demo-user",
        jobId: "race-job",
        status: "filling",
        approvals: [],
        browserSessionId: "race-session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      if (!await onSession({ sessionId: "race-preflight", provider: "browser-use" })) throw new Error("Another browser became active during preflight allocation.");
      return result();
    });
    const outcome = await runImportedPreflight("demo-user", job.id, observe);
    expect(outcome.status).toBe("blocked");
    expect(fixture.state!.applications[0].browserSessionId).toBe("race-preflight");
    expect(fixture.state!.applications[0].browserReleasePending?.sessionId).toBe("race-preflight");
  });

  it("retains a provider session reference when observation fails after allocation", async () => {
    const { job } = setup();
    const observe = vi.fn(async (_app, _job, onSession) => { expect(await onSession({ sessionId: "orphan-preflight", provider: "browser-use" })).toBe(true); throw new Error("provider disconnected"); });
    const outcome = await runImportedPreflight("demo-user", job.id, observe);
    const app = fixture.state!.applications[0];
    expect(outcome.status).toBe("blocked");
    expect(app.browserSessionId).toBe("orphan-preflight");
    expect(app.browserReleasePending?.sessionId).toBe("orphan-preflight");
    expect(app.importedPreflight?.sessionId).toBe("orphan-preflight");
  });

  it("preserves a cleanup-only hold when cancellation races an unknown provider release", async () => {
    const { job } = setup();
    const observe = vi.fn(async (_app, _job, onSession) => {
      expect(await onSession({ sessionId: "cancelled-preflight", provider: "browser-use" })).toBe(true);
      fixture.state!.applications[0].importedOutcome = { version: 1, kind: "confirmed", at: "2026-10-01T00:00:00.000Z", evidence: "Earlier terminal evidence" };
      fixture.state!.applications[0].status = "cancelled";
      const error = Object.assign(new Error("provider release unknown"), { browserSessionId: "cancelled-preflight", browserProvider: "browser-use", browserReleaseConfirmed: false });
      throw error;
    });
    await expect(runImportedPreflight("demo-user", job.id, observe)).rejects.toThrow(/changed before preflight could be saved/);
    const current = fixture.state!.applications[0];
    expect(current.status).toBe("cancelled");
    expect(current.importedOutcome).toMatchObject({ kind: "confirmed", evidence: "Earlier terminal evidence" });
    expect(current.importedPreflight).toBeUndefined();
    expect(current.browserSessionId).toBe("cancelled-preflight");
    expect(current.browserReleasePending).toMatchObject({ sessionId: "cancelled-preflight", provider: "browser-use" });
    expect(fixture.releases).toBe(0);
  });

  it("clears the claim and budget after a clean cancellation race without changing terminal evidence", async () => {
    const { job } = setup();
    const observe = vi.fn(async (_app, _job, onSession) => {
      expect(await onSession({ sessionId: "clean-cancel-preflight", provider: "browser-use" })).toBe(true);
      fixture.state!.applications[0].importedOutcome = { version: 1, kind: "confirmed", at: "2026-10-01T00:00:00.000Z", evidence: "Earlier terminal evidence" };
      fixture.state!.applications[0].status = "cancelled";
      return result();
    });
    await expect(runImportedPreflight("demo-user", job.id, observe)).rejects.toThrow(/changed before preflight could be saved/);
    const current = fixture.state!.applications[0];
    expect(current.importedOutcome).toMatchObject({ kind: "confirmed", evidence: "Earlier terminal evidence" });
    expect(current.importedPreflight).toBeUndefined();
    expect(current.browserSessionId).toBeUndefined();
    expect(current.browserReleasePending).toBeUndefined();
    expect(fixture.releases).toBe(0);
  });

  it("clears a clean failed preflight claim so the owner can retry", async () => {
    const { job } = setup();
    await expect(runImportedPreflight("demo-user", job.id, async () => { throw new Error("posting navigation failed"); })).resolves.toMatchObject({ status: "blocked" });
    expect(fixture.state!.applications[0].importedPreflight).toBeUndefined();
    const retried = await runImportedPreflight("demo-user", job.id, async () => result());
    expect(retried.status).toBe("reachable");
  });

  it("does not overwrite proof when the application becomes attempted during observation", async () => {
    const { job } = setup();
    const observe = vi.fn(async () => {
      fixture.state!.applications[0].status = "submitted";
      fixture.state!.applications[0].submissionAttemptedAt = new Date().toISOString();
      return result();
    });
    await expect(runImportedPreflight("demo-user", job.id, observe)).rejects.toThrow(/changed before preflight could be saved/);
    expect(fixture.state!.applications[0].importedCompatibility).toBeUndefined();
    expect(fixture.state!.applications[0].submissionAttemptedAt).toBeDefined();
  });

  it("treats required blank fields as reachable when identity and submit action are verified", () => {
    expect(preflightStatus(result().form)).toBe("reachable");
    expect(preflightStatus({ ...result().form, blockers: ["CAPTCHA requires your takeover."] })).toBe("blocked");
  });
});
