import { z } from "zod";
import { hashJson } from "@/lib/crypto";
import { importedPosting } from "@/lib/import-jobs";
import { canonicalJobUrl } from "@/lib/sources";
import { answerNeedsAction } from "@/lib/answer-responsibility";
import { profileLinkAnswers, profileLinkQuestion } from "@/lib/profile-links";
import { reviewedPacketFile } from "@/lib/packet-files";
import { bytesHash } from "@/lib/resume-artifacts";
import { formDigest } from "@/lib/workflow";
import type { ApiSubmissionPlan, Application, FormSnapshot, Job, Profile } from "@/lib/types";

const optionSchema = z.object({ label: z.string().min(1), value: z.union([z.string(), z.number()]).transform(String) });
const fieldSchema = z.object({ name: z.string().min(1).max(200), label: z.string().min(1).max(500),
  kind: z.enum(["text", "email", "tel", "url", "textarea", "number", "date", "select", "boolean", "file"]),
  required: z.boolean(), options: z.array(optionSchema).optional() }).strict();
type Field = z.infer<typeof fieldSchema>;
// Lever does not publish a complete application schema. An employer must attest
// the complete form for this exact posting, including the absence of custom questions.
const leverFormSchema = z.object({ revision: z.string().min(1), customQuestionsAbsent: z.literal(true),
  fields: z.array(fieldSchema).min(2) }).strict();
const integrationSchema = z.object({ provider: z.enum(["greenhouse", "lever", "ashby"]),
  board: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), apiKey: z.string().min(1),
  region: z.enum(["global", "eu"]).optional(),
  leverForms: z.record(z.string(), leverFormSchema).optional() }).strict().refine((item) => item.region === undefined || item.provider === "lever");
type Integration = z.infer<typeof integrationSchema>;
type Posting = { provider: ApiSubmissionPlan["provider"]; board: string; postingId: string; region?: "eu" };
type Definition = { fields: Field[]; hash: string };
export type ApiPreparation = { kind: "browser"; reason: string } | { kind: "api"; form: Omit<FormSnapshot, "hash"> };
export type ApiSubmissionResult = { confirmed: boolean; evidence: string;
  receipt: NonNullable<Application["submissionReceipt"]>; verification?: never };

export class ApiPreparationError extends Error {}

function integrations(): Integration[] {
  try {
    const parsed = z.array(integrationSchema).max(100).parse(JSON.parse(process.env.ATS_SUBMISSION_INTEGRATIONS || "[]"));
    if (new Set(parsed.map((item) => `${item.provider}:${item.board}:${item.region ?? "global"}`)).size !== parsed.length) return [];
    return parsed;
  } catch { return []; }
}

function postingFor(job: Job): Posting | undefined {
  try {
    const posting = importedPosting(job.importUrl ?? job.url);
    if (posting) return { provider: posting.board.source, board: posting.board.slug, postingId: posting.sourceId, ...(posting.board.region === "eu" ? { region: "eu" as const } : {}) };
    const [provider, board, postingId] = job.id.split(":");
    if (["greenhouse", "lever", "ashby"].includes(provider) && job.source === provider && job.sourceId === postingId &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(board) && /^[a-zA-Z0-9_-]{1,100}$/.test(postingId))
      return { provider: job.source, board, postingId } as Posting;
  } catch { /* Unsupported URLs use the browser policy. */ }
}

function integrationFor(posting: Posting): Integration | undefined {
  return integrations().find((item) => item.provider === posting.provider && item.board === posting.board &&
    (item.region ?? "global") === (posting.region ?? "global"));
}
function integrationHash(integration: Integration): string {
  // Persist only this one-way digest; rotation changes the reviewed request.
  return hashJson(integration);
}
function endpointFor(posting: Posting): string {
  const board = encodeURIComponent(posting.board), id = encodeURIComponent(posting.postingId);
  return posting.provider === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`
    : posting.provider === "lever" ? `https://${posting.region === "eu" ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${board}/${id}`
    : "https://api.ashbyhq.com/applicationForm.submit";
}
function authorization(integration: Integration): string {
  return `Basic ${Buffer.from(`${integration.apiKey}:`).toString("base64")}`;
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ApiPreparationError(`Application API is unavailable (${response.status}).`);
    return await response.json();
  } catch { throw new ApiPreparationError("The application API could not be verified. Use the employer form."); }
}

