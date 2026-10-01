import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Application } from "@/lib/types";
const fixture = vi.hoisted(() => ({ state: null as AppState | null, pending: [] as Array<{ task: string; payload: { userId: string; applicationId: string; runToken?: string } }>, queue: Promise.resolve(), saved: [] as AppState[], triggerFailure: "", afterLoad: undefined as undefined | ((state: AppState) => void | Promise<void>), budget: true, beforeUsageStart: undefined as undefined | ((operation: string) => Promise<void>), prepare: vi.fn(), preflight: vi.fn(), submit: vi.fn(), cancel: vi.fn(), refresh: vi.fn(), parse: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (fixture.beforeUsageStart && String(args[0]).includes("apply-model-usage-") && typeof args[1] === "string") {
      const records = JSON.parse(args[1]);
      const started = records.find((record: { operation: string; status: string }) => record.status === "started" && record.operation.startsWith("essay-"));
      if (started) await fixture.beforeUsageStart(started.operation);
    }
    return fs.writeFile(...args);
  } };
});

vi.mock("@trigger.dev/sdk", () => ({ task: (config: unknown) => config, tasks: { trigger: async (task: string, payload: { userId: string; applicationId: string; runToken?: string }) => { fixture.pending.push({ task, payload }); if (fixture.triggerFailure === task) throw new Error("Accepted handoff timed out"); return { id: "dispatch" }; } } }));
vi.mock("@/lib/repository", () => ({ isDemo: () => false, currentUserId: async () => fixture.state!.profile.id, loadState: async () => { const snapshot = structuredClone(fixture.state); await fixture.afterLoad?.(fixture.state!); return snapshot; }, mutateState: async (_user: string, change: (state: AppState) => unknown) => { const pending = fixture.queue.then(async () => { const result = await change(fixture.state!); fixture.saved.push(structuredClone(fixture.state!)); return result; }); fixture.queue = pending.then(() => undefined, () => undefined); return pending; } }));
vi.mock("@/lib/budget", () => ({ serviceBudgetMonth: () => "2026-10", browserBudgetReservationId: (applicationId: string, attemptId: string) => `browser:${applicationId}:${attemptId}`, releaseBrowserBudget: async () => true, reserveServiceBudget: async () => fixture.budget, reserveBrowserBudget: async () => fixture.budget, reserveQueuedBudget: async (_user: string, app: string, queued: string, projected: number) => fixture.budget ? { queuedId: queued, reservationId: `queued:${queued}`, month: "2026-10", ownerId: "owner", applicationId: app, projectedUsd: projected } : null, releaseQueuedBudget: async () => true, markQueuedBudgetClaimed: async () => true, markQueuedBudgetTerminal: async () => true }));
vi.mock("openai", () => ({ default: class { responses = { parse: fixture.parse }; } }));
vi.mock("@/lib/latex-compiler", () => ({ fitResume: async (_profile: unknown, document: unknown) => ({ document, pdf: Buffer.from("%PDF-controlled"), source: "controlled compiler" }) }));
vi.mock("@/lib/browser-runner", () => ({ prepareBrowser: fixture.prepare, preflightBrowser: fixture.preflight, submitBrowser: fixture.submit, cancelBrowser: fixture.cancel, refreshBrowserSnapshot: fixture.refresh, repairEducationFields: vi.fn(), fillApprovedBrowserAnswers: vi.fn(), checkBrowserSubmission: vi.fn() }));
import { latexFixture } from "@/lib/latex-fixture";
import { initialDemoState } from "@/lib/demo-data";
import { saveOnboarding, activateAutomation } from "@/lib/onboarding";
import { runDraft, runFill } from "@/lib/application-runs";
import { runSubmission } from "@/lib/application-submission";
import { POST } from "@/app/api/actions/route";
import { GET as getApplicationFile } from "@/app/api/applications/[id]/files/[kind]/route";
import { recordApplicationBlocker } from "@/lib/application-blockers";

