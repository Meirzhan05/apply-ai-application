import { beforeEach, describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { saveOnboarding } from "@/lib/onboarding";
import { attachPilotAttempt, enrollPilot, pilotConsentHash, pilotEvidenceDigest, preparePilotMutation, withdrawPilot } from "@/lib/pilot";
import { buildPilotReportSnapshot } from "@/lib/pilot-report";
import { selectApplication } from "@/lib/workflow";
import { recordApplicationBlocker } from "@/lib/application-blockers";
import type { AppState } from "@/lib/types";

function readyState(): AppState {
  const state = initialDemoState();
  state.profile.id = "owner-a";
  state.profile.demo = true;
  saveOnboarding(state.profile, {
    questionnaire: { workAuthorization: "yes", requiresSponsorship: "no", availability: "now" },
    facts: [{ id: "fact-1", text: "Built a data dashboard", verified: true, source: "user" }],
  });
  return state;
}

describe("pilot participation and immutable initiation", () => {
  beforeEach(() => { process.env.DEMO_MODE = "true"; });

  it("requires completed onboarding, keeps automation separate, and does not capture history retroactively", () => {
    const state = readyState();
    const existing = selectApplication(state, state.jobs[0].id, "owner-a");
    expect(existing.pilotAttempt).toBeUndefined();
    const beforeVersion = state.profile.automationVersion;
    const episode = enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
    expect(episode.consentTextHash).toBe(pilotConsentHash());
    expect(state.profile.automationVersion).toBe(beforeVersion);
    const selected = selectApplication(state, state.jobs[1].id, "owner-a");
    expect(selected.pilotAttempt?.consentEpisodeId).toBe(episode.id);
    withdrawPilot(state, "owner-a");
    expect(selectApplication(state, state.jobs[2].id, "owner-a").pilotAttempt).toBeUndefined();
  });

  it("keeps control fixtures excluded when the marker arrives after initiation", () => {
    const state = readyState();
    state.jobs[1].source = "greenhouse";
    enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
    const app = selectApplication(state, state.jobs[1].id, "owner-a");
    const previous = structuredClone(state);
    app.controlledTest = { expiresAt: Date.now() + 10_000, submissions: 0 };
    preparePilotMutation(previous, state);
    expect(app.pilotAttempt?.events.some((event) => event.kind === "controlled-excluded")).toBe(true);
    const report = buildPilotReportSnapshot(state, { kind: "owner", userId: "owner-a" });
    expect(report.totals.realInitiated).toBe(0);
    expect(report.totals.controlled).toBe(1);
  });

  it("does not permit a CAS candidate to erase a prior attempt or review prefix", () => {
    const state = readyState();
    enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
    const app = selectApplication(state, state.jobs[1].id, "owner-a");
    const previous = structuredClone(state);
    expect(app.pilotAttempt).toBeDefined();
    state.applications = [];
    expect(() => preparePilotMutation(previous, state)).toThrow(/cannot be removed/);
  });

  it("keeps a review tied to the current immutable evidence digest", () => {
    const state = readyState();
    enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
    const app = selectApplication(state, state.jobs[1].id, "owner-a");
    const digest = pilotEvidenceDigest(app.pilotAttempt!);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    attachPilotAttempt(state, app);
  });

  it("does not treat a submitted status as a confirmed receipt without observed evidence", () => {
    const state = readyState();
    state.jobs[1].source = "greenhouse";
    enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
    const app = selectApplication(state, state.jobs[1].id, "owner-a");
    const before = structuredClone(state);
    app.status = "submitted";
    app.submissionAttemptedAt = new Date().toISOString();
    preparePilotMutation(before, state);
    expect(app.pilotAttempt?.events.some((event) => event.kind === "receipt-confirmed")).toBe(false);
    const secondBefore = structuredClone(state);
    app.submissionReceipt = { version: 1, url: "https://employer.example/receipt", text: "Received", capturedAt: new Date().toISOString() };
    preparePilotMutation(secondBefore, state);
    expect(app.pilotAttempt?.events.some((event) => event.kind === "receipt-confirmed")).toBe(true);
  });

  it("records an unanswered required blocker as an intervention request", () => {
    const state = readyState();
    state.jobs[1].source = "greenhouse";
    enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
    const app = selectApplication(state, state.jobs[1].id, "owner-a");
    const previous = structuredClone(state);
    const blocker = recordApplicationBlocker(app, "missing_answer", "A required sponsorship answer needs your review.", { formHash: "form-1" });
    preparePilotMutation(previous, state);
    expect(blocker.progress).toBe("blocked");
    expect(app.pilotAttempt?.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "intervention-requested", blockerId: blocker.id })]));
  });
});