const sensitiveControl = /consent|privacy|terms|demographic|gender|ethnic|disab|veteran|race\b/i;
function assertFields(fields: Field[]): void {
  if (!fields.length || new Set(fields.map((field) => field.name)).size !== fields.length ||
    fields.some((field) => sensitiveControl.test(field.label) || (field.kind === "select" &&
      (!field.options?.length || new Set(field.options.map((option) => option.label)).size !== field.options.length ||
        new Set(field.options.map((option) => option.value)).size !== field.options.length))))
    throw new ApiPreparationError("This application requires the employer's browser form.");
}

async function greenhouseDefinition(posting: Posting, job: Job): Promise<Definition> {
  const question = z.object({ label: z.string().min(1), required: z.boolean(), fields: z.array(z.object({
    name: z.string().min(1), type: z.string(), values: z.array(optionSchema).optional() })).min(1) });
  const data = z.object({ id: z.union([z.string(), z.number()]).transform(String), absolute_url: z.string(),
    questions: z.array(question).min(1), location_questions: z.array(question).optional(),
    compliance: z.array(question).optional(), data_compliance: z.array(z.object({
      requires_consent: z.boolean().optional(), requires_processing_consent: z.boolean().optional(), requires_retention_consent: z.boolean().optional(),
    })).optional(), demographic_questions: z.unknown().optional() }).parse(await readJson(`${endpointFor(posting)}?questions=true`));
  if (data.id !== posting.postingId || canonicalJobUrl(data.absolute_url) !== canonicalJobUrl(job.url) ||
    data.compliance?.length || data.demographic_questions || data.data_compliance?.some((rule) =>
      rule.requires_consent || rule.requires_processing_consent || rule.requires_retention_consent))
    throw new ApiPreparationError("This Greenhouse form requires browser review.");
  const kinds: Record<string, Field["kind"]> = { input_text: "text", textarea: "textarea", input_file: "file", multi_value_single_select: "select" };
  const fields = [...data.questions, ...data.location_questions ?? []].map((item): Field => {
    const file = item.fields.find((field) => field.type === "input_file");
    const field = file ?? (item.fields.length === 1 ? item.fields[0] : undefined);
    if (!field || !kinds[field.type]) throw new ApiPreparationError("An application control requires browser review.");
    return { name: field.name, label: item.label, kind: kinds[field.type], required: item.required, options: field.values };
  });
  assertFields(fields);
  return { fields, hash: hashJson(data) };
}

async function ashbyDefinition(posting: Posting, job: Job, integration: Integration): Promise<Definition> {
  const entry = z.object({ isRequired: z.boolean(), field: z.object({ path: z.string().min(1), title: z.string().min(1),
    type: z.string(), selectableValues: z.array(optionSchema).nullish() }).passthrough(), visibilityCondition: z.unknown().optional() }).passthrough();
  const definition = z.object({ fields: z.array(entry).optional(), sections: z.array(z.object({ fields: z.array(entry) })).optional() }).passthrough();
  const data = z.object({ success: z.literal(true), results: z.object({ id: z.string(), status: z.literal("Published"),
    externalLink: z.string(), applicationFormDefinition: definition, surveyFormDefinitions: z.array(z.unknown()).optional(),
  }).passthrough() }).parse(await readJson("https://api.ashbyhq.com/jobPosting.info", {
    method: "POST", headers: { Authorization: authorization(integration), "Content-Type": "application/json" },
    body: JSON.stringify({ jobPostingId: posting.postingId, includeUnpublishedJobPostings: false }),
  }));
  if (data.results.id !== posting.postingId || canonicalJobUrl(data.results.externalLink) !== canonicalJobUrl(job.importUrl ?? job.url) ||
    data.results.surveyFormDefinitions?.length) throw new ApiPreparationError("This Ashby form requires browser review.");
  const form = data.results.applicationFormDefinition;
  const entries = form.sections?.flatMap((section) => section.fields) ?? form.fields ?? [];
  const kinds: Record<string, Field["kind"]> = { String: "text", Email: "email", Phone: "tel", SocialLink: "url",
    LongText: "textarea", Number: "number", Date: "date", Boolean: "boolean", ValueSelect: "select", File: "file" };
  const fields = entries.map(({ isRequired, field, visibilityCondition }): Field => {
    if (!kinds[field.type] || visibilityCondition != null || Object.keys(field).some((key) => /condition|depend/i.test(key) && field[key] != null))
      throw new ApiPreparationError("An application control requires browser review.");
    return { name: field.path, label: field.title, kind: kinds[field.type], required: isRequired, options: field.selectableValues ?? undefined };
  });
  assertFields(fields);
  return { fields, hash: hashJson(data.results) };
}

