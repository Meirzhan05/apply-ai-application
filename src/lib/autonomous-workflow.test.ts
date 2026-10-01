import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Application } from "@/lib/types";
const fixture = vi.hoisted(() => ({ state: null as AppState | null, pending: [] as Array<{ task: string; payload: { userId: string; applicationId: string; runToken?: string } }>, queue: Promise.resolve(), saved: [] as AppState[], triggerFailure: "", afterLoad: undefined as undefined | ((state: AppState) => void | Promise<void>), budget: true, prepare: vi.fn(), submit: vi.fn(), cancel: vi.fn(), parse: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ task: (config: unknown) => config, tasks: { trigger: async (task: string, payload: { userId: string; applicationId: string; runToken?: string }) => { fixture.pending.push({ task, payload }); if (fixture.triggerFailure === task) throw new Error("Accepted handoff timed out"); return { id: "dispatch" }; } } }));
vi.mock("@/lib/repository", () => ({ isDemo: () => false, currentUserId: async () => fixture.state!.profile.id, loadState: async () => { const snapshot = structuredClone(fixture.state); await fixture.afterLoad?.(fixture.state!); return snapshot; }, mutateState: async (_user: string, change: (state: AppState) => unknown) => { const pending = fixture.queue.then(async () => { const result = await change(fixture.state!); fixture.saved.push(structuredClone(fixture.state!)); return result; }); fixture.queue = pending.then(() => undefined, () => undefined); return pending; } }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: async () => fixture.budget }));
vi.mock("openai", () => ({ default: class { responses = { parse: fixture.parse }; } }));
vi.mock("@/lib/latex-compiler", () => ({ fitResume: async (_profile: unknown, document: unknown) => ({ document, pdf: Buffer.from("%PDF-controlled"), source: "controlled compiler" }) }));
vi.mock("@/lib/browser-runner", () => ({ prepareBrowser: fixture.prepare, submitBrowser: fixture.submit, cancelBrowser: fixture.cancel, refreshBrowserSnapshot: vi.fn(), repairEducationFields: vi.fn(), fillApprovedBrowserAnswers: vi.fn(), checkBrowserSubmission: vi.fn() }));
import { latexFixture } from "@/lib/latex-fixture";
import { initialDemoState } from "@/lib/demo-data";
import { saveOnboarding, activateAutomation } from "@/lib/onboarding";
import { runDraft, runFill } from "@/lib/application-runs";
import { runSubmission } from "@/lib/application-submission";
import { POST } from "@/app/api/actions/route";

