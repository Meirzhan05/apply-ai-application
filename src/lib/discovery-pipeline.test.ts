import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { activateAutomation, saveOnboarding } from "@/lib/onboarding";
import type { AppState, Job } from "@/lib/types";
import { resumeGroundingOutput } from "@/lib/fixtures/resume-grounding";

type Row = { user_id: string; data: Partial<AppState>; revision: number };
const fixture = vi.hoisted(() => ({
  rows: [] as Row[],
  jobs: [] as Job[],
  calls: [] as Array<{ task: string; payload: Record<string, unknown> }>,
  files: new Map<string, Buffer>(),
  prepare: vi.fn(),
  submit: vi.fn(),
  admin: vi.fn(),
  trigger: vi.fn(),
}));

function matches(row: Row, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([key, value]) => row[key as keyof Row] === value);
}

function query(table: string) {
  let operation: "select" | "update" | "upsert" = "select";
  let fields = "";
  let patch: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};
  let inFilter: { key: string; values: unknown[] } | undefined;
  let greaterThan: { key: string; value: string } | undefined;
  let range: [number, number] | undefined;
  let limit: number | undefined;
  type QueryBuilder = {
    select(value: string): QueryBuilder;
    eq(key: string, value: unknown): QueryBuilder;
    in(key: string, values: unknown[]): QueryBuilder;
    gt(key: string, value: string): QueryBuilder;
    order(): QueryBuilder;
    limit(value: number): QueryBuilder;
    range(start: number, end: number): QueryBuilder;
    update(value: Record<string, unknown>): QueryBuilder;
    upsert(value: Record<string, unknown>[]): QueryBuilder;
    maybeSingle(): Promise<{ data: unknown; error: unknown }>;
    then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown): unknown;
  };
  const builder = {} as QueryBuilder;
  Object.assign(builder, {
    select(value: string) { fields = value; return builder; },
    eq(key: string, value: unknown) { filters[key] = value; return builder; },
    in(key: string, values: unknown[]) { inFilter = { key, values }; return builder; },
    gt(key: string, value: string) { greaterThan = { key, value }; return builder; },
    order() { return builder; },
    limit(value: number) { limit = value; return builder; },
    range(start: number, end: number) { range = [start, end]; return builder; },
    update(value: Record<string, unknown>) { operation = "update"; patch = value; return builder; },
    upsert(value: Record<string, unknown>[]) { operation = "upsert"; patch = { rows: value }; return builder; },
  });
  const execute = async () => {
    if (operation === "upsert") {
      for (const value of (patch.rows as Record<string, unknown>[])) {
        const existing = fixture.jobs.findIndex((job) => job.id === value.id);
        const next = value.data as Job;
        if (existing >= 0) fixture.jobs[existing] = next;
        else fixture.jobs.push(next);
      }
      return { data: null, error: null };
    }
    if (operation === "update") {
      if (table === "jobs") {
        const id = filters.id as string;
        const job = fixture.jobs.find((item) => item.id === id);
        if (job) Object.assign(job, patch.data as Partial<Job>);
      } else {
        const row = fixture.rows.find((item) => matches(item, filters));
        if (row) {
          row.data = patch.data as Partial<AppState>;
          if (typeof patch.revision === "number") row.revision = patch.revision;
        }
      }
      return { data: table === "app_states" ? [{ revision: fixture.rows[0]?.revision }] : null, error: null };
    }
    if (table === "jobs") {
    let values = fixture.jobs.filter((job) => filters.active === undefined || job.active === filters.active);
      if (inFilter) values = values.filter((job) => inFilter!.values.includes(job[inFilter!.key as keyof Job]));
      if (greaterThan) values = values.filter((job) => String(job[greaterThan!.key as keyof Job]) > greaterThan!.value);
      values.sort((a, b) => a.id.localeCompare(b.id));
      if (range) values = values.slice(range[0], range[1] + 1);
      if (limit !== undefined) values = values.slice(0, limit);
      if (fields.includes("discovered_at")) return { data: values.map((job) => ({ id: job.id, data: job, discovered_at: job.discoveredAt })), error: null };
      return { data: values.map((job) => ({ id: job.id, discovered_at: job.discoveredAt })), error: null };
    }
    let values = fixture.rows.filter((row) => matches(row, filters));
    if (greaterThan) values = values.filter((row) => String(row[greaterThan!.key as keyof Row]) > greaterThan!.value);
    values.sort((a, b) => a.user_id.localeCompare(b.user_id));
    if (range) values = values.slice(range[0], range[1] + 1);
    if (limit !== undefined) values = values.slice(0, limit);
    return { data: values.map((row) => ({ user_id: row.user_id, data: row.data, revision: row.revision })), error: null };
  };
  return Object.assign(builder, {
    maybeSingle: async () => {
      const result = await execute();
      return { data: result.data?.[0] ?? null, error: result.error };
    },
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject),
  });
}

