import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createControlledEmployerBrowser } from "@/lib/test-support/controlled-employer-browser";
import { cancelBrowser, checkBrowserSubmission, fillApprovedBrowserAnswers, prepareBrowser, refreshBrowserSnapshot } from "@/lib/browser-runner";
import { browserQuestions } from "@/lib/browser-questions";
import { initialDemoState } from "@/lib/demo-data";
import { approveFill, setFormSnapshot, setPacket } from "@/lib/workflow";
import { withPacketFiles } from "@/lib/packet-files";
import { approveBrowserAnswers } from "@/lib/browser-question-approval";
import { essayContentHash, essayEvidenceHash } from "@/lib/answer-policy";
import { saveOnboarding } from "@/lib/onboarding";
import type { Application, ScreeningAnswer } from "@/lib/types";

const transport = vi.hoisted(() => ({ connect: vi.fn(), launch: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: transport.connect, launch: transport.launch } }));
const apps: Application[] = [];
const files: string[] = [];
const locationHtml = `<div class="ashby-application-form-field-entry" data-field-path="location">
  <label class="_required_fixture ashby-application-form-question-title" for="location">Are you based in US or Canada?</label>
  <div class="ashby-application-form-input-yesno">
    <button type="button" aria-pressed="false" data-option="yes">Yes</button>
    <button type="button" aria-pressed="false" data-option="no">No</button>
    <input type="checkbox" name="location" tabindex="-1" style="display:none">
  </div></div>`;

