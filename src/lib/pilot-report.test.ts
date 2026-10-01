import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { saveOnboarding } from "@/lib/onboarding";
import { appendPilotReview, enrollPilot, pilotEvidenceDigest, preparePilotMutation } from "@/lib/pilot";
import { buildPilotReportSnapshot, pilotReportDigest, pilotReportIdentity } from "@/lib/pilot-report";
import { selectApplication } from "@/lib/workflow";

function reportWith(count: number) {
  const state = initialDemoState();
  state.profile.id = "owner-a";
  saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" }, facts: state.profile.facts });
  enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
  for (let index = 0; index < 20; index++) {
    const base = state.jobs[1];
    const job = { ...base, id: `real-${index}`, url: `https://jobs.example/real-${index}`, applyUrl: `https://jobs.example/real-${index}/apply`, source: index % 2 ? "lever" as const : "greenhouse" as const, title: index % 2 ? `New Grad Engineer ${index}` : `Software Engineering Intern ${index}`, employmentType: index % 2 ? "New graduate" : "Internship", description: index % 2 ? "New graduate role." : "Summer internship role." };
    state.jobs.push(job);
    selectApplication(state, job.id, "owner-a");
  }
  const previous = structuredClone(state);
  for (const app of state.applications.slice(0, count)) {
    app.status = "submitted";
    app.submissionAttemptedAt = new Date().toISOString();
    app.submissionReceipt = { version: 1, url: "https://employer.example/receipt", text: "Received", capturedAt: new Date().toISOString() };
  }
  preparePilotMutation(previous, state);
  return state;
}

it("keeps all real initiated rows in the denominator and reports both cohorts", () => {
  const report = buildPilotReportSnapshot(reportWith(16), { kind: "operator", userId: "operator" });
  expect(report.totals.realInitiated).toBe(20);
  expect(report.totals.confirmed).toBe(16);
  expect(report.cohorts.internship.initiated).toBe(10);
  expect(report.cohorts["new-grad"].initiated).toBe(10);
  expect(report.status).toBe("review-incomplete");
  expect(report.reasons).toContain("confirmed-attempt-review-incomplete");
});

it("fails the unattended gate at fifteen confirmed rows instead of filtering failures out", () => {
  const report = buildPilotReportSnapshot(reportWith(15), { kind: "operator", userId: "operator" });
  expect(report.totals.realInitiated).toBe(20);
  expect(report.totals.confirmed).toBe(15);
  expect(report.reasons).toContain("unattended-rate-below-80-percent");
});

it("passes sixteen current reviewed receipts while retaining four pending rows in the denominator", () => {
  const state = reportWith(16);
  for (const app of state.applications.filter((item) => item.submissionReceipt)) {
    const attempt = app.pilotAttempt!;
    appendPilotReview(state, "operator", { applicationId: app.id, evidenceDigest: pilotEvidenceDigest(attempt), suitability: "pass", factualAccuracy: "pass", notes: "Reviewed against the captured evidence." });
  }
  const report = buildPilotReportSnapshot(state, { kind: "operator", userId: "operator" });
  expect(report.totals.realInitiated).toBe(20);
  expect(report.totals.confirmed).toBe(16);
  expect(report.status).toBe("passed");
});

it("fails a submitted row with an explicit unsuitable review and does not hide pending rows", () => {
  const state = reportWith(15);
  for (const app of state.applications.filter((item) => item.submissionReceipt)) {
    appendPilotReview(state, "operator", { applicationId: app.id, evidenceDigest: pilotEvidenceDigest(app.pilotAttempt!), suitability: app.id === state.applications[0].id ? "fail" : "pass", factualAccuracy: "pass", notes: "The captured submission is unsuitable for this role." });
  }
  const report = buildPilotReportSnapshot(state, { kind: "operator", userId: "operator" });
  expect(report.totals.realInitiated).toBe(20);
  expect(report.totals.confirmed).toBe(15);
  expect(report.status).toBe("failed");
  expect(report.reasons).toContain("confirmed-attempt-review-failed");
  expect(report.reasons).toContain("unattended-rate-below-80-percent");
});

it("invalidates a saved review when the submitted evidence changes", () => {
  const state = reportWith(16);
  for (const app of state.applications.filter((item) => item.submissionReceipt)) {
    appendPilotReview(state, "operator", { applicationId: app.id, evidenceDigest: pilotEvidenceDigest(app.pilotAttempt!), suitability: "pass", factualAccuracy: "pass", notes: "Reviewed." });
  }
  expect(buildPilotReportSnapshot(state, { kind: "operator", userId: "operator" }).status).toBe("passed");
  const app = state.applications.find((item) => item.submissionReceipt)!;
  const previous = structuredClone(state);
  const candidate = structuredClone(state);
  const changed = candidate.applications.find((item) => item.id === app.id)!;
  changed.form = { ...(changed.form ?? { version: 1, url: changed.jobSnapshot?.applyUrl ?? "https://jobs.example/apply", hash: "form", capturedAt: new Date().toISOString(), fields: [], attachments: [] }), hash: "changed-form" };
  expect(() => preparePilotMutation(previous, candidate)).toThrow(/submitted evidence is immutable/i);
  expect(buildPilotReportSnapshot(state, { kind: "operator", userId: "operator" }).status).toBe("passed");
});

it("keeps a committed late controlled exclusion out of a later report cutoff", () => {
  const state = reportWith(0);
  const app = state.applications[0];
  app.pilotAttempt!.initiatedAt = "2026-10-01T01:00:00.000Z";
  const previous = structuredClone(state);
  app.controlledTest = { expiresAt: Date.now() + 10_000, submissions: 0 };
  preparePilotMutation(previous, state);
  app.pilotAttempt!.events.at(-1)!.at = "2026-10-02T01:00:00.000Z";
  const report = buildPilotReportSnapshot(state, { kind: "operator", userId: "operator" }, { cutoffAt: "2026-10-01T12:00:00.000Z" });
  expect(report.totals.realInitiated).toBe(0);
  expect(report.totals.controlled).toBe(1);
  expect(report.sourceManifest.controlledExclusions).toHaveLength(1);
  expect(report.attempts[0].controlledExclusion?.afterCutoff).toBe(true);
  const current = buildPilotReportSnapshot(state, { kind: "operator", userId: "operator" }, { cutoffAt: "2026-12-31T00:00:00.000Z" });
  expect(() => appendPilotReview(state, "operator", { applicationId: app.id, evidenceDigest: current.attempts[0].currentEvidenceDigest!, suitability: "pass", factualAccuracy: "pass", notes: "Current evidence reviewed." })).not.toThrow();
  expect(current.attempts[0].currentEvidenceDigest).toBe(pilotEvidenceDigest(app.pilotAttempt!));
});

it("keeps a replay of one input snapshot idempotent despite capture timestamps", () => {
  const first = buildPilotReportSnapshot(reportWith(16), { kind: "operator", userId: "operator" }, { cutoffAt: "2026-10-01T12:00:00.000Z", stateOwnerIds: ["owner-a"] });
  const replay = structuredClone(first);
  replay.createdAt = "2026-10-01T12:01:00.000Z";
  replay.sourceManifest.stateReadAt = "2026-10-01T12:01:00.000Z";
  replay.sourceManifest.stateRows[0].readAt = replay.sourceManifest.stateReadAt;
  expect(pilotReportIdentity(first)).toBe(pilotReportIdentity(replay));
  expect(pilotReportDigest(first)).toBe(pilotReportDigest(replay));
});