async function leverDefinition(posting: Posting, job: Job, integration: Integration): Promise<Definition> {
  const form = integration.leverForms?.[posting.postingId];
  if (!form) throw new ApiPreparationError("Lever needs an employer-verified form definition for this posting.");
  const supported = /^(name|email|phone|resume|org|comments|urls\[(GitHub|LinkedIn|Portfolio|Website)\])$/;
  if (!form.fields.some((field) => field.name === "name" && field.required && field.kind === "text") ||
    !form.fields.some((field) => field.name === "email" && field.required && field.kind === "email") ||
    form.fields.some((field) => !supported.test(field.name) || (field.name === "resume" ? field.kind !== "file" :
      ["file", "boolean", "select", "number", "date"].includes(field.kind))))
    throw new ApiPreparationError("Lever's application schema is unsupported.");
  const data = z.object({ id: z.string(), hostedUrl: z.string() }).parse(await readJson(`${endpointFor(posting)}?mode=json`));
  if (data.id !== posting.postingId || canonicalJobUrl(data.hostedUrl) !== canonicalJobUrl(job.importUrl ?? job.url))
    throw new ApiPreparationError("The Lever posting changed.");
  assertFields(form.fields);
  return { fields: form.fields, hash: hashJson({ form, posting: data }) };
}

function fileKind(field: Field): "resume" | "cover-letter" | undefined {
  if (/^(resume|_systemfield_resume)$/.test(field.name)) return "resume";
  if (/^(cover_letter|_systemfield_cover_letter)$/.test(field.name)) return "cover-letter";
}
function fieldValue(field: Field, application: Application, profile: Profile): string {
  const matches = application.packet!.answers.filter((answer) =>
    answer.question.trim().toLowerCase() === field.label.trim().toLowerCase());
  if (matches.length === 1 && (!answerNeedsAction(matches[0]) || Boolean(application.autonomousAuthorization && matches[0].autonomousEssayAuthorization)))
    return matches[0].answer.trim();
  // Only explicit contact fields are reusable without an exact question match.
  const name = profile.name.trim().split(/\s+/);
  const contact: Record<string, string> = { first_name: name[0] ?? "", last_name: name.slice(1).join(" "),
    name: profile.name, _systemfield_name: profile.name, email: profile.email, _systemfield_email: profile.email,
    phone: profile.phone, _systemfield_phone: profile.phone };
  const link = profileLinkQuestion(field.label);
  return contact[field.name] ?? (link ? profileLinkAnswers(profile)[link] : undefined) ?? "";
}

