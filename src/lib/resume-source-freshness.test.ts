import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import { selectApplication } from "@/lib/workflow";
import { assertSourceJobCurrent, normalizedSourceJobHash } from "@/lib/resume-source-freshness";

function importedFixture() {
  const state = initialDemoState();
  const job = state.jobs[0];
  Object.assign(job, { source: "imported" as const, sourceId: "synthetic-import", sourceLabel: "Synthetic posting", url: "https://example.invalid/role",
    applyUrl: "https://example.invalid/role", importUrl: "https://example.invalid/role", description: "Unverified description", requirements: ["Unverified requirement"], importCheck: undefined });
  const application = selectApplication(state, job.id, state.profile.id);
  application.jobSnapshot = structuredClone(job);
  return { application, job };
}

it("uses the drafting normalization for imported source-plan freshness", () => {
  const { application, job } = importedFixture();
  const original = normalizedSourceJobHash(application, job);
  const storedUrl = job.url;
  job.description = "Changed unverified page content";
  job.requirements = ["Changed unverified requirement"];
  job.url = "https://example.invalid/role?ref=another-target";
  job.applyUrl = job.url;
  job.importUrl = job.url;
  expect(normalizedSourceJobHash(application, job)).toBe(original);
  expect(() => assertSourceJobCurrent(application, job, original, 2)).not.toThrow();

  job.importCheck = { status: "verified", checkedAt: "2026-10-02T00:00:00.000Z" };
  job.url = "https://boards.greenhouse.io/synthetic/jobs/123";
  job.applyUrl = job.url;
  job.importUrl = job.url;
  const verifiedHash = normalizedSourceJobHash(application, job);
  expect(verifiedHash).not.toBe(original);
  job.description = "Verified role description changed";
  expect(() => assertSourceJobCurrent(application, job, verifiedHash, 2)).toThrow(/source résumé plan is stale/i);
});

it("stales verified title or requirements and ignores URL-only target changes", () => {
  const { application, job } = importedFixture();
  job.importCheck = { status: "verified", checkedAt: "2026-10-02T00:00:00.000Z" };
  job.url = "https://boards.greenhouse.io/synthetic/jobs/123";
  job.applyUrl = job.url;
  job.importUrl = job.url;
  const baseline = normalizedSourceJobHash(application, job);

  job.applyUrl = "https://boards.greenhouse.io/synthetic/jobs/123?target=other";
  expect(normalizedSourceJobHash(application, job)).toBe(baseline);
  job.title = "Changed verified title";
  expect(() => assertSourceJobCurrent(application, job, baseline, 2)).toThrow(/source résumé plan is stale/i);
  job.title = "Data Scientist";
  job.requirements = ["Changed verified requirement"];
  expect(() => assertSourceJobCurrent(application, job, baseline, 2)).toThrow(/source résumé plan is stale/i);
});