function fixture(html: string) {
  const url = "https://jobs.example/apply";
  const employer = createControlledEmployerBrowser({ targetUrl: url, html: `<form>${html}<button type="submit">Submit application</button></form>` });
  transport.connect.mockResolvedValue(employer.browser);
  const app: Application = { id: randomUUID(), userId: "synthetic-owner", jobId: "synthetic-job", status: "needs_user_action", approvals: [],
    browserSessionId: `local-question-${randomUUID()}`, browserConnectUrl: "ws://controlled", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  apps.push(app);
  return { app, employer };
}

afterEach(async () => {
  for (const app of apps) if (app.browserSessionId?.startsWith("local-") && !app.browserSessionId.startsWith("local-question-")) await cancelBrowser(app);
  await Promise.all(apps.splice(0).flatMap(app => [app.id, `${app.id}-confirmation`].map(id => rm(`.data/screenshots/${id}.png`, { force: true }))));
  await Promise.all(files.splice(0).map(file => rm(file, { force: true })));
  vi.clearAllMocks();
});

it("does not fill a rejected Yes/No widget even when a matching saved answer exists", async () => {
  const { app, employer } = fixture(locationHtml.replace("Are you based in US or Canada?", "Do you require sponsorship?")
    .replace('data-option="no"', 'data-option="unknown"'));
  transport.launch.mockResolvedValue(employer.browser);
  await employer.page.locator(".ashby-application-form-input-yesno").evaluate(element => {
    element.querySelectorAll("button").forEach(button => button.addEventListener("click", () => button.setAttribute("aria-pressed", "true")));
  });
  const state = initialDemoState();
  const profile = state.profile;
  profile.sensitiveAnswers.requiresSponsorship = "No";
  const job = { ...state.jobs[0], applyUrl: "https://jobs.example/apply", url: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Synthetic control guard", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  const result = await prepareBrowser(app, job, profile);
  const clicks = await employer.page.locator('button[aria-pressed="true"]').count();
  expect(clicks).toBe(0);
  expect(result.form.readyToSubmit).toBe(false);
});

it("asks the required Ashby Yes/No question and blocks submission until an option is chosen", async () => {
  const { app } = fixture(locationHtml);
  const form = await refreshBrowserSnapshot(app);
  expect(form.readyToSubmit).toBe(false);
  expect(browserQuestions({ ...form, hash: "observed" })).toMatchObject([{ label: "Are you based in US or Canada?", kind: "yesno", owner: "human", options: ["Yes", "No"], value: "" }]);
});

it.each([41, 201])("fills saved contact details on a form with %s controls", async count => {
  const extraFields = Array.from({ length: count - 4 }, (_, index) => `<label for="extra-${index}">Optional field ${index}</label><input id="extra-${index}" name="extra-${index}">`).join("");
  const { app, employer } = fixture(extraFields + `<label for="name">Full Name</label><input required id="name" name="name"><label for="email">Email</label><input required id="email" name="email" type="email"><label for="phone">Phone</label><input required id="phone" name="phone" type="tel"><label for="pronouns">Pronouns</label><select required id="pronouns" name="pronouns"><option value="">Choose an option</option><option>Prefer not to say</option></select>`);
  transport.launch.mockResolvedValue(employer.browser);
  const state = initialDemoState();
  const profile = state.profile;
  profile.phone = "202-555-0147";
  const job = { ...state.jobs[0], applyUrl: "https://jobs.example/apply", url: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Large form fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  const result = await prepareBrowser(app, job, profile);
  expect(result.form.fields).toHaveLength(count);
  expect(result.form.fields.slice(-4, -1).map(field => field.value)).toEqual([profile.name, profile.email, profile.phone]);
  expect(browserQuestions({ ...result.form, hash: "observed" }).map(question => question.label)).toEqual(["Pronouns"]);
  expect(result.form.blockers?.some(blocker => /control limit|more than 40/.test(blocker))).toBe(false);
  expect(employer.observations().submitClicks).toBe(0);
});

it("fills explicit residence fields from structured current location", async () => {
  const labels = ["Current city", "Current region", "Current country", "Current location"];
  const { app, employer } = fixture(labels.map((label, index) => `<label for="residence-${index}">${label}</label><input required id="residence-${index}" name="residence-${index}">`).join(""));
  transport.launch.mockResolvedValue(employer.browser);
  const state = initialDemoState();
  const profile = state.profile;
  profile.currentLocation = { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" };
  profile.location = "Legacy full location";
  profile.preferredLocations = ["New York, NY", "San Francisco, CA"];
  const job = { ...state.jobs[0], applyUrl: "https://jobs.example/apply", url: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Structured residence fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);

  const result = await prepareBrowser(app, job, profile);

  expect(result.form.fields.map(field => field.value)).toEqual(["Almaty", "Almaty Region", "Kazakhstan", "Almaty, Almaty Region, Kazakhstan"]);
  expect(browserQuestions({ ...result.form, hash: "observed" })).toEqual([]);
  expect(employer.observations().submitClicks).toBe(0);
});

it("fills current and future sponsorship separately and leaves unknown declarations for the candidate", async () => {
  const questions = ["US Immigration Status", "Visa Type", "Are you authorized to work in the United States?", "Do you require sponsorship now?", "Will you require sponsorship in the future?", "Will you now or in the future require sponsorship?"];
  const { app, employer } = fixture(questions.map((label, index) => `<label for="declaration-${index}">${label}</label><input required id="declaration-${index}" name="declaration-${index}">`).join(""));
  transport.launch.mockResolvedValue(employer.browser);
  const state = initialDemoState();
  const profile = state.profile;
  saveOnboarding(profile, { questionnaire: { immigrationStatus: "visa-holder", visaType: "F-1 OPT", workAuthorization: "unknown", sponsorshipNow: "no", sponsorshipFuture: "yes", requiresSponsorship: "no" } });
  const job = { ...state.jobs[0], applyUrl: "https://jobs.example/apply", url: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Declared immigration fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  const result = await prepareBrowser(app, job, profile);
  expect(result.form.fields.map(field => field.value)).toEqual(["Visa holder", "F-1 OPT", "", "No", "Yes", "Yes"]);
  expect(browserQuestions({ ...result.form, hash: "observed" }).map(question => question.label)).toEqual([questions[2]]);
  expect(employer.observations().submitClicks).toBe(0);
});

it("fills more than twenty explicitly approved browser answers", async () => {
  const { app, employer } = fixture(Array.from({ length: 25 }, (_, index) => `<label for="question-${index}">Personal question ${index}</label><input required id="question-${index}" name="question-${index}">`).join(""));
  const state = initialDemoState();
  const profile = state.profile;
  const job = { ...state.jobs[0], applyUrl: "https://jobs.example/apply", url: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.jobSnapshot = job; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Large answer fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  setFormSnapshot(app, await refreshBrowserSnapshot(app));
  const questions = browserQuestions(app.form);
  expect(questions).toHaveLength(25);
  const approvals = approveBrowserAnswers(app, profile, app.form!.hash, questions.map((question, index) => ({ questionId: question.id, value: `Answer ${index}` })));
  app.browserAnswerApprovals = approvals;
  app.status = "filling";
  app.browserQuestionRun = { token: "large-answer-run", kind: "answers", startedAt: new Date().toISOString() };
  const form = await fillApprovedBrowserAnswers(app, job, profile, approvals, async () => true);
  expect(form.readyToSubmit).toBe(true);
  expect(form.fields.map(field => field.value)).toEqual(questions.map((_, index) => `Answer ${index}`));
  expect(employer.observations().submitClicks).toBe(0);
});

it("fills saved LinkedIn and GitHub links while leaving an ambiguous portfolio blank", async () => {
  const { app, employer } = fixture(`<label for="linkedin">LinkedIn URL</label><input id="linkedin" name="linkedin"><label for="github">GitHub profile</label><input id="github" name="github"><label for="portfolio">Portfolio URL</label><input required id="portfolio" name="portfolio">`);
  transport.launch.mockResolvedValue(employer.browser);
  const state = initialDemoState();
  const profile = state.profile;
  profile.links = ["https://linkedin.com/in/candidate", "https://github.com/candidate", "https://unrelated.example.com/project"];
  const job = { ...state.jobs[0], applyUrl: "https://jobs.example/apply", url: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Contact link fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  const result = await prepareBrowser(app, job, profile);
  expect(result.form.fields.map(field => field.value)).toEqual(["https://linkedin.com/in/candidate", "https://github.com/candidate", ""]);
  expect(employer.observations().submitClicks).toBe(0);
});

it("accepts an answered required widget without treating it as an unfamiliar control", async () => {
  const { app } = fixture(locationHtml.replace('class="ashby-application-form-input-yesno"', 'class="ashby-application-form-input-yesno" aria-required="true"')
    .replace('aria-pressed="false" data-option="no"', 'aria-pressed="true" data-option="no"'));
  const form = await refreshBrowserSnapshot(app);
  expect(form.readyToSubmit).toBe(true);
  expect(browserQuestions({ ...form, hash: "observed" })).toEqual([]);
});

it("keeps an unidentified custom widget blocked rather than guessing its question", async () => {
  const { app } = fixture(`<div class="ashby-application-form-input-yesno"><button type="button" data-option="yes">Yes</button><button type="button" data-option="no">No</button></div>`);
  const form = await refreshBrowserSnapshot(app);
  expect(form.readyToSubmit).toBe(false);
  expect(form.fields[0].editable).toBe(false);
});

it("shows the full employer essay question rather than only Tell us more", async () => {
  const { app } = fixture(`<div class="ashby-application-form-field-entry">
    <label class="ashby-application-form-question-title" for="essay">Tell us more</label>
    <div class="ashby-application-form-question-description"><p>Tell us about something you built that no one asked you to. What was it, why did you build it, and what did you learn?</p></div>
    <textarea required name="essay" id="essay"></textarea></div>`);
  const form = await refreshBrowserSnapshot(app);
  expect(browserQuestions({ ...form, hash: "observed" })[0].label).toBe("Tell us more: Tell us about something you built that no one asked you to. What was it, why did you build it, and what did you learn?");
});

it("routes the something-you-built question to a reviewed AI essay", async () => {
  const { app } = fixture(`<div class="ashby-application-form-field-entry"><label for="essay">Tell us more</label>
    <div class="ashby-application-form-question-description">Tell us about something you built that no one asked you to. What was it, why did you build it, and what did you learn?</div>
    <textarea required name="essay" id="essay"></textarea></div>`);
  const form = await refreshBrowserSnapshot(app);
  expect(browserQuestions({ ...form, hash: "observed" })[0].owner).toBe("ai");
});

it.each(["Yes", "No"])("fills the confirmed %s choice while keeping LinkedIn and the essay bound to their own controls", async choice => {
  const { app, employer } = fixture(locationHtml + `<div class="ashby-application-form-field-entry"><label for="essay">Tell us more</label>
    <div class="ashby-application-form-question-description">Tell us about something you built that no one asked you to.</div>
    <textarea required name="essay" id="essay"></textarea></div><label for="linkedin">LinkedIn</label><input required name="linkedin" id="linkedin">`);
  await employer.page.locator(".ashby-application-form-input-yesno").evaluate(element => {
    const widget = element as Element;
    widget.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
      widget.querySelectorAll("button").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
    }));
  });
  const state = initialDemoState();
  const profile = state.profile;
  const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" };
  state.jobs = [job]; state.applications = [app]; app.userId = profile.id; app.jobId = job.id; app.jobSnapshot = job; app.status = "selected";
  const fact = profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Synthetic question flow", model: "fixture", createdAt: new Date().toISOString(),
    resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  for (const file of packet.files ?? []) if (file.storageKey) files.push(`.data/application-files/${file.storageKey}`);
  setPacket(state, app, packet); approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  setFormSnapshot(app, await refreshBrowserSnapshot(app));
  const questions = browserQuestions(app.form);
  const essay = questions.find(question => question.identifier === "essay")!;
  const linkedin = questions.find(question => question.identifier === "linkedin")!;
  const location = questions.find(question => question.identifier === "location")!;
  expect(linkedin.value).toBe("");
  const answer: ScreeningAnswer = { question: essay.label, answer: fact.text, factIds: [fact.id], author: "ai", requiresUserInput: true,
    aiDraft: { version: 1, model: "fixture", sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }], evidenceHash: essayEvidenceHash(profile, [fact.id]), contentHash: "" } };
  answer.aiDraft!.contentHash = essayContentHash(answer);
  app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId!, packetHash: app.packetHash!, answers: { [essay.id]: answer } };
  const inputs = [{ questionId: linkedin.id, value: "https://www.linkedin.com/in/synthetic-applicant" },
    { questionId: location.id, value: choice }, { questionId: essay.id, confirmEssay: true, answerHash: answer.aiDraft!.contentHash }];
  expect(() => approveBrowserAnswers(app, profile, app.form!.hash, inputs.map(input => input.questionId === essay.id ? { questionId: essay.id, value: "https://www.linkedin.com/in/synthetic-applicant" } : input))).toThrow(/current AI essay/);
  const approvals = approveBrowserAnswers(app, profile, app.form!.hash, inputs);
  app.browserAnswerApprovals = approvals;
  app.status = "filling";
  app.browserQuestionRun = { token: "synthetic-run", kind: "answers", startedAt: new Date().toISOString() };
  const form = await fillApprovedBrowserAnswers(app, job, profile, approvals, async () => true);
  expect(form.readyToSubmit).toBe(true);
  expect(form.fields.find(field => field.identifier === "location")?.value).toBe(choice);
  expect(form.fields.find(field => field.identifier === "linkedin")?.value).toBe("https://www.linkedin.com/in/synthetic-applicant");
  expect(form.fields.find(field => field.identifier === "essay")?.value).toBe(fact.text);
  expect(employer.observations().submitClicks).toBe(0);
});

it("captures explicit employer validation errors separately from an unknown submission result", async () => {
  const { app } = fixture(`<div><div>Your form needs corrections</div><ul><li>Missing entry for required field: Are you based in US or Canada?</li></ul></div>`);
  app.status = "uncertain";
  app.form = { version: 1, url: "https://jobs.example/apply", hash: "before", fields: [], attachments: [], capturedAt: new Date().toISOString() };
  app.submissionAttemptedAt = new Date(Date.now() - 1000).toISOString();
  app.submissionVerification = { version: 1, kind: "captcha", sessionId: app.browserSessionId!, targetUrl: app.form.url,
    attemptedAt: app.submissionAttemptedAt, beforeHash: "before", beforeHadConfirmation: false };
  const result = await checkBrowserSubmission(app);
  expect(result.confirmed).toBe(false);
  expect(result.receipt?.validationErrors).toEqual(["Missing entry for required field: Are you based in US or Canada?"]);
  expect(result.evidence).toContain("form needs corrections");
}, 40_000);
