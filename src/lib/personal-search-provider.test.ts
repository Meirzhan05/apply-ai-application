import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), refresh: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { create: mocks.create }; } }));
vi.mock("@/lib/model-usage", () => ({ meterModelResponse: async (_owner: unknown, _op: string, _model: string, call: () => Promise<unknown>) => call() }));
vi.mock("@/lib/import-jobs", async (original) => ({ ...await original<typeof import("@/lib/import-jobs")>(), refreshImportedJobs: mocks.refresh }));
import { discoverPersonalJobs } from "@/lib/personal-search-provider";
import { initialDemoState } from "@/lib/demo-data";
beforeEach(() => { vi.clearAllMocks();
  mocks.create.mockResolvedValue({ status: "completed", output: [{ type: "web_search_call", status: "completed" }], output_text: "https://jobs.lever.co/company/job-a\nhttps://example.com/invented\nhttps://jobs.lever.co/company/job-a\nhttps://boards.greenhouse.io/company\nhttps://jobs.ashbyhq.com/company/job-b" });
  mocks.refresh.mockImplementation(async (jobs) => jobs.map((job: object, index: number) => ({ ...initialDemoState().jobs[0], ...job, location: "New York, NY", importCheck: { status: index ? "closed" : "verified" }, active: !index })));
});
it("searches from each student's own preferences, then publishes only provider-verified direct postings", async () => {
  const profile = initialDemoState().profile; profile.preferredTitles = ["Software intern"];
  const guard = vi.fn().mockResolvedValue(undefined);
  const jobs = await discoverPersonalJobs(profile, guard);
  expect(guard).toHaveBeenCalledOnce();
  expect(mocks.create.mock.calls[0][0].input).toContain("Software intern");
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ tools: [{ type: "web_search" }], max_tool_calls: 2, store: false });
  expect(mocks.refresh.mock.calls[0][0]).toHaveLength(2);
  expect(jobs).toHaveLength(1); expect(jobs[0].url).toBe("https://jobs.lever.co/company/job-a");
  profile.preferredTitles = ["Data analyst internship"];
  await discoverPersonalJobs(profile, guard);
  expect(mocks.create.mock.calls[1][0].input).toContain("Data analyst internship");
  expect(mocks.create.mock.calls[1][0].input).not.toContain("Software intern");
});
it("rejects a generated response that never searched the web", async () => {
  mocks.create.mockResolvedValue({ status: "completed", output: [], output_text: "https://jobs.lever.co/company/job-a" });
  await expect(discoverPersonalJobs(initialDemoState().profile, async () => {})).rejects.toThrow("did not complete");
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("keeps provider outage distinct from a verified empty result", async () => {
  mocks.refresh.mockImplementation(async (jobs) => jobs.map((job: object) => ({ ...job, importCheck: { status: "unavailable" } })));
  await expect(discoverPersonalJobs(initialDemoState().profile, async () => {})).rejects.toThrow("could not be verified");
});