/** Read/prepare only: never uploads files, creates an application, or allocates a browser. */
export async function prepareApiApplication(application: Application, job: Job, profile: Profile): Promise<ApiPreparation> {
  const posting = postingFor(job);
  if (!posting) return { kind: "browser", reason: "This employer has no configured direct application API." };
  const integration = integrationFor(posting);
  if (!integration) return { kind: "browser", reason: "No employer-issued submission credentials are configured." };
  if (!job.active || !application.packet || !application.packetHash || hashJson(application.packet) !== application.packetHash ||
    !application.packet.files?.length || application.submissionAttemptedAt || application.browserSessionId)
    return { kind: "browser", reason: "The current application cannot be prepared through its API." };
  try {
    const definition = posting.provider === "greenhouse" ? await greenhouseDefinition(posting, job)
      : posting.provider === "ashby" ? await ashbyDefinition(posting, job, integration) : await leverDefinition(posting, job, integration);
    const plan: ApiSubmissionPlan = { version: 1, ...posting, endpoint: endpointFor(posting), definitionHash: definition.hash,
      integrationHash: integrationHash(integration), packetHash: application.packetHash, values: {}, files: {} };
    const fields: FormSnapshot["fields"] = [];
    for (const field of definition.fields) {
      if (field.kind === "file") {
        const kind = fileKind(field);
        const file = application.packet.files.find((item) => item.kind === kind);
        if (!kind || (field.required && !file)) throw new ApiPreparationError("An attachment requires employer-form review.");
        if (file) plan.files[field.name] = kind;
        fields.push({ identifier: field.name, label: field.label, kind: "file", required: field.required, editable: false,
          value: file?.filename ?? "", valid: !field.required || Boolean(file),
          ...(file ? { fileHashes: [`${file.filename}:${file.size}:${file.sha256}`] } : {}) });
        continue;
      }
      let value = fieldValue(field, application, profile);
      if (!value && field.required) throw new ApiPreparationError("A required answer needs employer-form review.");
      let submitted: string | number | boolean = value;
      if (value && field.kind === "select") {
        const options = field.options!.filter((option) => option.label.toLowerCase() === value.toLowerCase());
        if (options.length !== 1) throw new ApiPreparationError("A select answer needs employer-form review.");
        submitted = options[0].value; value = options[0].label;
      } else if (value && field.kind === "number") {
        if (!/^-?\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new ApiPreparationError("Invalid numeric answer.");
        submitted = Number(value);
      } else if (value && field.kind === "boolean") {
        if (!/^(yes|no|true|false)$/i.test(value)) throw new ApiPreparationError("Invalid yes/no answer.");
        submitted = /^(yes|true)$/i.test(value);
      }
      if (value) plan.values[field.name] = submitted;
      fields.push({ identifier: field.name, label: field.label, kind: field.kind === "boolean" ? "yesno" : field.kind,
        required: field.required, editable: false, value, valid: true, options: field.options?.map((option) => option.label) });
    }
    if (application.packet.files.some((file) => !Object.values(plan.files).includes(file.kind)))
      throw new ApiPreparationError("The API cannot carry all reviewed attachments.");
    return { kind: "api", form: { version: 1, url: job.applyUrl, fields, apiSubmission: plan,
      attachments: [...new Set(fields.flatMap((field) => field.fileHashes ?? []))], capturedAt: new Date().toISOString(),
      readyToSubmit: true, blockers: [], submitControl: { label: "Submit application", identifier: "ats-api",
        action: job.applyUrl, method: "POST", encoding: "multipart/form-data" } } };
  } catch { return { kind: "browser", reason: "The employer API cannot represent and verify this complete application form." }; }
}

/** Re-verify the schema and request, validate exact bytes, claim durably, then send one POST. */
export async function submitApiApplication(application: Application, job: Job, profile: Profile,
  beforeAttempt: (attemptedAt: string) => Promise<boolean>): Promise<ApiSubmissionResult> {
  const saved = application.form;
  const plan = saved?.apiSubmission;
  if (!saved || !plan || saved.hash !== formDigest(saved) || saved.readyToSubmit !== true || application.submissionAttemptedAt)
    throw new ApiPreparationError("The API application changed or was already attempted.");
  const prepared = await prepareApiApplication(application, job, profile);
  if (prepared.kind !== "api" || formDigest(prepared.form) !== saved.hash)
    throw new ApiPreparationError("The employer API form, credentials, answers, or files changed. Prepare and review the application again.");
  const integration = integrationFor(plan);
  if (!integration || integrationHash(integration) !== plan.integrationHash || plan.endpoint !== endpointFor(plan)) throw new ApiPreparationError("The employer integration changed.");
  const body = new FormData();
  for (const [name, value] of Object.entries(plan.values)) if (plan.provider !== "ashby") body.append(name, String(value));
  const submissions = Object.entries(plan.values).map(([path, value]) => ({ path, value }));
  for (const [name, kind] of Object.entries(plan.files)) {
    const expected = application.packet!.files!.find((file) => file.kind === kind)!;
    let file: Awaited<ReturnType<typeof reviewedPacketFile>>;
    try { file = await reviewedPacketFile(profile, application.packet!, kind); }
    catch { throw new ApiPreparationError("The reviewed attachment is unavailable or changed. No submission was attempted."); }
    if (file.filename !== expected.filename || file.mimeType !== expected.mimeType || file.bytes.length !== expected.size || bytesHash(file.bytes) !== expected.sha256)
      throw new ApiPreparationError("The reviewed attachment bytes changed. No submission was attempted.");
    body.append(name, new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.filename);
    if (plan.provider === "ashby") submissions.push({ path: name, value: name });
  }
  if (plan.provider === "ashby") {
    body.append("jobPostingId", plan.postingId);
    body.append("applicationForm", JSON.stringify({ fieldSubmissions: submissions }));
    body.append("allowSubmissionForUnpublishedJobPosting", "false");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const url = new URL(plan.endpoint);
  if (plan.provider === "lever") url.searchParams.set("key", integration.apiKey);
  else headers.Authorization = authorization(integration);
  const attemptedAt = new Date().toISOString();
  if (!await beforeAttempt(attemptedAt)) throw new ApiPreparationError("The application authorization changed before submission.");
  application.submissionAttemptedAt = attemptedAt;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  } catch {
    return result(false, "The employer API result is unknown. Check the employer receipt; no browser fallback or retry was made.", saved.url);
  }
  // A received error is recorded too. We never automatically retry or switch
  // transports after a consequential request, even for rate-limit responses.
  if (!response.ok) return result(false, `The employer API returned HTTP ${response.status}. No second submission was made.`, saved.url);
  let data: unknown;
  try { data = await response.json(); } catch { return result(false, "The employer API returned an unreadable receipt. No second submission was made.", saved.url); }
  if (plan.provider === "lever") {
    const parsed = z.object({ ok: z.literal(true), applicationId: z.string().min(1).max(200) }).safeParse(data);
    return parsed.success ? result(true, `Lever accepted the application. Receipt: ${parsed.data.applicationId}`, saved.url)
      : result(false, "Lever did not return a confirmed application receipt. No second submission was made.", saved.url);
  }
  if (plan.provider === "ashby") {
    const parsed = z.object({ success: z.literal(true), results: z.object({ formMessages: z.object({ blocked: z.literal(false) }),
      submittedFormInstance: z.object({ id: z.string().min(1).max(200) }) }) }).safeParse(data);
    return parsed.success ? result(true, `Ashby accepted the application form. Receipt: ${parsed.data.results.submittedFormInstance.id}`, saved.url)
      : result(false, "Ashby did not return an unblocked application receipt. No second submission was made.", saved.url);
  }
  // Greenhouse's Job Board endpoint acknowledges acceptance with HTTP 200;
  // unlike Harvest it does not return a candidate/application identifier.
  const accepted = z.object({ success: z.boolean().optional(), error: z.unknown().optional(), errors: z.unknown().optional() }).safeParse(data);
  return response.status === 200 && accepted.success && accepted.data.success !== false && !accepted.data.error && !accepted.data.errors
    ? result(true, "Greenhouse accepted the application through its Job Board API.", saved.url)
    : result(false, "Greenhouse did not return a confirmed application receipt. No second submission was made.", saved.url);
}

function result(confirmed: boolean, evidence: string, url: string): ApiSubmissionResult {
  return { confirmed, evidence, receipt: { version: 1, url, text: evidence, capturedAt: new Date().toISOString() } };
}