const action = (name: string, payload: Record<string, unknown>) => POST(new Request("https://apply.example/api/actions", { method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action: name, payload }) }));
async function step() { const next = fixture.pending.shift()!; if (next.task === "draft-application-packet") await runDraft(next.payload); else if (next.task === "fill-application-form") await runFill(next.payload); else if (next.task === "submit-application-form") await runSubmission(next.payload); return next; }
async function progress() { while (fixture.pending.length) await step(); }
beforeEach(() => {
  vi.clearAllMocks(); fixture.cancel.mockResolvedValue(undefined); fixture.pending = []; fixture.saved = []; fixture.triggerFailure = ""; fixture.afterLoad = undefined; fixture.queue = Promise.resolve(); fixture.budget = true;
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture"); vi.stubEnv("EMAIL_FROM", "");
  const source = latexFixture(); fixture.state = initialDemoState(); fixture.state.profile = source.profile; fixture.state.applications = [];
  saveOnboarding(fixture.state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); activateAutomation(fixture.state.profile, "controlled-test");
  fixture.parse.mockImplementation(async (input) => ({ id: `response-${Math.random()}`, model: input.model, service_tier: "default", output_parsed: input.text.format.name === "structured_resume" ? source.document : { grounded: true, unsupportedClaims: [] }, usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
  fixture.prepare.mockImplementation(async (app, job, _profile, onSession, onAction) => { await onSession({ sessionId: "session", provider: "browser-use" }); await onAction("Known fields filled"); const file = app.packet.files[0]; return { sessionId: "session", provider: "browser-use", needsAction: false, needsCoverLetter: false, form: { version: 1, url: job.applyUrl, fields: [{ label: "Resume", value: file.filename, identifier: "resume", kind: "file", required: true, valid: true, fileHashes: [`${file.filename}:${file.size}:${file.sha256}`] }], attachments: [file.filename], capturedAt: new Date().toISOString(), readyToSubmit: true, blockers: [], submitControl: { label: "Submit application", identifier: "submit", action: job.applyUrl, method: "post" } } }; });
  fixture.submit.mockImplementation(async (app: Application, options: { beforeAttempt: (baseline: NonNullable<Application["submissionVerification"]>) => Promise<boolean> }) => { const baseline = { version: 1 as const, kind: "captcha" as const, sessionId: app.browserSessionId!, targetUrl: app.form!.url, attemptedAt: new Date().toISOString(), beforeHash: "baseline", beforeHadConfirmation: false }; expect(await options.beforeAttempt(baseline)).toBe(true); expect(fixture.state!.applications[0].submissionAttemptedAt).toBe(baseline.attemptedAt); return { confirmed: true, evidence: "Application received", receipt: { version: 1, url: app.form!.url, text: "Application received", capturedAt: new Date().toISOString() } }; });
});
afterEach(() => vi.unstubAllEnvs());
it("completes a known-answer application from one action without legacy approvals", async () => {
  const response = await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  expect(response.status).toBe(200);
  await progress();
  const app = fixture.state!.applications[0];
  expect(app.status).toBe("submitted"); expect(app.approvals).toEqual([]);
  expect(app.submissionReceipt?.text).toBe("Application received");
  expect(app.autonomousAuthorization).toMatchObject({ profileVersion: fixture.state!.profile.automationVersion, targetUrl: fixture.state!.jobs[0].applyUrl, packetHash: app.packetHash, formHash: app.form?.hash });
  expect(app.packet?.answers).toEqual([]);
});
it("deduplicates concurrent starts and aliased postings, and ignores replayed workers", async () => {
  const state = fixture.state!; const alias = { ...state.jobs[0], id: "alias", url: `${state.jobs[0].url}?utm_source=controlled` }; state.jobs.push(alias);
  const responses = await Promise.all([action("startAutonomous", { jobId: state.jobs[0].id }), action("startAutonomous", { jobId: alias.id })]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]); expect(state.applications).toHaveLength(1);
  const draft = await step(); await runDraft(draft.payload); await progress();
  await runSubmission({ userId: state.profile.id, applicationId: state.applications[0].id, submissionToken: state.applications[0].submissionDispatch?.token });
  expect(fixture.prepare).toHaveBeenCalledTimes(1); expect(fixture.submit).toHaveBeenCalledTimes(1); expect(state.applications[0].status).toBe("submitted");
});
it.each(["pause", "revise", "close"])("blocks a queued application after %s before model or browser work", async (change) => {
  fixture.budget = false; await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const state = fixture.state!;
  if (change === "pause") state.profile.automationAuthorization!.status = "paused";
  if (change === "revise") state.profile.name = "Changed name without version bump";
  if (change === "close") state.jobs[0].active = false;
  fixture.budget = true; await (await import("@/lib/application-queue")).dispatchUserQueue(state.profile.id); await progress();
  expect(state.applications[0].status).toBe("needs_user_action"); expect(state.applications[0].error).toBeTruthy(); expect(fixture.parse).not.toHaveBeenCalled(); expect(fixture.prepare).not.toHaveBeenCalled(); expect(fixture.submit).not.toHaveBeenCalled();
});
it("cancels during queued submission and prevents the saved worker from clicking", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); await step();
  const app = fixture.state!.applications[0]; expect(app.status).toBe("submitting");
  expect((await action("cancel", { applicationId: app.id })).status).toBe(200); await progress();
  expect(app.status).toBe("cancelled"); expect(app.submissionAttemptedAt).toBeUndefined(); expect(fixture.submit).not.toHaveBeenCalled();
});
it("blocks revised authorization immediately before a click even after the worker starts", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); await step();
  fixture.submit.mockImplementationOnce(async (app, options) => {
    fixture.state!.profile.automationAuthorization!.status = "paused";
    await options.beforeAttempt({ version: 1, kind: "captcha", sessionId: app.browserSessionId, targetUrl: app.form.url, attemptedAt: new Date().toISOString(), beforeHash: "before", beforeHadConfirmation: false });
    throw new Error("A click must not be reached");
  });
  await progress(); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.state!.applications[0].submissionAttemptedAt).toBeUndefined();
});
it("keeps a durable ambiguous attempt and never clicks again after transport failure", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); await step();
  fixture.submit.mockImplementationOnce(async (app, options) => {
    expect(await options.beforeAttempt({ version: 1, kind: "captcha", sessionId: app.browserSessionId, targetUrl: app.form.url, attemptedAt: new Date().toISOString(), beforeHash: "before", beforeHadConfirmation: false })).toBe(true);
    throw new Error("SUBMISSION_UNCERTAIN");
  });
  await expect(step()).rejects.toThrow("SUBMISSION_UNCERTAIN"); const state = fixture.state!; const app = state.applications[0];
  expect(app.status).toBe("uncertain"); expect(app.submissionAttemptedAt).toBeTruthy(); expect(app.submissionVerification?.attemptedAt).toBe(app.submissionAttemptedAt); expect(app.submittedAt).toBeUndefined();
  await runSubmission({ userId: state.profile.id, applicationId: app.id, submissionToken: app.submissionDispatch?.token });
  await action("startAutonomous", { jobId: state.jobs[0].id }); await progress(); expect(fixture.submit).toHaveBeenCalledTimes(1);
});
it("distinguishes a click without confirmation from a submitted application", async () => {
  fixture.submit.mockImplementationOnce(async (app, options) => { await options.beforeAttempt({ version: 1, kind: "captcha", sessionId: app.browserSessionId, targetUrl: app.form.url, attemptedAt: new Date().toISOString(), beforeHash: "before", beforeHadConfirmation: false }); return { confirmed: false, evidence: "Still processing" }; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  expect(fixture.state!.applications[0].status).toBe("uncertain"); expect(fixture.state!.applications[0].submittedAt).toBeUndefined();
});
it.each(["pdf", "docx"])("uses the exact confirmed uploaded %s when tailoring is disabled", async (extension) => {
  const profile = fixture.state!.profile; const bytes = Buffer.from(extension === "pdf" ? "%PDF-original-confirmed-upload" : "PK-original-confirmed-docx");
  const key = `${profile.id}/00000000-0000-4000-8000-000000000001.${extension}`;
  await mkdir(`.data/resumes/${profile.id}`, { recursive: true }); await writeFile(`.data/resumes/${key}`, bytes);
  profile.resumeFileName = `my-original.${extension}`; profile.resumeSource = { storageKey: key, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mimeType: extension === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  profile.automationSettings!.resumeTailoring = false; activateAutomation(profile, "original preference confirmed");
  try {
    expect((await action("startAutonomous", { jobId: fixture.state!.jobs[0].id })).status).toBe(200); await progress();
    const app = fixture.state!.applications[0]; expect(app.status).toBe("submitted"); expect(fixture.parse).not.toHaveBeenCalled();
    expect(app.submissionMaterials?.resumeMode).toBe("original"); expect(app.submissionMaterials?.files[0].filename).toBe(`my-original.${extension}`);
    expect(app.packet?.files?.[0]).toMatchObject({ filename: `my-original.${extension}`, mimeType: profile.resumeSource.mimeType, sha256: profile.resumeSource.sha256, size: bytes.length });
    expect((await (await import("@/lib/packet-files")).reviewedPacketFile(profile, app.packet!, "resume")).bytes.equals(bytes)).toBe(true);
  } finally { await rm(`.data/resumes/${key}`, { force: true }); }
});
it("blocks a changed form after filling without a submit attempt", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); await step(); fixture.state!.applications[0].form!.fields[0].value = "changed";
  await progress(); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.submit).not.toHaveBeenCalled(); expect(fixture.state!.applications[0].submissionAttemptedAt).toBeUndefined();
});
it("blocks a revised profile before filling the prepared packet", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); fixture.state!.profile.automationAuthorization!.status = "paused";
  await expect(step()).rejects.toThrow(/enable your current automation/); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.prepare).not.toHaveBeenCalled();
});
it("blocks unsupported essays without requesting review or submitting", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); result.form.fields.push({ label: "Why are you excited to join us?", identifier: "why", kind: "textarea", required: true, value: "", valid: false }); return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); const app = fixture.state!.applications[0];
  expect(app.status).toBe("needs_user_action"); expect(app.form?.blockers?.join(" ")).toMatch(/essays/); expect(app.approvals).toEqual([]); expect(app.browserSessionId).toBeUndefined(); expect(fixture.submit).not.toHaveBeenCalled();
});
it("includes a grounded optional cover letter when the saved mode is enabled", async () => {
  fixture.state!.profile.automationSettings!.coverLetterMode = "enabled"; activateAutomation(fixture.state!.profile, "letter mode confirmed");
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); const file = args[0].packet.files.find((item: { kind: string }) => item.kind === "cover-letter"); if (file) result.form.fields.push({ label: "Cover letter", identifier: "cover", kind: "file", required: false, value: file.filename, valid: true, fileHashes: [`${file.filename}:${file.size}:${file.sha256}`] }); return result; });
  expect((await action("startAutonomous", { jobId: fixture.state!.jobs[0].id })).status).toBe(200); await progress();
  const app = fixture.state!.applications[0]; expect(app.status).toBe("submitted"); expect(app.packet?.coverLetter).toContain("Dear Hiring Team");
  expect(app.packet?.files?.map((file) => file.kind)).toEqual(["resume", "cover-letter"]);
  expect((await (await import("@/lib/packet-files")).reviewedPacketFile(fixture.state!.profile, app.packet!, "cover-letter")).bytes.subarray(0, 4).toString()).toBe("%PDF");
});
it("rejects mutated packet bytes before the fill provider is invoked", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); fixture.state!.applications[0].packet!.files![0].sha256 = "tampered";
  await expect(step()).rejects.toThrow(); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.prepare).not.toHaveBeenCalled();
});
it("saves every continuation with its ready result before a worker handoff", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  const packetSave = fixture.saved.find((state) => state.applications[0]?.status === "authorized_to_fill" && state.applications[0].packet);
  expect(packetSave?.applications[0].queuedRun?.kind).toBe("fill");
  const formSave = fixture.saved.find((state) => state.applications[0]?.status === "submitting" && state.applications[0].form && !state.applications[0].submissionWorkerClaimedAt);
  expect(formSave?.applications[0].submissionDispatch?.token).toBeTruthy(); expect(formSave?.applications[0].autonomousAuthorization?.formHash).toBe(formSave?.applications[0].form?.hash);
});
it("replays an ambiguous submit handoff with the same durable token and only one attempt", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); fixture.triggerFailure = "submit-application-form"; await step();
  const app = fixture.state!.applications[0]; expect(app.submissionDispatch?.confirmedAt).toBeUndefined(); const token = app.submissionDispatch?.token;
  fixture.triggerFailure = ""; await (await import("@/lib/application-queue")).dispatchUserQueue(fixture.state!.profile.id);
  expect(app.submissionDispatch?.token).toBe(token); await progress(); expect(fixture.submit).toHaveBeenCalledTimes(1); expect(app.status).toBe("submitted");
});
it("refuses an old unsealed autonomous metadata record without manufacturing approvals", async () => {
  const state = fixture.state!; const app = (await import("@/lib/workflow")).selectApplication(state, state.jobs[0].id, state.profile.id);
  (await import("@/lib/workflow")).authorizeAutonomous(app, state.profile.id, state.profile.automationVersion!, state.jobs[0].applyUrl);
  expect((await action("startAutonomous", { jobId: state.jobs[0].id })).status).toBe(400); expect(app.approvals).toEqual([]); expect(fixture.parse).not.toHaveBeenCalled(); expect(fixture.prepare).not.toHaveBeenCalled();
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
it.each(["draft", "fill"] as const)("rechecks persisted policy after a deferred %s snapshot before any provider call", async (phase) => {
  for (const change of ["pause", "revise", "close"]) {
    await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
    if (phase === "fill") await step();
    const read = deferred(), resume = deferred();
    fixture.afterLoad = async (state) => { if (!state.applications[0].runWorkerClaimedAt) return; fixture.afterLoad = undefined; read.resolve(); await resume.promise; };
    const running = step(); await read.promise;
    if (change === "pause") fixture.state!.profile.automationAuthorization!.status = "paused";
    if (change === "revise") fixture.state!.profile.name = "Changed while provider snapshot was deferred";
    if (change === "close") fixture.state!.jobs[0].active = false;
    resume.resolve(); await expect(running).rejects.toThrow();
    if (phase === "draft") expect(fixture.parse).not.toHaveBeenCalled();
    expect(fixture.prepare).not.toHaveBeenCalled(); expect(fixture.state!.applications[0].status).toBe("needs_user_action");
    // Each race starts a distinct authorized opportunity, never reopens the blocked one.
    fixture.state!.jobs[0] = { ...fixture.state!.jobs[0], id: `race-${phase}-${change}`, url: `https://controlled.example/${phase}/${change}`, applyUrl: `https://controlled.example/${phase}/${change}`, active: true };
    fixture.state!.profile.name = latexFixture().profile.name;
    activateAutomation(fixture.state!.profile, "next controlled race");
    fixture.pending = []; fixture.parse.mockClear();
  }
});
it.each(["form", "action"])("blocks an unexpected same-origin posting in the observed %s destination", async (destination) => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); const other = new URL(result.form.url); other.pathname = "/different-posting"; if (destination === "form") result.form.url = other.href; else result.form.submitControl.action = other.href; return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await expect(progress()).rejects.toThrow(/destination/);
  expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.state!.applications[0].error).toMatch(/destination|form/); expect(fixture.submit).not.toHaveBeenCalled();
});
it("checks current policy between paid résumé generation and its grounding call", async () => {
  const generated = deferred(), resume = deferred(); const known = fixture.parse.getMockImplementation()!;
  fixture.parse.mockImplementationOnce(async (...args) => { const result = await known(...args); generated.resolve(); await resume.promise; return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); const running = step(); await generated.promise;
  fixture.state!.profile.automationAuthorization!.status = "paused"; resume.resolve();
  await expect(running).rejects.toThrow(); expect(fixture.parse).toHaveBeenCalledTimes(1); expect(fixture.prepare).not.toHaveBeenCalled();
});
it("prepares a discovered required letter and continues the same browser session automatically", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const initial = await known(...args); const resume = args[0].packet.files[0];
    initial.form.fields.push({ label: "Cover letter", identifier: "cover", kind: "file", required: true, value: "", valid: false });
    const packet = await args[5](initial.form);
    expect(packet.files[0]).toEqual(resume);
    const file = packet.files.find((item: { kind: string }) => item.kind === "cover-letter");
    initial.form.fields[1] = { ...initial.form.fields[1], value: file.filename, valid: true, fileHashes: [`${file.filename}:${file.size}:${file.sha256}`] };
    return initial;
  });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  const app = fixture.state!.applications[0]; expect(app.status).toBe("submitted"); expect(app.approvals).toEqual([]);
  expect(fixture.prepare).toHaveBeenCalledTimes(1); expect(app.packet?.coverLetterFactIds?.length).toBeGreaterThan(0);
  expect(app.autonomousAuthorization?.filesHash).toBeTruthy(); expect(app.form?.fields[1].value).toBe("cover-letter.pdf");
});

