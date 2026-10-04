import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { saveOnboarding, activateAutomation } from "@/lib/onboarding";
import { authorizeKnownAnswerApplication, assertAutonomousDestination } from "@/lib/autonomous-policy";
import { createImportedCompatibilityRecord, isControlledImportedFixture } from "@/lib/import-compatibility";
import { selectApplication } from "@/lib/workflow";
import type { AppState, FormSnapshot, Job } from "@/lib/types";

const makeState = (): AppState => {
  const state = initialDemoState();
  saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } });
  activateAutomation(state.profile, "compatibility test");
  return state;
};

const importedJob = (url = "https://careers.example.com/jobs/42/apply"): Job => ({
  ...initialDemoState().jobs[0],
  id: "imported-job",
  source: "imported",
  sourceId: "external-42",
  sourceLabel: "Imported link",
  url,
  applyUrl: url,
  importUrl: url,
  importCheck: { status: "manual", checkedAt: "2026-10-01T00:00:00.000Z" },
});

const observed = (job: Job, action = "https://careers.example.com/jobs/42/submit"): FormSnapshot => ({
  version: 1,
  url: "https://careers.example.com/jobs/42/application",
  fields: [],
  attachments: [],
  capturedAt: "2026-10-01T00:00:00.000Z",
  hash: "form-proof",
  readyToSubmit: false,
  blockers: [],
  submitControl: { label: "Submit application", identifier: "submit", action, method: "post" },
});

function prepared() {
  const state = makeState();
  const job = importedJob();
  state.jobs = [job];
  const app = selectApplication(state, job.id, state.profile.id);
  app.importedCompatibility = createImportedCompatibilityRecord({ application: app, job, observed: { ...observed(job), postingEvidence: { title: job.title, company: job.company, markers: [job.title, job.company], identityHash: "identity-proof" }, observedContext: { title: job.title, company: job.company, location: "New York, NY", text: `${job.title} at ${job.company}` } }, status: "reachable", checkedAt: "2026-10-01T00:00:00.000Z" });
  return { state, job, app };
}

describe("imported employer compatibility", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["London, United Kingdom", "Remote", "Boston, MA"])("invalidates previous US posting proof when the saved destination changes: %s", (location) => {
    const { state, job, app } = prepared();
    const updated = { ...job, location };
    state.jobs = [updated];
    expect(() => authorizeKnownAnswerApplication(app, state.profile, updated)).toThrow(/destination changed|US.*destination|destination.*US/);
  });

  it("requires an observed exact form and action proof for sparse arbitrary imports", () => {
    const state = makeState();
    const job = importedJob();
    state.jobs = [job];
    const app = selectApplication(state, job.id, state.profile.id);
    expect(() => authorizeKnownAnswerApplication(app, state.profile, job)).toThrow(/Verify the imported employer posting/);
  });

  it("does not authorize reachable proof without observed posting context", () => {
    const state = makeState();
    const job = importedJob();
    state.jobs = [job];
    const app = selectApplication(state, job.id, state.profile.id);
    app.importedCompatibility = createImportedCompatibilityRecord({ application: app, job, observed: { ...observed(job), postingEvidence: { title: job.title, company: job.company, markers: [job.title, job.company], identityHash: "identity-proof" } }, status: "reachable" });
    expect(() => authorizeKnownAnswerApplication(app, state.profile, job)).toThrow(/Verify the imported employer posting/);
  });

  it("binds automatic authorization to the observed alternate same-origin action", () => {
    const { state, job, app } = prepared();
    authorizeKnownAnswerApplication(app, state.profile, job);
    expect(app.autonomousAuthorization).toMatchObject({
      targetUrl: job.applyUrl,
      expectedFormUrl: "https://careers.example.com/jobs/42/application",
      expectedSubmitAction: "https://careers.example.com/jobs/42/submit",
    });
    expect(() => assertAutonomousDestination(app, observed(job))).not.toThrow();
  });

  it("rejects an unobserved same-host action and cross-origin action", () => {
    const { state, job, app } = prepared();
    authorizeKnownAnswerApplication(app, state.profile, job);
    expect(() => assertAutonomousDestination(app, observed(job, "https://careers.example.com/jobs/42/other-submit"))).toThrow(/destination changed/);
    expect(() => assertAutonomousDestination(app, observed(job, "https://forms.example.net/submit"))).toThrow(/destination changed/);
  });

  it("rejects a same-origin different posting and a related-role title", () => {
    const state = makeState();
    const job = importedJob();
    state.jobs = [job];
    const app = selectApplication(state, job.id, state.profile.id);
    app.importedCompatibility = createImportedCompatibilityRecord({
      application: app,
      job,
      observed: {
        ...observed(job),
        postingEvidence: {
          postingUrl: "https://careers.example.com/jobs/43",
          postingIdentityHash: "wrong-posting",
          title: "Data Analyst II",
          company: job.company,
          markers: ["Data Analyst II", job.company, job.title],
          identityHash: "wrong-identity",
        },
        observedContext: { title: "Data Analyst II", company: job.company, text: "Data Analyst II at Example Employer" },
      },
      status: "reachable",
    });
    expect(() => authorizeKnownAnswerApplication(app, state.profile, job)).toThrow(/posting link|corroborate/);
  });

  it("retains the existing provider-verified ATS fast path", () => {
    const state = makeState();
    const job = { ...importedJob("https://boards.greenhouse.io/acme/jobs/42"), importUrl: "https://boards.greenhouse.io/acme/jobs/42", importCheck: { status: "verified" as const, checkedAt: "2026-10-01T00:00:00.000Z" } };
    state.jobs = [job];
    const app = selectApplication(state, job.id, state.profile.id);
    expect(() => authorizeKnownAnswerApplication(app, state.profile, job)).not.toThrow();
    expect(app.autonomousAuthorization?.expectedFormUrl).toBe(job.applyUrl);
  });

  it("does not grant a controlled exemption from an arbitrary host or unsigned token", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://apply.example");
    const state = makeState();
    const job = importedJob("https://employer.example.com/api/internal/controlled-form?token=unsigned");
    state.jobs = [job];
    const app = selectApplication(state, job.id, state.profile.id);
    app.controlledTest = { expiresAt: Date.now() + 60_000, submissions: 0 };
    expect(isControlledImportedFixture(app, job)).toBe(false);
  });
});
