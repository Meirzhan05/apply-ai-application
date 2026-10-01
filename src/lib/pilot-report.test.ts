import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { saveOnboarding } from "@/lib/onboarding";
import { enrollPilot, preparePilotMutation } from "@/lib/pilot";
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

it("keeps a replay of one input snapshot idempotent despite capture timestamps", () => {
  const first = buildPilotReportSnapshot(reportWith(16), { kind: "operator", userId: "operator" }, { cutoffAt: "2026-10-01T12:00:00.000Z", stateOwnerIds: ["owner-a"] });
  const replay = structuredClone(first);
  replay.createdAt = "2026-10-01T12:01:00.000Z";
  replay.sourceManifest.stateReadAt = "2026-10-01T12:01:00.000Z";
  replay.sourceManifest.stateRows[0].readAt = replay.sourceManifest.stateReadAt;
  expect(pilotReportIdentity(first)).toBe(pilotReportIdentity(replay));
  expect(pilotReportDigest(first)).toBe(pilotReportDigest(replay));
});