it("keeps required letters blocked when letters are disabled without overriding the preference", async () => {
  fixture.state!.profile.automationSettings!.coverLetterMode = "disabled"; activateAutomation(fixture.state!.profile, "disabled confirmed");
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); result.needsCoverLetter = result.needsAction = true; result.form.readyToSubmit = false; result.form.fields.push({ label: "Cover letter", identifier: "cover", kind: "file", required: true, value: "", valid: false }); return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  const app = fixture.state!.applications[0]; expect(app.status).toBe("needs_user_action"); expect(app.form?.blockers?.join(" ")).toMatch(/saved cover-letter mode/);
  expect(app.packet?.coverLetter).toBeUndefined(); expect(app.packet?.files).toHaveLength(1); expect(fixture.submit).not.toHaveBeenCalled();
});
it.each(["required-only", "disabled"] as const)("omits an optional cover letter in %s mode", async (mode) => {
  fixture.state!.profile.automationSettings!.coverLetterMode = mode; activateAutomation(fixture.state!.profile, "optional letter preference");
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); result.form.fields.push({ label: "Cover letter", identifier: "cover", kind: "file", required: false, value: "", valid: true }); return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); expect(fixture.state!.applications[0].status).toBe("submitted"); expect(fixture.state!.applications[0].packet?.coverLetter).toBeUndefined();
});
it("rejects revoked grounding facts during a required letter continuation", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); result.form.fields.push({ label: "Cover letter", kind: "file", required: true, value: "", valid: false }); fixture.state!.profile.facts[0].verified = false; return args[5](result.form); });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await expect(progress()).rejects.toThrow(/authorization changed/); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.state!.applications[0].packet?.coverLetter).toBeUndefined(); expect(fixture.submit).not.toHaveBeenCalled();
});
it("blocks saved material preferences changed before a queued fill", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step();
  expect((await action("automationSettings", { coverLetterMode: "disabled" })).status).toBe(200);
  await expect(progress()).rejects.toThrow(); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.prepare).not.toHaveBeenCalled(); expect(fixture.submit).not.toHaveBeenCalled();
});
it("lets the owner inspect exact submitted artifacts after changing profile facts", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); const app = fixture.state!.applications[0];
  fixture.state!.profile.facts[0].text = "A later profile revision must not replace the material already used";
  const { GET } = await import("@/app/api/applications/[id]/files/[kind]/route");
  const response = await GET(new Request("https://apply.example/file?download=1"), { params: Promise.resolve({ id: app.id, kind: "resume" }) });
  expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-controlled");
});
it("submits the résumé when enabled letters have no supported control and records no unused letter", async () => {
  fixture.state!.profile.automationSettings!.coverLetterMode = "enabled"; activateAutomation(fixture.state!.profile, "enabled optional material");
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); const app = fixture.state!.applications[0];
  expect(app.status).toBe("submitted"); expect(app.packet?.coverLetter).toBeTruthy(); expect(app.submissionMaterials?.files.map((file) => file.kind)).toEqual(["resume"]);
});
it("keeps the exact attached letter downloadable independently of the live packet or renderer", async () => {
  fixture.state!.profile.automationSettings!.coverLetterMode = "enabled"; activateAutomation(fixture.state!.profile, "enabled letter archive");
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => { const result = await known(...args); const file = args[0].packet.files.find((item: { kind: string }) => item.kind === "cover-letter"); result.form.fields.push({ label: "Cover letter", identifier: "cover", kind: "file", required: false, valid: true, value: file.filename, fileHashes: [`${file.filename}:${file.size}:${file.sha256}`] }); return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); const app = fixture.state!.applications[0];
  const { GET } = await import("@/app/api/applications/[id]/files/[kind]/route");
  const parameters = { params: Promise.resolve({ id: app.id, kind: "cover-letter" }) };
  const before = await GET(new Request("https://apply.example/file"), parameters); expect(before.status).toBe(200); const bytes = await before.arrayBuffer();
  app.packet = undefined; fixture.state!.profile.facts[0].text = "Updated after the attempt";
  const archived = await GET(new Request("https://apply.example/file"), parameters); expect(archived.status).toBe(200); expect(Buffer.from(await archived.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
});