fixture.admin.mockImplementation(() => ({ from: (table: string) => query(table) }));
fixture.admin.mockImplementation(() => ({
  from: (table: string) => query(table),
  rpc: async () => ({ data: null, error: null }),
  storage: { from: () => ({
    upload: async (key: string, bytes: Buffer) => { fixture.files.set(key, bytes); return { data: { path: key }, error: null }; },
    download: async (key: string) => ({ data: new Blob([fixture.files.get(key)?.toString("utf8") ?? ""]), error: null }),
  }) },
}));

vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: fixture.admin }));
vi.mock("@trigger.dev/sdk", () => ({
  task: (config: unknown) => config,
  tasks: { trigger: fixture.trigger },
}));
vi.mock("@/lib/budget", () => ({
  reserveServiceBudget: async () => true,
  reserveQueuedBudget: async (_user: string, applicationId: string, queuedId: string, projectedUsd: number) => ({ queuedId, reservationId: `queued:${queuedId}`, month: "2026-10", ownerId: "owner-1", applicationId, projectedUsd }),
  markQueuedBudgetClaimed: async () => true,
  markQueuedBudgetTerminal: async () => true,
  releaseQueuedBudget: async () => true,
}));
vi.mock("@/lib/latex-compiler", () => ({ fitResume: async (_profile: unknown, document: unknown) => ({ document, pdf: Buffer.from("%PDF-synthetic"), source: "synthetic-resume" }) }));
vi.mock("@/lib/browser-runner", () => ({ prepareBrowser: fixture.prepare, submitBrowser: fixture.submit, cancelBrowser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("openai", () => ({ default: class { responses = { parse: async (input: { text?: { format?: { name?: string } }; input?: Array<{ content: string }> }) => {
  const name = input.text?.format?.name;
  if (name === "structured_resume") return { output_parsed: { education: [], experience: [{ heading: { text: "Synthetic project", factIds: ["fact-python"] }, subheading: { text: "Analyst", factIds: ["fact-python"] }, dates: { text: "", factIds: [] }, location: { text: "", factIds: [] }, bullets: [{ text: "Built a Python project to analyze survey data", factIds: ["fact-python"], relevance: 90 }] }], projects: [], skills: [{ text: "Python", factIds: ["fact-python"] }], links: [] }, usage: { input_tokens: 10, output_tokens: 10 } };
  if (name === "resume_grounding_audit") {
    const request = JSON.parse(input.input?.[1]?.content ?? "{}") as { claims: Array<{ claimId: string; factIds: string[] }> };
    return { output_parsed: resumeGroundingOutput(request.claims, [], "The confirmed synthetic profile fact supports this résumé claim."), usage: { input_tokens: 10, output_tokens: 10 } };
  }
  if (name === "application_draft") return { output_parsed: { selectedFactIds: ["fact-python"], answers: [] }, usage: { input_tokens: 10, output_tokens: 10 } };
  return { output_parsed: { category: "strong", score: 95, evidence: [{ jobQuote: "Product Analyst", factIds: ["fact-python"] }], gaps: [], uncertainty: [] }, usage: { input_tokens: 10, output_tokens: 10 } };
} }; } }));

import { POST } from "@/app/api/internal/refresh/route";
import { assessUserMatches } from "../../trigger/matches";
import { runDraft, runFill } from "@/lib/application-runs";
import { runSubmission } from "@/lib/application-submission";

const runMatches = (assessUserMatches as unknown as { run: (payload: { userId: string }) => Promise<Record<string, unknown>> }).run;

function greenhousePayload(count: number) {
  return { jobs: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), title: `Product Analyst ${index + 1}`, absolute_url: `https://jobs.example/product-${index + 1}`, location: { name: "New York, NY" }, content: "<h3>Requirements</h3><ul><li>Python</li><li>SQL</li></ul>" })) };
}

