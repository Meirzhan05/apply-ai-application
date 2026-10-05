import { afterEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { createControlledEmployerBrowser } from "@/lib/test-support/controlled-employer-browser";
import { withPacketFiles } from "@/lib/packet-files";
import { approveFill, selectApplication, setPacket } from "@/lib/workflow";
import { browserQuestions } from "@/lib/browser-questions";
import { rememberPersonalAnswer } from "@/lib/profile-memory";
import { prepareBrowser, cancelBrowser } from "@/lib/browser-runner";
import type { Application } from "@/lib/types";

const transport = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launch: transport.launch, connectOverCDP: vi.fn() } }));
let active: Application | undefined;
afterEach(async () => { if (active?.browserSessionId) await cancelBrowser(active); active = undefined; vi.unstubAllEnvs(); });

it("fills known basics and personal links and asks only for missing screening answers", async () => {
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "");
  const state = initialDemoState(); const profile = state.profile;
  profile.contactEmail = "applications@example.com"; profile.location = "Seattle, WA";
  profile.linkedinUrl = "https://www.linkedin.com/in/riley-example";
  profile.portfolioUrl = "https://riley.example.com";
  rememberPersonalAnswer(profile, "previous", "GitHub profile", "https://github.com/riley-example");
  const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" }; state.jobs = [job];
  const fields = [["Full name", "text"], ["Email address", "email"], ["Current location", "text"], ["LinkedIn profile", "url"], ["GitHub", "url"], ["Portfolio / website", "url"], ["Languages spoken", "text"], ["Company website", "url"]];
  const html = `<title>Apply</title><form action="${job.applyUrl}" method="post">${fields.map(([label, type], index) => `<label>${label}<input name="field${index}" type="${type}" required></label>`).join("")}<button type="submit">Submit application</button></form>`;
  transport.launch.mockResolvedValue(createControlledEmployerBrowser({ targetUrl: job.applyUrl, html }).browser);
  const app = selectApplication(state, job.id, profile.id); active = app;
  const fact = profile.facts[0];
  setPacket(state, app, await withPacketFiles(profile, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Fixture", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] }));
  approveFill(app, profile.id, app.packetHash!, job.applyUrl);
  const result = await prepareBrowser(app, job, profile); app.browserSessionId = result.sessionId;
  expect(result.form.fields.find(field => field.label === "Email address")!.value).toBe("applications@example.com");
  expect(result.form.fields.find(field => field.label === "GitHub")!.value).toBe("https://github.com/riley-example");
  expect(result.form.fields.find(field => field.label === "LinkedIn profile")!.value).toBe(profile.linkedinUrl);
  expect(result.form.fields.find(field => field.label === "Current location")!.value).toBe("Seattle, WA");
  expect(browserQuestions({ ...result.form, hash: "fixture" }).map(question => question.label)).toEqual(["Languages spoken", "Company website"]);
});

it("uses an explicit packet answer ahead of an older reusable profile value", async () => {
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "");
  const state = initialDemoState(); state.profile.githubUrl = "https://github.com/old-profile";
  const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" }; state.jobs = [job];
  transport.launch.mockResolvedValue(createControlledEmployerBrowser({ targetUrl: job.applyUrl, html: `<title>Apply</title><form action="${job.applyUrl}"><label>GitHub profile<input name="github" type="url" required></label><button type="submit">Submit application</button></form>` }).browser);
  const app = selectApplication(state, job.id, state.profile.id); active = app; const fact = state.profile.facts[0];
  setPacket(state, app, await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Fixture", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [{ question: "GitHub profile", answer: "https://github.com/explicit-answer", factIds: [], author: "human", userProvided: true, requiresUserInput: false }] }));
  approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
  const result = await prepareBrowser(app, job, state.profile); app.browserSessionId = result.sessionId;
  expect(result.form.fields.find(field => field.label === "GitHub profile")!.value).toBe("https://github.com/explicit-answer");
  expect(browserQuestions({ ...result.form, hash: "fixture" })).toEqual([]);
});
