import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: undefined as AppState | undefined, browserAllocations: 0 }));
vi.mock("@/lib/repository", () => ({ isDemo: () => true,
  loadState: async () => structuredClone(fixture.state!),
  mutateState: async (_owner: string, change: (state: AppState) => unknown) => change(fixture.state!),
}));
vi.mock("playwright-core", () => ({ chromium: { launch: async () => {
  fixture.browserAllocations++; throw new Error("Unexpected browser allocation");
} } }));
vi.mock("@/lib/email", () => ({ sendActionNeeded: vi.fn() }));

import { initialDemoState } from "@/lib/demo-data";
import { draftPacket } from "@/lib/drafting";
import { approveFill, approveSubmit, selectApplication, setPacket, transition } from "@/lib/workflow";
import { runFill } from "@/lib/application-runs";
import { runSubmission } from "@/lib/application-submission";
import { loadState } from "@/lib/repository";
import { bytesHash } from "@/lib/resume-artifacts";

const posting = { id: 12345, absolute_url: "https://job-boards.greenhouse.io/example/jobs/12345", questions: [
  { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
  { label: "Last Name", required: true, fields: [{ name: "last_name", type: "input_text" }] },
  { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
  { label: "Resume", required: true, fields: [{ name: "resume", type: "input_file" }, { name: "resume_text", type: "textarea" }] },
  { label: "Cover letter", required: false, fields: [{ name: "cover_letter", type: "input_file" }] },
] };

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("EMAIL_FROM", ""); vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("ATS_SUBMISSION_INTEGRATIONS", JSON.stringify([{ provider: "greenhouse", board: "example", apiKey: "employer-test-key" }]));
  fixture.browserAllocations = 0;
  const state = initialDemoState();
  const packet = await draftPacket(state.profile, state.jobs[0]); packet.answers = [];
  state.jobs[0] = { ...state.jobs[0], id: "greenhouse:example:12345", source: "greenhouse", sourceId: "12345",
    url: posting.absolute_url, applyUrl: posting.absolute_url };
  const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  setPacket(state, app, packet);
  approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
  transition(app, ["authorized_to_fill"], "filling"); app.runToken = "api-fill-test";
  fixture.state = state;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(posting)));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("prepares an authorized application for review without allocating a browser", async () => {
  const state = fixture.state!, app = state.applications[0];
  await runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken });
  const reviewed = (await loadState(state.profile.id)).applications[0];
  expect(reviewed.status).toBe("final_review");
  expect(reviewed.form?.apiSubmission?.provider).toBe("greenhouse");
  expect(reviewed.form?.fields.find((field) => field.identifier === "email")?.value).toBe(state.profile.email);
  expect(reviewed.browserSessionId).toBeUndefined();
  expect(fixture.browserAllocations).toBe(0);
});

it("submits the reviewed values and exact files through the API once", async () => {
  const state = fixture.state!, app = state.applications[0];
  const requests: FormData[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body instanceof FormData) { requests.push(init.body); return Response.json({}); }
    return Response.json(posting);
  }));
  await runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken });
  approveSubmit(app, state.profile.id, app.form!.hash);
  transition(app, ["approved_to_submit"], "submitting"); app.submissionStartedAt = new Date().toISOString();
  await runSubmission({ userId: state.profile.id, applicationId: app.id });
  await runSubmission({ userId: state.profile.id, applicationId: app.id });
  const submitted = (await loadState(state.profile.id)).applications[0];
  expect(submitted.status).toBe("submitted");
  expect(submitted.submissionAttemptedAt).toBeTruthy();
  expect(requests).toHaveLength(1);
  expect(requests[0].get("email")).toBe(state.profile.email);
  expect(requests[0].get("resume")).toBeInstanceOf(Blob);
  const upload = requests[0].get("resume");
  if (!(upload instanceof Blob)) throw new Error("Expected the reviewed resume upload");
  expect(bytesHash(Buffer.from(await upload.arrayBuffer()))).toBe(app.packet!.files!.find((file) => file.kind === "resume")!.sha256);
  expect(submitted.submissionMaterials?.files).toEqual(app.packet!.files);
  expect(submitted.submissionReceipt?.text).toContain("Greenhouse accepted");
  expect(fixture.browserAllocations).toBe(0);
});

it("does not send an API request without final approval", async () => {
  const state = fixture.state!, app = state.applications[0];
  let submissions = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body instanceof FormData) submissions++;
    return Response.json(posting);
  }));
  await runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken });
  transition(app, ["final_review"], "submitting");
  expect(await runSubmission({ userId: state.profile.id, applicationId: app.id })).toEqual({ skipped: true });
  expect(submissions).toBe(0);
});

it("records a timeout as uncertain without falling back to a browser or retrying", async () => {
  const state = fixture.state!, app = state.applications[0];
  let submissions = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body instanceof FormData) { submissions++; throw new Error("Socket timed out after the server accepted it"); }
    return Response.json(posting);
  }));
  await runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken });
  approveSubmit(app, state.profile.id, app.form!.hash); transition(app, ["approved_to_submit"], "submitting");
  await runSubmission({ userId: state.profile.id, applicationId: app.id });
  await runSubmission({ userId: state.profile.id, applicationId: app.id });
  expect(app.status).toBe("uncertain");
  expect(app.submissionAttemptedAt).toBeTruthy();
  expect(app.confirmation).toContain("No browser fallback".toLowerCase());
  expect(submissions).toBe(1);
  expect(fixture.browserAllocations).toBe(0);
});

it("requires new preparation and review when the employer adds a required field", async () => {
  const state = fixture.state!, app = state.applications[0];
  await runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken });
  approveSubmit(app, state.profile.id, app.form!.hash); transition(app, ["approved_to_submit"], "submitting");
  let submissions = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.body instanceof FormData) submissions++;
    return Response.json({ ...posting, questions: [...posting.questions,
      { label: "Your salary requirement", required: true, fields: [{ name: "question_999", type: "input_text" }] }] });
  }));
  expect(await runSubmission({ userId: state.profile.id, applicationId: app.id })).toEqual({ formChanged: true });
  expect(app.status).toBe("authorized_to_fill"); expect(app.form).toBeUndefined();
  expect(app.approvals.some((approval) => approval.kind === "submit")).toBe(false);
  expect(app.submissionAttemptedAt).toBeUndefined(); expect(submissions).toBe(0);
});

it("routes unconfigured employers to the browser before any submission", async () => {
  vi.stubEnv("ATS_SUBMISSION_INTEGRATIONS", "[]");
  const state = fixture.state!, app = state.applications[0];
  await expect(runFill({ userId: state.profile.id, applicationId: app.id, runToken: app.runToken })).rejects.toThrow("Unexpected browser allocation");
  expect(fixture.browserAllocations).toBe(1);
  expect(app.form?.apiSubmission).toBeUndefined(); expect(app.submissionAttemptedAt).toBeUndefined();
});