const action = (name: string, payload: Record<string, unknown>) => POST(new Request("https://apply.example/api/actions", { method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action: name, payload }) }));
async function step() { const next = fixture.pending.shift()!; if (next.task === "draft-application-packet") await runDraft(next.payload); else if (next.task === "fill-application-form") await runFill(next.payload); else if (next.task === "submit-application-form") await runSubmission(next.payload); return next; }
async function progress() { while (fixture.pending.length) await step(); }
beforeEach(() => {
  vi.clearAllMocks(); fixture.cancel.mockResolvedValue(undefined); fixture.refresh.mockReset(); fixture.pending = []; fixture.saved = []; fixture.triggerFailure = ""; fixture.afterLoad = undefined; fixture.queue = Promise.resolve(); fixture.budget = true; fixture.beforeUsageStart = undefined;
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "fixture"); vi.stubEnv("EMAIL_FROM", "");
  const source = latexFixture(); fixture.state = initialDemoState(); fixture.state.profile = source.profile; fixture.state.applications = [];
  saveOnboarding(fixture.state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); activateAutomation(fixture.state.profile, "controlled-test");
  fixture.parse.mockImplementation(async (input) => {
    const format = input.text.format.name;
    const request = format === "resume_grounding_audit" ? JSON.parse(input.input[1].content) : undefined;
    const output_parsed = format === "structured_resume" ? source.document : format === "resume_grounding_audit" ? { findings: request.claims.map((claim: { claimId: string; factIds: string[] }) => ({ claimId: claim.claimId, outcome: "supported", reason: "The confirmed facts support this claim.", evidenceFactIds: claim.factIds, requiredInformation: null })) } : { grounded: true, unsupportedClaims: [] };
    return { id: `response-${Math.random()}`, model: input.model, service_tier: "default", output_parsed, usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
  });
  fixture.preflight.mockReset();
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
it("carries a successful resume repair through artifact preview, download, and employer attachment", async () => {
  const source = latexFixture();
  const unsupported = structuredClone(source.document);
  unsupported.experience[0].bullets[0].text = "Increased company revenue by 90%.";
  fixture.state!.profile.id = "resume-repair-flow-user";
  let writes = 0;
  let audits = 0;
  fixture.parse.mockImplementation(async (input) => {
    if (input.text.format.name === "structured_resume") {
      writes++;
      return { id: `write-${writes}`, model: input.model, service_tier: "default", output_parsed: writes === 1 ? unsupported : source.document, usage: { input_tokens: 20, output_tokens: 10 } };
    }
    if (input.text.format.name === "resume_grounding_audit") {
      audits++;
      const request = JSON.parse(input.input[1].content);
      return { id: `audit-${audits}`, model: input.model, service_tier: "default", output_parsed: { findings: request.claims.map((claim: { claimId: string; factIds: string[] }) => claim.claimId === "experience.0.bullets.0" && audits === 1
        ? { claimId: claim.claimId, outcome: "unsupported", reason: "The confirmed fact describes a prediction model, not increased revenue.", evidenceFactIds: claim.factIds, requiredInformation: "Confirm whether revenue increased and provide the measured amount." }
        : { claimId: claim.claimId, outcome: "supported", reason: "The confirmed facts support this claim.", evidenceFactIds: claim.factIds, requiredInformation: null }) }, usage: { input_tokens: 20, output_tokens: 10 } };
    }
    return { id: "essay-response", model: input.model, service_tier: "default", output_parsed: { grounded: true, unsupportedClaims: [] }, usage: { input_tokens: 20, output_tokens: 10 } };
  });

  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await progress();
  const app = fixture.state!.applications[0];
  expect(app.status).toBe("submitted");
  expect(app.approvals).toEqual([]);
  expect(app.packet?.resumeDocument?.grounding).toMatchObject({ writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 });
  expect(app.packet?.resumeDocument?.experience[0].bullets[0].text).not.toContain("90%");
  const resume = app.packet!.files!.find((file) => file.kind === "resume")!;
  expect(app.submissionMaterials?.files.find((file) => file.kind === "resume")).toEqual(resume);
  expect(app.form?.fields.find((field) => field.identifier === "resume")?.fileHashes).toEqual([`${resume.filename}:${resume.size}:${resume.sha256}`]);

  const preview = await getApplicationFile(new Request(`https://apply.example/api/applications/${app.id}/files/resume`), { params: Promise.resolve({ id: app.id, kind: "resume" }) });
  const download = await getApplicationFile(new Request(`https://apply.example/api/applications/${app.id}/files/resume?download=1`), { params: Promise.resolve({ id: app.id, kind: "resume" }) });
  expect(preview.status).toBe(200); expect(download.status).toBe(200);
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(Buffer.from(await download.arrayBuffer()));
  expect(preview.headers.get("content-disposition")).toContain("inline");
  expect(download.headers.get("content-disposition")).toContain("attachment");
  await rm(`.data/application-files/${resume.storageKey}`, { force: true });
  await rm(`.data/application-files/${app.packet!.resumeArtifact!.source.storageKey}`, { force: true });
});
it("keeps exhausted grounding findings as an actionable blocker and schedules no attachment", async () => {
  const source = latexFixture();
  const unsupported = structuredClone(source.document);
  unsupported.experience[0].bullets[0].text = "Increased company revenue by 90%.";
  fixture.state!.profile.resumeText = "Orbit Labs · Built an XGBoost model to predict campaign ROI.";
  let writes = 0;
  fixture.parse.mockImplementation(async (input) => {
    if (input.text.format.name === "structured_resume") { writes++; return { id: `write-${writes}`, model: input.model, service_tier: "default", output_parsed: unsupported, usage: { input_tokens: 20, output_tokens: 10 } }; }
    const request = JSON.parse(input.input[1].content);
    return { id: `audit-${writes}`, model: input.model, service_tier: "default", output_parsed: { findings: request.claims.map((claim: { claimId: string; factIds: string[]; affectedText: string }) => claim.claimId === "experience.0.bullets.0"
      ? { claimId: claim.claimId, outcome: writes === 3 ? "contradiction" : "unsupported", reason: "The confirmed fact describes prediction, not increased revenue.", evidenceFactIds: claim.factIds, requiredInformation: "Confirm whether revenue increased and provide the measured amount." }
      : { claimId: claim.claimId, outcome: "supported", reason: "The confirmed facts support this claim.", evidenceFactIds: claim.factIds, requiredInformation: null }) }, usage: { input_tokens: 20, output_tokens: 10 } };
  });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const draft = fixture.pending.shift()!;
  await expect(runDraft(draft.payload)).rejects.toMatchObject({ diagnostics: { outcome: "needs_information", writerAttempts: 3, checkerAttempts: 3, repairAttempts: 2 } });
  const app = fixture.state!.applications[0];
  expect(app.status).toBe("needs_user_action");
  expect(app.packet).toBeUndefined();
  expect(app.resumeDraftDiagnostics?.findings.find((finding) => finding.claimId === "experience.0.bullets.0")).toMatchObject({ outcome: "contradiction", affectedText: "Increased company revenue by 90%.", evidenceFactIds: ["latex-fact-2"] });
  expect(app.blockers?.[0]).toMatchObject({ reason: "missing_answer", progress: "blocked" });
  expect(app.blockers?.[0].message).toContain("Confirm whether revenue increased and provide the measured amount");
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.pending).toEqual([]);
});
it("keeps a confirmed receipt and visible release hold when provider stop is still active", async () => {
  fixture.submit.mockImplementationOnce(async (app: Application, options: { beforeAttempt: (baseline: NonNullable<Application["submissionVerification"]>) => Promise<boolean> }) => {
    const baseline = { version: 1 as const, kind: "captcha" as const, sessionId: app.browserSessionId!, targetUrl: app.form!.url, attemptedAt: new Date().toISOString(), beforeHash: "baseline", beforeHadConfirmation: false };
    expect(await options.beforeAttempt(baseline)).toBe(true);
    app.browserReleasePending = { sessionId: app.browserSessionId!, requestedAt: new Date().toISOString(), attempts: 1, lastError: "provider still active" };
    return { confirmed: true, evidence: "Application received", receipt: { version: 1, url: app.form!.url, text: "Application received", capturedAt: new Date().toISOString() } };
  });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await progress();
  const app = fixture.state!.applications[0];
  expect(app.status).toBe("submitted");
  expect(app.submissionReceipt?.text).toBe("Application received");
  expect(app.browserReleasePending?.sessionId).toBe(app.browserSessionId);
  expect(app.blockers?.some((item) => item.reason === "resource_hold" && item.progress === "blocked")).toBe(true);
  expect(fixture.submit).toHaveBeenCalledTimes(1);
});
it("resolves a missing-answer blocker through the public action and rebuilds the same application", async () => {
  fixture.budget = false;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const app = fixture.state!.applications[0];
  app.status = "needs_user_action";
  app.queuedRun = undefined;
  const blocker = recordApplicationBlocker(app, "missing_answer", "Provide the missing graduation year");
  fixture.state!.profile.graduationYear = "2027";
  fixture.budget = true;
  const response = await action("resolveBlocker", { applicationId: app.id, blockerId: blocker.id });
  expect(response.status).toBe(200);
  await progress();
  expect(fixture.state!.applications[0].id).toBe(app.id);
  expect(fixture.state!.applications[0].status).toBe("submitted");
  expect(fixture.state!.applications[0].approvals).toEqual([]);
  expect(fixture.state!.applications[0].blockers?.find((item) => item.id === blocker.id)?.progress).toBe("resolved");
});
it("lets the owner answer an observed required select and resumes the same application", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const result = await known(...args);
    result.needsAction = true;
    result.form.readyToSubmit = false;
    result.form.fields.push({ label: "Favorite snack", identifier: "snack", kind: "select", required: true, value: "", options: ["Tea", "Coffee"], valid: false });
    result.form.blockers = ["Correct or complete the field: Favorite snack"];
    return result;
  });
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const result = await known(...args);
    const answer = args[0].autonomousHumanAnswers?.find((item: { question: { identifier: string } }) => item.question.identifier === "snack");
    if (answer) {
      result.form.fields.push({ label: "Favorite snack", identifier: "snack", kind: "select", required: true, value: answer.value, options: ["Tea", "Coffee"], valid: true });
    }
    return result;
  });
  fixture.budget = true;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await progress();
  const app = fixture.state!.applications[0];
  const blocker = app.blockers?.find((item) => item.reason === "missing_answer");
  expect(blocker?.context?.observedQuestion).toMatchObject({ identifier: "snack", options: ["Tea", "Coffee"] });
  const response = await action("resolveBlocker", {
    applicationId: app.id,
    blockerId: blocker!.id,
    answer: { question: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Coffee"] }, value: "Coffee" },
  });
  expect(response.status).toBe(200);
  await progress();
  expect(fixture.state!.applications[0].id).toBe(app.id);
  expect(fixture.state!.applications[0].autonomousHumanAnswers?.[0].value).toBe("Coffee");
  expect(fixture.state!.applications[0].status).toBe("submitted");
  expect(fixture.state!.applications[0].approvals).toEqual([]);
});
it("binds and resumes an observed radio by its exact underlying values", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const result = await known(...args);
    result.needsAction = true;
    result.form.readyToSubmit = false;
    result.form.fields.push(
      { label: "Preferred work pattern", identifier: "work-pattern", kind: "radio", required: true, value: "Remote", optionValue: "pattern-remote", checked: false, valid: false },
      { label: "Preferred work pattern", identifier: "work-pattern", kind: "radio", required: true, value: "Office", optionValue: "pattern-office", checked: false, valid: false },
    );
    result.form.blockers = ["Correct or complete the field: Preferred work pattern"];
    return result;
  });
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const result = await known(...args);
    const answer = args[0].autonomousHumanAnswers?.find((item: { question: { identifier: string } }) => item.question.identifier === "work-pattern");
    result.form.fields.push(
      { label: "Preferred work pattern", identifier: "work-pattern", kind: "radio", required: true, value: "Remote", optionValue: "pattern-remote", checked: answer?.value === "pattern-office" ? false : answer?.value === "pattern-remote", valid: Boolean(answer?.value) },
      { label: "Preferred work pattern", identifier: "work-pattern", kind: "radio", required: true, value: "Office", optionValue: "pattern-office", checked: answer?.value === "pattern-office", valid: Boolean(answer?.value) },
    );
    return result;
  });
  fixture.budget = true;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await progress();
  const app = fixture.state!.applications[0];
  const blocker = app.blockers?.find((item) => item.reason === "missing_answer");
  expect(blocker?.context?.observedQuestion).toMatchObject({ identifier: "work-pattern", kind: "radio", options: ["Remote", "Office"] });
  const radioResponse = await action("resolveBlocker", {
    applicationId: app.id,
    blockerId: blocker!.id,
    answer: { question: { identifier: "work-pattern", label: "Preferred work pattern", kind: "radio", options: ["Remote", "Office"] }, value: "pattern-office" },
  });
  expect(radioResponse.status).toBe(200);
  await progress();
  expect(app.autonomousHumanAnswers?.[0].value).toBe("pattern-office");
  expect(app.autonomousHumanAnswers?.[0].question.optionValues).toEqual(["pattern-remote", "pattern-office"]);
  expect(app.status).toBe("submitted");
});
it("refreshes a stale observed question under current authorization before accepting a new answer", async () => {
  fixture.budget = false;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const app = fixture.state!.applications[0];
  app.status = "needs_user_action";
  app.queuedRun = undefined;
  app.form = { version: 1, url: fixture.state!.jobs[0].applyUrl, fields: [{ identifier: "snack", label: "Favorite snack", kind: "select", value: "", options: ["Tea", "Coffee"], required: true, valid: false }], attachments: [], capturedAt: new Date().toISOString(), hash: "old-question", readyToSubmit: false };
  const blocker = recordApplicationBlocker(app, "missing_answer", "Correct or complete the field: Favorite snack", { formHash: "old-question", targetUrl: app.form.url, observedQuestion: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Coffee"], value: "" } });
  fixture.state!.profile.name = "Current applicant";
  fixture.budget = true;
  const response = await action("resolveBlocker", { applicationId: app.id, blockerId: blocker.id, freshReconstruct: true });
  expect(response.status).toBe(200);
  expect(app.id).toBe(fixture.state!.applications[0].id);
  expect(app.form).toBeUndefined();
  expect(app.autonomousHumanAnswers).toBeUndefined();
  expect(["drafting", "filling", "authorized_to_fill", "needs_user_action"]).toContain(fixture.state!.applications[0].status);
});
it("discards a previously bound answer when fresh reconstruction follows a profile change", async () => {
  fixture.budget = false;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const app = fixture.state!.applications[0];
  app.status = "needs_user_action";
  app.queuedRun = undefined;
  app.form = { version: 1, url: fixture.state!.jobs[0].applyUrl, fields: [{ identifier: "snack", label: "Favorite snack", kind: "select", value: "Coffee", options: ["Tea", "Coffee"], required: true, valid: true }], attachments: [], capturedAt: new Date().toISOString(), hash: "old-question", readyToSubmit: false };
  app.autonomousHumanAnswers = [{ version: 1, userId: app.userId, applicationId: app.id, targetUrl: app.form.url, profileHash: app.autonomousAuthorization!.profileHash!, formHash: "old-question", question: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Coffee"] }, value: "Coffee", confirmedAt: new Date().toISOString() }];
  const blocker = recordApplicationBlocker(app, "missing_answer", "Correct or complete the field: Favorite snack", { formHash: "old-question", targetUrl: app.form.url, observedQuestion: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Coffee"], value: "Coffee" } });
  const normal = fixture.prepare.getMockImplementation()!;
  fixture.state!.profile.name = "Current applicant";
  fixture.budget = true;
  fixture.prepare.mockImplementationOnce(async (...args) => {
    expect(args[0].autonomousHumanAnswers).toBeUndefined();
    const result = await normal(...args);
    result.needsAction = true;
    result.form.readyToSubmit = false;
    result.form.fields.push({ label: "Favorite snack", identifier: "snack", kind: "select", required: true, value: "", options: ["Tea", "Coffee"], valid: false });
    result.form.blockers = ["Correct or complete the field: Favorite snack"];
    return result;
  });
  expect((await action("resolveBlocker", { applicationId: app.id, blockerId: blocker.id, freshReconstruct: true })).status).toBe(200);
  await progress();
  expect(app.autonomousHumanAnswers).toBeUndefined();
  expect(app.blockers?.find((item) => item.id === blocker.id)?.context?.observedQuestion?.value).toBe("");
  expect(app.status).toBe("needs_user_action");
});
it("parks a pre-click form drift in actionable review instead of leaving submitting", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await step();
  await step();
  const app = fixture.state!.applications[0];
  fixture.submit.mockRejectedValueOnce(new Error("FORM_CHANGED"));
  fixture.refresh.mockResolvedValue({ ...app.form!, readyToSubmit: false, blockers: ["The employer form changed before Submit."] });
  await step();
  expect(app.status).toBe("needs_user_action");
  expect(app.submissionAttemptedAt).toBeUndefined();
  expect(app.submissionDispatch).toBeUndefined();
  expect(app.blockers?.some((item) => /form changed/i.test(item.message))).toBe(true);
});
it("keeps the owner slot held when a blocked browser release is not confirmed", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const result = await known(...args);
    result.needsAction = true;
    result.form.readyToSubmit = false;
    result.form.blockers = ["Sign in to continue"];
    return result;
  });
  fixture.cancel.mockRejectedValueOnce(new Error("provider release timeout"));
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await progress();
  const app = fixture.state!.applications[0];
  expect(app.status).toBe("needs_user_action");
  expect(app.browserSessionId).toBe("session");
  expect(app.browserReleasePending?.sessionId).toBe("session");
  expect(app.blockers?.some((item) => item.reason === "resource_hold")).toBe(true);
  expect(fixture.cancel).toHaveBeenCalledTimes(1);
});
it("retains an allocated session when cancellation wins before the form is durably saved", async () => {
  const known = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementationOnce(async (...args) => {
    const result = await known(...args);
    fixture.state!.applications[0].status = "cancelled";
    return result;
  });
  fixture.cancel.mockRejectedValueOnce(new Error("provider release timeout"));
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  await progress();
  const app = fixture.state!.applications[0];
  expect(app.status).toBe("cancelled");
  expect(app.browserSessionId).toBe("session");
  expect(app.browserReleasePending?.sessionId).toBe("session");
  expect(app.blockers?.some((item) => item.reason === "resource_hold")).toBe(true);
});
it("rejects public blocker resume during a release hold, then resumes after confirmed stop", async () => {
  fixture.budget = false;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const app = fixture.state!.applications[0];
  app.status = "needs_user_action";
  app.queuedRun = undefined;
  app.browserSessionId = "remote-session";
  app.browserReleasePending = { sessionId: "remote-session", requestedAt: new Date().toISOString(), attempts: 1 };
  const blocker = recordApplicationBlocker(app, "missing_answer", "Provide the missing graduation year");
  expect((await action("resolveBlocker", { applicationId: app.id, blockerId: blocker.id })).status).toBe(400);
  expect(app.browserSessionId).toBe("remote-session");
  expect(fixture.pending).toHaveLength(0);
  app.browserSessionId = undefined;
  app.browserReleasePending = undefined;
  fixture.budget = true;
  expect((await action("resolveBlocker", { applicationId: app.id, blockerId: blocker.id })).status).toBe(200);
  await progress();
  expect(app.status).toBe("submitted");
});
it("does not enqueue a fresh reconstruction while an allocated browser ref is awaiting release", async () => {
  fixture.budget = false;
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const app = fixture.state!.applications[0];
  app.status = "needs_user_action";
  app.queuedRun = undefined;
  app.browserSessionId = "remote-session";
  const blocker = recordApplicationBlocker(app, "missing_answer", "Provide the missing graduation year");
  expect((await action("resolveBlocker", { applicationId: app.id, blockerId: blocker.id, freshReconstruct: true })).status).toBe(400);
  expect(app.browserSessionId).toBe("remote-session");
  expect(app.browserReleasePending).toBeUndefined();
  expect(fixture.pending).toHaveLength(0);
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
  expect(app.status).toBe("needs_user_action"); expect(app.form?.blockers?.join(" ")).toMatch(/essay/); expect(app.approvals).toEqual([]); expect(app.browserSessionId).toBeUndefined(); expect(fixture.submit).not.toHaveBeenCalled();
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
it("continues an existing packet essay through submission under current automation without confirming it", async () => {
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id });
  const state = fixture.state!; const fact = state.profile.facts.find((item) => item.verified)!; const app = state.applications[0];
  app.packet = await (await import("@/lib/packet-files")).withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", summary: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [{ question: "Describe a challenging project.", answer: "", factIds: [], requiresUserInput: true, author: "ai" }], profileHash: (await import("@/lib/drafting")).packetProfileHash(state.profile) });
  fixture.parse.mockImplementation(async (input) => ({ id: `response-${Math.random()}`, model: input.model, output_parsed: input.text.format.name === "application_essay" ? { sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "A practical approach to a difficult project is to clarify its constraints and test the riskiest assumption first.", kind: "perspective", factIds: [] }] } : { grounded: true, unsupportedClaims: [] }, usage: { input_tokens: 20, output_tokens: 10 } }));
  const prepare = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementation(async (...args) => {
    const result = await prepare(...args); const essay = args[0].packet.answers[0];
    if (essay) {
      const field = { label: essay.question, identifier: "project-essay", kind: "textarea", required: true, valid: false, value: "" };
      result.form.fields.push(field); const packet = await args[6]({ ...result.form, readyToSubmit: false }); field.value = packet.answers[0].answer; field.valid = true;
    }
    return result;
  });
  await progress();
  expect(app.status).toBe("submitted"); expect(app.packet!.answers).toHaveLength(1); expect(app.packet!.answers[0].answer).toContain(fact.text);
  expect(app.packet!.answers[0].confirmedAt).toBeUndefined(); expect(app.approvals).toEqual([]); expect(fixture.submit).toHaveBeenCalledTimes(1);
});
it("answers a newly discovered essay in the same browser session without legacy approvals", async () => {
  const fact = fixture.state!.profile.facts.find((item) => item.verified)!;
  const baseParse = fixture.parse.getMockImplementation()!;
  fixture.parse.mockImplementation(async (input) => input.text.format.name === "application_essay" ? { id: "essay", model: input.model, output_parsed: { sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "Clear constraints and small experiments can make a challenging project easier to evaluate.", kind: "perspective", factIds: [] }] }, usage: { input_tokens: 20, output_tokens: 10 } } : baseParse(input));
  const prepare = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementation(async (...args) => {
    const result = await prepare(...args); const field = { label: "Describe a challenging project.", identifier: "new-project", kind: "textarea", required: true, valid: false, editable: true, value: "" };
    const observed = { ...result.form, fields: [...result.form.fields, field], readyToSubmit: false, blockers: ["Correct or complete the field: Describe a challenging project."] };
    expect(args[6]).toBeTypeOf("function");
    const packet = await args[6](observed); field.value = packet.answers[0].answer; field.valid = true;
    return { ...result, form: { ...observed, readyToSubmit: true, blockers: [] } };
  });
  expect((await action("startAutonomous", { jobId: fixture.state!.jobs[0].id })).status).toBe(200); await progress();
  const app = fixture.state!.applications[0]; expect(app.status).toBe("submitted"); expect(app.approvals).toEqual([]); expect(app.packet!.answers[0].confirmedAt).toBeUndefined(); expect(app.form!.fields.at(-1)?.value).toContain(fact.text); expect(fixture.prepare).toHaveBeenCalledTimes(1);
});
it("submits a general truthful essay when no personal story supports the requested event", async () => {
  const baseParse = fixture.parse.getMockImplementation()!;
  fixture.parse.mockImplementation(async (input) => input.text.format.name === "application_essay" ? { id: "general-essay", model: input.model, output_parsed: { sentences: [{ text: "A useful way to approach a difficult project is to identify the constraints and test the riskiest assumption first.", kind: "perspective", factIds: [] }, { text: "Small experiments and clear acceptance criteria can make tradeoffs easier to evaluate without assuming a particular past outcome.", kind: "perspective", factIds: [] }] }, usage: { input_tokens: 20, output_tokens: 10 } } : baseParse(input));
  const prepare = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementation(async (...args) => {
    const result = await prepare(...args); const field = { label: "Describe a challenging project.", identifier: "general-project", kind: "textarea", required: true, valid: false, value: "" };
    const observed = { ...result.form, fields: [...result.form.fields, field], readyToSubmit: false };
    const packet = await args[6](observed); field.value = packet.answers[0].answer; field.valid = true;
    return { ...result, form: { ...observed, readyToSubmit: true, blockers: [] } };
  });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  const app = fixture.state!.applications[0]; expect(app.status).toBe("submitted"); expect(app.packet!.answers[0].factIds).toEqual([]); expect(app.packet!.answers[0].answer).toMatch(/^A useful way/); expect(app.packet!.answers[0].confirmedAt).toBeUndefined();
});
it("keeps an age declaration human-owned even when phrased as an experience essay", async () => {
  const fact = fixture.state!.profile.facts.find((item) => item.verified)!; const baseParse = fixture.parse.getMockImplementation()!;
  fixture.parse.mockImplementation(async (input) => input.text.format.name === "application_essay" ? { id: "age-essay", model: input.model, output_parsed: { sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "Clear constraints can make tradeoffs easier to evaluate.", kind: "perspective", factIds: [] }] } } : baseParse(input));
  const prepare = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementation(async (...args) => {
    const result = await prepare(...args); const field = { label: "Describe your relevant experience and confirm your age.", identifier: "age", kind: "textarea", required: true, valid: false, value: "" };
    const observed = { ...result.form, fields: [...result.form.fields, field], readyToSubmit: false };
    const questions = (await import("@/lib/browser-questions")).browserQuestions({ ...observed, hash: "observed" });
    if (questions.some((question) => question.owner === "ai")) { const packet = await args[6](observed); field.value = packet.answers[0].answer; field.valid = true; return { ...result, form: { ...observed, readyToSubmit: true, blockers: [] } }; }
    return { ...result, form: observed, needsAction: true };
  });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.submit).not.toHaveBeenCalled(); expect(fixture.parse.mock.calls.some(([input]) => input.text.format.name === "application_essay")).toBe(false);
});
function simulateObservedEssay(question = "Describe a challenging project.", alter?: (state: AppState) => void, identifier = "controlled-essay") {
  const prepare = fixture.prepare.getMockImplementation()!;
  fixture.prepare.mockImplementation(async (...args) => {
    const result = await prepare(...args); const field = { label: question, identifier, kind: "textarea", required: true, valid: false, editable: true, value: "" };
    const observed = { ...result.form, fields: [...result.form.fields, field], readyToSubmit: false };
    const packet = await args[6](observed); field.value = packet.answers.find((answer: { question: string }) => answer.question === question)!.answer; field.valid = true;
    alter?.(fixture.state!);
    return { ...result, form: { ...observed, readyToSubmit: true, blockers: [] } };
  });
}
function essayResponses(sentences?: Array<{ text: string; kind: string; factIds: string[] }>, whenGenerated?: () => void) {
  const fact = fixture.state!.profile.facts.find((item) => item.verified)!; const base = fixture.parse.getMockImplementation()!;
  fixture.parse.mockImplementation(async (input) => {
    if (input.text.format.name !== "application_essay") return base(input);
    whenGenerated?.();
    return { id: "controlled-essay", model: input.model, output_parsed: { sentences: sentences ?? [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "Small experiments can make difficult tradeoffs easier to evaluate.", kind: "perspective", factIds: [] }] }, usage: { input_tokens: 20, output_tokens: 10 } };
  });
}
it("grounds an automatic essay in the applicant's saved role preferences", async () => {
  const profile = fixture.state!.profile; profile.preferredTitles = ["Software Engineering Intern"]; activateAutomation(profile, "saved preference confirmed");
  essayResponses([{ text: "My preferred roles include Software Engineering Intern.", kind: "fact", factIds: ["profile-preference:titles"] }, { text: "Small experiments can help evaluate technical tradeoffs.", kind: "perspective", factIds: [] }]); simulateObservedEssay("Why are you interested in this role?");
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  expect(fixture.state!.applications[0].status).toBe("submitted"); expect(fixture.state!.applications[0].packet!.answers[0].answer).toContain("My preferred roles include Software Engineering Intern.");
});
it("omits an optional blank essay and submits the known résumé fields", async () => {
  const prepare = fixture.prepare.getMockImplementation()!; fixture.prepare.mockImplementation(async (...args) => { const result = await prepare(...args); result.form.fields.push({ label: "Describe a challenging project.", identifier: "optional-story", kind: "textarea", required: false, valid: true, value: "" }); return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); expect(fixture.state!.applications[0].status).toBe("submitted"); expect(fixture.state!.applications[0].packet!.answers).toEqual([]);
});
it.each(["revoked-fact", "paused", "failed-grounding"])("blocks automatic essay continuation after %s", async (mode) => {
  essayResponses(undefined, () => { if (mode === "revoked-fact") fixture.state!.profile.facts[0].verified = false; if (mode === "paused") fixture.state!.profile.automationAuthorization!.status = "paused"; });
  if (mode === "failed-grounding") { const parse = fixture.parse.getMockImplementation()!; fixture.parse.mockImplementation(async (input) => input.text.format.name === "essay_grounding_check" ? { id: "not-grounded", model: input.model, output_parsed: { grounded: false, unsupportedClaims: ["No supported personal event"] } } : parse(input)); }
  simulateObservedEssay(); await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await expect(progress()).rejects.toThrow(/grounded truthfully/);
  const app = fixture.state!.applications[0]; expect(app.status).toBe("needs_user_action"); expect(app.submissionAttemptedAt).toBeUndefined(); expect(fixture.submit).not.toHaveBeenCalled(); expect(app.packet!.answers).toEqual([]);
  if (mode !== "failed-grounding") expect(fixture.parse.mock.calls.some(([input]) => input.text.format.name === "essay_grounding_check")).toBe(false);
});
it("cancels while essay generation is deferred, without grounding or writing the returned answer", async () => {
  let generated!: () => void; const started = new Promise<void>((resolve) => { generated = resolve; }); let release!: () => void; const deferred = new Promise<void>((resolve) => { release = resolve; });
  essayResponses(); const parse = fixture.parse.getMockImplementation()!; fixture.parse.mockImplementation(async (input) => { if (input.text.format.name === "application_essay") { generated(); await deferred; } return parse(input); });
  simulateObservedEssay(); await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); const filling = step(); await started;
  expect((await action("cancel", { applicationId: fixture.state!.applications[0].id })).status).toBe(200); release(); await expect(filling).rejects.toThrow(/grounded truthfully/);
  expect(fixture.state!.applications[0].status).toBe("cancelled"); expect(fixture.state!.applications[0].packet!.answers).toEqual([]); expect(fixture.submit).not.toHaveBeenCalled(); expect(fixture.parse.mock.calls.some(([input]) => input.text.format.name === "essay_grounding_check")).toBe(false);
});
it("replays a completed essay worker without another browser, answer generation or click", async () => {
  essayResponses(); simulateObservedEssay(); await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await step(); const filling = await step(); await progress(); const calls = fixture.parse.mock.calls.length;
  expect(await runFill(filling.payload)).toEqual({ skipped: true }); expect(fixture.parse).toHaveBeenCalledTimes(calls); expect(fixture.prepare).toHaveBeenCalledTimes(1); expect(fixture.submit).toHaveBeenCalledTimes(1);
});
it("blocks a changed observed essay control before the durable submit claim", async () => {
  essayResponses(); simulateObservedEssay(); const prepare = fixture.prepare.getMockImplementation()!; fixture.prepare.mockImplementation(async (...args) => { const result = await prepare(...args); result.form.fields.at(-1).identifier = "different-question"; return result; });
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress(); expect(fixture.state!.applications[0].status).toBe("needs_user_action"); expect(fixture.submit).not.toHaveBeenCalled(); expect(fixture.state!.applications[0].submissionAttemptedAt).toBeUndefined();
});
it.each([["essay-generation", "pause"], ["essay-grounding", "pause"], ["essay-generation", "revoke"], ["essay-grounding", "revoke"]])("rechecks %s authorization after ledger start during %s before calling its provider", async (operation, change) => {
  essayResponses(); simulateObservedEssay(); fixture.beforeUsageStart = async (started) => {
    if (started !== operation) return; fixture.beforeUsageStart = undefined;
    if (change === "pause") expect((await action("pauseAutomation", {})).status).toBe(200);
    else fixture.state!.profile.facts[0].verified = false;
  };
  await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await expect(progress()).rejects.toThrow(/grounded truthfully|authorization|settings/);
  const format = operation === "essay-generation" ? "application_essay" : "essay_grounding_check";
  expect(fixture.parse.mock.calls.filter(([input]) => input.text.format.name === format)).toHaveLength(0); expect(fixture.submit).not.toHaveBeenCalled();
});
it.each(["Why us?", "Why this company?", "Why this role?"])("answers the clear motivation prompt %s automatically", async (question) => {
  essayResponses(); simulateObservedEssay(question); await action("startAutonomous", { jobId: fixture.state!.jobs[0].id }); await progress();
  expect(fixture.state!.applications[0].status).toBe("submitted"); expect(fixture.state!.applications[0].packet!.answers[0].question).toBe(question); expect(fixture.state!.applications[0].approvals).toEqual([]);
});
it("renders an essay-only owned receiver and accepts only the exact authorized essay once", async () => {
  vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-controlled-signer"); const state = fixture.state!; state.profile.id = "00000000-0000-4000-8000-000000000002"; state.profile.email = "cloud-submit-00000000-0000-4000-8000-000000000001@example.com"; activateAutomation(state.profile, "synthetic receiver");
  await action("startAutonomous", { jobId: state.jobs[0].id }); const app = state.applications[0];
  const issued = (await import("@/lib/controlled-tests")).issueControlledTestGrant(state.profile.id, app.id); const url = `https://apply.example/api/internal/controlled-form?token=${issued.token}`;
  state.jobs[0].url = state.jobs[0].applyUrl = url; app.jobSnapshot = structuredClone(state.jobs[0]); app.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0, essayOnly: true };
  (await import("@/lib/autonomous-policy")).authorizeKnownAnswerApplication(app, state.profile, state.jobs[0]);
  const receiver = await import("@/app/api/internal/controlled-form/route"); const rendered = await (await receiver.GET(new Request(url))).text(); expect(rendered).toContain("Why this role?"); expect(rendered).not.toContain("Favorite snack");
  const prepare = fixture.prepare.getMockImplementation()!; fixture.prepare.mockImplementation(async (...args) => { const result = await prepare(...args); result.form.fields.push({ label: "First name", identifier: "firstName", kind: "text", value: state.profile.name.split(" ")[0], required: true, valid: true }, { label: "Last name", identifier: "lastName", kind: "text", value: state.profile.name.split(" ").slice(1).join(" "), required: true, valid: true }, { label: "Email", identifier: "email", kind: "email", value: state.profile.email, required: true, valid: true }); return result; });
  essayResponses(); simulateObservedEssay("Why this role?", undefined, "why");
  fixture.submit.mockImplementation(async (current: Application, options: { beforeAttempt: (baseline: NonNullable<Application["submissionVerification"]>) => Promise<boolean> }) => {
    const baseline = { version: 1 as const, kind: "captcha" as const, sessionId: current.browserSessionId!, targetUrl: current.form!.url, attemptedAt: new Date().toISOString(), beforeHash: "controlled", beforeHadConfirmation: false };
    expect(await options.beforeAttempt(baseline)).toBe(true);
    const file = await (await import("@/lib/packet-files")).reviewedPacketFile(state.profile, current.packet!, "resume");
    const body = (essay: string) => { const data = new FormData(); data.set("resume", new File([new Uint8Array(file.bytes)], file.filename, { type: file.mimeType })); for (const id of ["firstName", "lastName", "email"]) data.set(id, current.form!.fields.find((field) => field.identifier === id)!.value); data.set("why", essay); return data; };
    // Fixture uses the receiver's exact named control, independent of display text.
    const answer = current.packet!.answers[0].answer;
    expect((await receiver.POST(new Request(url, { method: "POST", headers: { Origin: "https://apply.example" }, body: body("Different essay") }))).status).toBe(409);
    expect((await receiver.POST(new Request(url, { method: "POST", headers: { Origin: "https://apply.example" }, body: body(answer) }))).status).toBe(200);
    expect((await receiver.POST(new Request(url, { method: "POST", headers: { Origin: "https://apply.example" }, body: body(answer) }))).status).toBe(409);
    return { confirmed: true, evidence: "Application received", receipt: { version: 1, url, text: "Application received", capturedAt: new Date().toISOString() } };
  });
  await progress(); expect(state.applications[0].status).toBe("submitted"); expect(state.applications[0].controlledTest!.submissions).toBe(1);
});
it("renders a factual-only receiver and accepts the exact known fields once", async () => {
  vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-controlled-signer");
  const state = fixture.state!;
  state.profile.id = "00000000-0000-4000-8000-000000000002";
  state.profile.email = "cloud-submit-00000000-0000-4000-8000-000000000001@example.com";
  const { selectApplication, setPacket, approveFill, setFormSnapshot, approveSubmit, transition } = await import("@/lib/workflow");
  const { packetProfileHash } = await import("@/lib/drafting");
  const { withPacketFiles } = await import("@/lib/packet-files");
  const { issueControlledTestGrant } = await import("@/lib/controlled-tests");
  const job = { ...state.jobs[0], url: "https://apply.example/api/internal/controlled-form", applyUrl: "https://apply.example/api/internal/controlled-form" };
  state.jobs = [job];
  const app = selectApplication(state, job.id, state.profile.id);
  const issued = issueControlledTestGrant(state.profile.id, app.id);
  const url = `${job.applyUrl}?token=${issued.token}`;
  job.url = job.applyUrl = url;
  app.jobSnapshot = structuredClone(job);
  app.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0, factualOnly: true };
  const fact = state.profile.facts.find(item => item.verified)!;
  const packet = await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, summary: "Synthetic factual receiver test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], createdAt: new Date().toISOString(), model: "controlled-fixture", profileHash: packetProfileHash(state.profile) });
  setPacket(state, app, packet);
  approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
  const resumeHash = createHash("sha256").update("controlled-resume").digest("hex");
  setFormSnapshot(app, { version: 1, url, fields: [
    { identifier: "resume", label: "Resume", kind: "file", value: "controlled-resume.pdf", required: true, valid: true, fileHashes: [`controlled-resume.pdf:17:${resumeHash}`] },
    { identifier: "firstName", label: "First name", kind: "text", value: "Synthetic", required: true, valid: true },
    { identifier: "lastName", label: "Last name", kind: "text", value: "Applicant", required: true, valid: true },
    { identifier: "email", label: "Email", kind: "email", value: state.profile.email, required: true, valid: true },
    { identifier: "sponsorship", label: "Will you now or in the future require visa sponsorship?", kind: "radio", value: "No", checked: true, required: true, valid: true },
    { identifier: "snack", label: "Favorite snack", kind: "select", value: "Chips", options: ["Chips", "Fruit"], required: true, valid: true },
  ], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: true, blockers: [], submitControl: { label: "Submit application", identifier: "submit", action: url, method: "post" } });
  approveSubmit(app, state.profile.id, app.form!.hash);
  transition(app, ["approved_to_submit"], "submitting");
  app.submissionWorkerClaimedAt = new Date().toISOString();
  const receiver = await import("@/app/api/internal/controlled-form/route");
  const rendered = await (await receiver.GET(new Request(url))).text();
  expect(rendered).toContain("Will you now or in the future require visa sponsorship?");
  expect(rendered).toContain("Favorite snack");
  expect(rendered).not.toContain("Why are you excited to join us?");
  const body = (snack: string) => {
    const data = new FormData();
    data.set("resume", new File(["controlled-resume"], "controlled-resume.pdf", { type: "application/pdf" }));
    data.set("firstName", "Synthetic"); data.set("lastName", "Applicant"); data.set("email", state.profile.email);
    data.set("sponsorship", "No"); data.set("snack", snack);
    return data;
  };
  expect((await receiver.POST(new Request(url, { method: "POST", headers: { Origin: "https://apply.example" }, body: body("Fruit") }))).status).toBe(409);
  expect((await receiver.POST(new Request(url, { method: "POST", headers: { Origin: "https://apply.example" }, body: body("Chips") }))).status).toBe(200);
  expect((await receiver.POST(new Request(url, { method: "POST", headers: { Origin: "https://apply.example" }, body: body("Chips") }))).status).toBe(409);
  expect(state.applications[0].controlledTest!.submissions).toBe(1);
});
it("runs the imported posting check and queues the same application when the public action is reachable", async () => {
  const state = fixture.state!;
  const job = {
    ...state.jobs[0],
    id: "imported-route-job",
    source: "imported" as const,
    sourceId: "route-import",
    sourceLabel: "Imported link",
    url: "https://employer.example/jobs/1",
    applyUrl: "https://employer.example/jobs/1/apply",
    importUrl: "https://employer.example/jobs/1",
    importCheck: { status: "manual" as const, checkedAt: new Date().toISOString() },
  };
  state.jobs = [job];
  fixture.preflight.mockImplementation(async (_application: Application, _job: unknown, onSession: (session: { sessionId: string; provider: "browser-use" }) => Promise<boolean>) => {
    expect(await onSession({ sessionId: "route-preflight", provider: "browser-use" })).toBe(true);
    return {
      form: { version: 1 as const, url: job.applyUrl, fields: [{ label: "Email", value: "", identifier: "email", kind: "email", required: true, valid: false }], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: false, blockers: ["Correct or complete the field: Email"], submitControl: { label: "Submit", identifier: "submit", action: `${job.applyUrl}/submit`, method: "post" } },
      contextHash: "route-context",
      postingContext: { title: job.title, company: job.company, text: `${job.title} at ${job.company}` },
      postingEvidence: { postingUrl: job.url, postingIdentityHash: "route-posting-identity", title: job.title, company: job.company, markers: [job.title, job.company], identityHash: "route-identity" },
      sessionId: "route-preflight",
      provider: "browser-use" as const,
    };
  });
  const response = await action("preflightImportedPosting", { jobId: job.id });
  expect(response.status).toBe(200);
  const app = state.applications.find((item) => item.jobId === job.id)!;
  expect(app.importedCompatibility?.status).toBe("reachable");
  expect(app.autonomousAuthorization).toBeDefined();
  expect(app.status).toBe("drafting");
  expect(fixture.pending.some((item) => item.task === "draft-application-packet" && item.payload.applicationId === app.id)).toBe(true);
});