async function runPipeline(hoursAfterRefresh: number) {
  const state = initialDemoState();
  state.profile.id = "owner-1";
  state.profile.workAuthorization = "Authorized to work in the US";
  state.profile.preferredTitles = ["Product Analyst"];
  state.profile.automationSettings!.resumeTailoring = true;
  saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } });
  activateAutomation(state.profile, "synthetic controlled discovery");
  fixture.rows = [{ user_id: "owner-1", data: { ...state, jobs: [] }, revision: 1 }];
  fixture.jobs = [];
  fixture.files = new Map();
  fixture.calls = [];
  fixture.trigger.mockImplementation(async (task: string, payload: Record<string, unknown>) => { fixture.calls.push({ task, payload }); return { id: `${task}-accepted` }; });
  fixture.prepare.mockImplementation(async (application: { packet?: { files?: Array<{ filename: string; size: number; sha256: string }> } }, job: Job, _profile: unknown, onSession: (session: Record<string, unknown>) => Promise<unknown>, onAction: (label: string) => Promise<unknown>) => {
    await onSession({ sessionId: "synthetic-session", provider: "browser-use", expiresAt: "2026-10-02T08:00:00.000Z", captchaSolving: false });
    await onAction("Synthetic fields filled");
    const file = application.packet!.files![0];
    return { sessionId: "synthetic-session", provider: "browser-use", needsAction: false, needsCoverLetter: false, form: { version: 1, url: job.applyUrl, fields: [{ label: "Resume", value: file.filename, identifier: "resume", kind: "file", required: true, valid: true, fileHashes: [`${file.filename}:${file.size}:${file.sha256}`] }], attachments: [file.filename], capturedAt: new Date().toISOString(), readyToSubmit: true, blockers: [], submitControl: { label: "Submit application", identifier: "submit", action: job.applyUrl, method: "post" } } };
  });
  fixture.submit.mockImplementation(async (application: { browserSessionId?: string; form?: { url: string } }, options: { beforeAttempt: (baseline: { version: 1; kind: "captcha"; sessionId: string; targetUrl: string; attemptedAt: string; beforeHash: string; beforeHadConfirmation: boolean }) => Promise<boolean> }) => {
    const attemptedAt = new Date().toISOString();
    await options.beforeAttempt({ version: 1, kind: "captcha", sessionId: application.browserSessionId!, targetUrl: application.form!.url, attemptedAt, beforeHash: "synthetic-before", beforeHadConfirmation: false });
    return { confirmed: true, evidence: "Synthetic application receipt", receipt: { version: 1, url: application.form!.url, text: "Synthetic application receipt", capturedAt: new Date().toISOString() } };
  });
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic");
  vi.stubEnv("TRIGGER_SECRET_KEY", "synthetic");
  vi.stubEnv("OPENAI_API_KEY", "synthetic");
  vi.stubEnv("JOB_BOARDS", "greenhouse:controlled");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => greenhousePayload(4) }));
  const response = await POST(new Request("https://example.com/api/internal/refresh", { method: "POST", headers: { authorization: "Bearer synthetic" } }));
  expect(response.status).toBe(200);
  vi.advanceTimersByTime(hoursAfterRefresh * 60 * 60 * 1000);
  const matchRequest = fixture.calls.find((call) => call.task === "assess-user-matches");
  expect(matchRequest).toBeTruthy();
  const result = await runMatches(matchRequest!.payload as { userId: string });
  const draftCalls = fixture.calls.filter((call) => call.task === "draft-application-packet");
  let fillIndex = 0;
  let submitIndex = 0;
  for (const call of draftCalls) {
    await runDraft(call.payload as Parameters<typeof runDraft>[0]);
    const fillCalls = fixture.calls.filter((item) => item.task === "fill-application-form");
    for (; fillIndex < fillCalls.length; fillIndex++) {
      await runFill(fillCalls[fillIndex].payload as Parameters<typeof runFill>[0]);
      const submitCalls = fixture.calls.filter((item) => item.task === "submit-application-form");
      for (; submitIndex < submitCalls.length; submitIndex++) await runSubmission(submitCalls[submitIndex].payload as Parameters<typeof runSubmission>[0]);
    }
  }
  return { result, persisted: fixture.rows[0].data as AppState, response: await response.json() };
}

describe("supported discovery pipeline boundaries", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01T08:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("refreshes a provider feed, matches unattended roles, and hands more than three runs to ordinary workers", async () => {
    const { result, persisted, response } = await runPipeline(4);
    expect(response.arrivals).toHaveLength(4);
    expect(result).toMatchObject({ assessed: 4 });
    expect(persisted.applications).toHaveLength(4);
    expect(persisted.applications.every((application) => application.status === "submitted" && application.submissionReceipt?.text === "Synthetic application receipt")).toBe(true);
    expect(fixture.calls.filter((call) => call.task === "draft-application-packet")).toHaveLength(4);
    expect(persisted.discovery?.events.filter((event) => event.kind === "queued")).toHaveLength(4);
  });

  it("records a controlled over-six-hour observation without claiming the production target", async () => {
    const { persisted } = await runPipeline(7);
    const delays = persisted.discovery?.events.filter((event) => event.kind === "queued").map((event) => event.delayMs ?? 0) ?? [];
    expect(delays.length).toBe(4);
    expect(delays.every((delay) => delay > 6 * 60 * 60 * 1000)).toBe(true);
  });
});
