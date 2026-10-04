import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { draftPacket } from "@/lib/drafting";
import { hashJson } from "@/lib/crypto";
import { prepareApiApplication, submitApiApplication } from "@/lib/ats-application";
import { formDigest, selectApplication, setPacket } from "@/lib/workflow";
import type { AppState, Application, Job } from "@/lib/types";

let state: AppState, app: Application, job: Job;
const ashbyId = "e9ed20fd-d45f-4aad-8a00-a19bfba0083e";
const ashbyFields = [
  { isRequired: true, field: { path: "_systemfield_name", title: "Name", type: "String", selectableValues: null } },
  { isRequired: true, field: { path: "_systemfield_email", title: "Email", type: "Email", selectableValues: null } },
  { isRequired: true, field: { path: "_systemfield_resume", title: "Resume", type: "File", selectableValues: null } },
  { isRequired: false, field: { path: "_systemfield_cover_letter", title: "Cover letter", type: "File", selectableValues: null } },
];
const ashbyPosting = () => ({ success: true, results: { id: ashbyId, status: "Published", externalLink: job.url,
  applicationFormDefinition: { sections: [{ fields: ashbyFields }] }, surveyFormDefinitions: [] } });
const ashbyReceipt = { success: true, results: { submittedFormInstance: { id: "receipt-123" }, formMessages: { blocked: false } } };
const greenhousePosting = () => ({ id: 12345, absolute_url: job.url, questions: [
  { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
  { label: "Last Name", required: true, fields: [{ name: "last_name", type: "input_text" }] },
  { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
  { label: "Resume", required: true, fields: [{ name: "resume", type: "input_file" }] },
  { label: "Cover letter", required: false, fields: [{ name: "cover_letter", type: "input_file" }] },
] });
function configure(provider: "greenhouse" | "lever" | "ashby", extra = {}) {
  const id = provider === "ashby" ? ashbyId : "12345";
  const host = provider === "greenhouse" ? "job-boards.greenhouse.io" : provider === "lever" ? "jobs.lever.co" : "jobs.ashbyhq.com";
  const url = `https://${host}/example/${provider === "greenhouse" ? "jobs/" : ""}${id}`;
  job = { ...state.jobs[0], id: `${provider}:example:${id}`, source: provider, sourceId: id, url, applyUrl: url };
  state.jobs[0] = job; app.jobId = job.id; app.jobSnapshot = job;
  vi.stubEnv("ATS_SUBMISSION_INTEGRATIONS", JSON.stringify([{ provider, board: "example", apiKey: "private-test-key", ...extra }]));
}
async function review() {
  const prepared = await prepareApiApplication(app, job, state.profile);
  if (prepared.kind !== "api") throw new Error(`Expected direct API preparation: ${prepared.reason}`);
  app.form = { ...prepared.form, hash: formDigest(prepared.form) };
  return app.form;
}
beforeEach(async () => {
  vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("OPENAI_API_KEY", "");
  state = initialDemoState(); app = selectApplication(state, state.jobs[0].id, state.profile.id);
  const packet = await draftPacket(state.profile, state.jobs[0]); packet.answers = [];
  setPacket(state, app, packet);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("uses Ashby's documented form paths, multipart files, credentials, and unblocked receipt", async () => {
  configure("ashby"); let submitted: FormData | undefined;
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/api.ashbyhq.com\//);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("private-test-key:").toString("base64")}`);
    if (init?.body instanceof FormData) { submitted = init.body; return Response.json(ashbyReceipt); }
    expect(JSON.parse(String(init?.body)).jobPostingId).toBe(ashbyId);
    return Response.json(ashbyPosting());
  });
  vi.stubGlobal("fetch", fetcher);
  const form = await review();
  expect(JSON.stringify(form)).not.toContain("private-test-key");
  expect((await submitApiApplication(app, job, state.profile, async () => true)).confirmed).toBe(true);
  expect(submitted?.get("jobPostingId")).toBe(ashbyId);
  expect(submitted?.get("allowSubmissionForUnpublishedJobPosting")).toBe("false");
  expect(JSON.parse(String(submitted?.get("applicationForm"))).fieldSubmissions).toContainEqual({ path: "_systemfield_resume", value: "_systemfield_resume" });
  expect(submitted?.get("_systemfield_resume")).toBeInstanceOf(Blob);
});

it("uses an employer-attested Lever form and requires an application identifier", async () => {
  app.packet!.coverLetter = ""; app.packet!.files = app.packet!.files!.filter((file) => file.kind === "resume");
  app.packetHash = hashJson(app.packet);
  configure("lever", { leverForms: { "12345": { revision: "employer-v1", customQuestionsAbsent: true, fields: [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "email", label: "Email", kind: "email", required: true },
    { name: "resume", label: "Resume", kind: "file", required: true },
  ] } } });
  let sent: FormData | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData) {
      expect(new URL(url).searchParams.get("key")).toBe("private-test-key");
      sent = init.body; return Response.json({ ok: true, applicationId: "lever-receipt" });
    }
    return Response.json({ id: "12345", hostedUrl: job.url });
  }));
  const form = await review();
  expect(form.apiSubmission?.endpoint).not.toContain("key=");
  const result = await submitApiApplication(app, job, state.profile, async () => true);
  expect(result.confirmed).toBe(true); expect(result.receipt.text).toContain("lever-receipt");
  expect(sent?.get("name")).toBe("Taylor Morgan"); expect(sent?.get("resume")).toBeInstanceOf(Blob);
});

it("does not guess Lever's hidden custom questions", async () => {
  configure("lever"); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect((await prepareApiApplication(app, job, state.profile)).kind).toBe("browser"); expect(fetcher).not.toHaveBeenCalled();
});

it("maps exact approved choice labels to the provider's native option value", async () => {
  configure("greenhouse"); app.packet!.answers = [{ question: "Requires sponsorship?", answer: "No", factIds: [], userProvided: true, requiresUserInput: false }];
  app.packetHash = hashJson(app.packet);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...greenhousePosting(), questions: [...greenhousePosting().questions,
    { label: "Requires sponsorship?", required: true, fields: [{ name: "question_55", type: "multi_value_single_select",
      values: [{ label: "Yes", value: 1 }, { label: "No", value: 0 }] }] }] })));
  const form = await review();
  expect(form.apiSubmission?.values.question_55).toBe("0");
  expect(form.fields.find((field) => field.identifier === "question_55")?.value).toBe("No");
});

it("uses the browser for required consent rather than inventing consent", async () => {
  configure("greenhouse"); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...greenhousePosting(),
    data_compliance: [{ requires_processing_consent: true }] })));
  expect((await prepareApiApplication(app, job, state.profile)).kind).toBe("browser");
});

it("reuses saved contact links only for their matching employer questions", async () => {
  configure("greenhouse");
  state.profile.links = ["https://www.linkedin.com/in/candidate", "https://github.com/candidate", "https://candidate.example.com/portfolio", "https://unrelated.example.com/project"];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...greenhousePosting(), questions: [...greenhousePosting().questions,
    ...["LinkedIn URL", "GitHub profile", "Portfolio URL", "Website"].map((label, index) => ({ label, required: false, fields: [{ name: `question_${index}`, type: "input_text" }] }))] })));
  const form = await review();
  expect(form.fields.slice(-4).map((field) => field.value)).toEqual(["https://www.linkedin.com/in/candidate", "https://github.com/candidate", "https://candidate.example.com/portfolio", ""]);
});

it("uses the browser for conditional Ashby fields", async () => {
  configure("ashby"); vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...ashbyPosting(), results: { ...ashbyPosting().results,
    applicationFormDefinition: { sections: [{ fields: [...ashbyFields, { ...ashbyFields[0],
      field: { path: "conditional-name", title: "Name", type: "String" }, visibilityCondition: { type: "unknown" } }] }] } } })));
  expect((await prepareApiApplication(app, job, state.profile)).kind).toBe("browser");
});

it("rejects an Ashby success envelope that says the application was blocked", async () => {
  configure("ashby"); vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => Response.json(
    init?.body instanceof FormData ? { ...ashbyReceipt, results: { ...ashbyReceipt.results, formMessages: { blocked: true } } } : ashbyPosting())));
  await review();
  expect((await submitApiApplication(app, job, state.profile, async () => true)).confirmed).toBe(false);
});

it("refuses endpoint tampering before sending applicant data", async () => {
  configure("greenhouse"); let sent = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { if (init?.body instanceof FormData) sent++; return Response.json(greenhousePosting()); }));
  await review(); app.form!.apiSubmission!.endpoint = "https://attacker.example/collect";
  app.form!.hash = formDigest(app.form!);
  await expect(submitApiApplication(app, job, state.profile, async () => true)).rejects.toThrow("changed"); expect(sent).toBe(0);
});

it("does not send when the durable authorization claim is refused", async () => {
  configure("greenhouse"); let sent = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => { if (init?.body instanceof FormData) sent++; return Response.json(greenhousePosting()); }));
  await review();
  await expect(submitApiApplication(app, job, state.profile, async () => false)).rejects.toThrow("authorization changed");
  expect(sent).toBe(0); expect(app.submissionAttemptedAt).toBeUndefined();
});

it("keeps Workday and unsupported employer links on the browser path", async () => {
  job = { ...state.jobs[0], source: "imported", url: "https://example.wd1.myworkdayjobs.com/en-US/jobs/job/Engineer_R123",
    applyUrl: "https://example.wd1.myworkdayjobs.com/en-US/jobs/job/Engineer_R123" };
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect((await prepareApiApplication(app, job, state.profile)).kind).toBe("browser"); expect(fetcher).not.toHaveBeenCalled();
});


it("requires fresh review after changing only the employer credential", async () => {
  configure("greenhouse"); let sent = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.body instanceof FormData) sent++;
    return Response.json(greenhousePosting());
  }));
  await review(); configure("greenhouse", { apiKey: "rotated-test-key" });
  await expect(submitApiApplication(app, job, state.profile, async () => true)).rejects.toThrow("changed");
  expect(sent).toBe(0); expect(app.submissionAttemptedAt).toBeUndefined();
});

it("uses only Lever's fixed EU host for an EU posting and matching integration", async () => {
  app.packet!.coverLetter = ""; app.packet!.files = app.packet!.files!.filter((file) => file.kind === "resume");
  app.packetHash = hashJson(app.packet);
  configure("lever", { region: "eu", leverForms: { "12345": { revision: "eu-v1", customQuestionsAbsent: true, fields: [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "email", label: "Email", kind: "email", required: true },
    { name: "resume", label: "Resume", kind: "file", required: true },
  ] } } });
  job.url = job.applyUrl = "https://jobs.eu.lever.co/example/12345/apply";
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(new URL(url).hostname).toBe("api.eu.lever.co");
    return Response.json(init?.body instanceof FormData ? { ok: true, applicationId: "eu-receipt" } : { id: "12345", hostedUrl: job.url });
  });
  vi.stubGlobal("fetch", fetcher);
  const form = await review();
  expect(form.apiSubmission?.endpoint).toBe("https://api.eu.lever.co/v0/postings/example/12345");
  expect((await submitApiApplication(app, job, state.profile, async () => true)).confirmed).toBe(true);
});
