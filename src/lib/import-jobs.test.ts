import { afterEach, describe, expect, it, vi } from "vitest";
import { applyImportedRefresh, importedPosting, newImportedJob, refreshImportedJobs } from "@/lib/import-jobs";
import { initialDemoState } from "@/lib/demo-data";
import { assessMatchLocally } from "@/lib/matching";
import { matchKey } from "@/lib/match-cache";

afterEach(() => vi.unstubAllGlobals());
const gh = (id = 42) => ({ id, title: "Junior Data Analyst", location: { name: "New York, NY" },
  absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, content: "<ul><li>Python</li><li>SQL</li></ul>" });
const mockFeed = (data: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
const imported = (url = "https://boards.greenhouse.io/acme/jobs/42") => newImportedJob({ url });

describe("private ATS imports", () => {
  it.each([
    ["https://boards.greenhouse.io/acme/jobs/42?gh_src=email#app", "greenhouse", "42"],
    ["https://jobs.lever.co/acme/job-id/apply", "lever", "job-id"],
    ["https://jobs.ashbyhq.com/acme/job-id/application", "ashby", "job-id"],
  ])("parses only supported hosted posting paths: %s", (url, source, sourceId) => {
    expect(importedPosting(url)).toEqual({ board: { source, slug: "acme" }, sourceId });
  });
  it("retrieves the actual description while retaining private identity and first discovery", async () => {
    mockFeed({ jobs: [gh()] });
    const original = imported();
    const [job] = await refreshImportedJobs([original], "2026-09-30T10:00:00.000Z");
    expect(job).toMatchObject({ id: original.id, discoveredAt: original.discoveredAt, source: "greenhouse",
      sourceId: "42", title: "Junior Data Analyst", requirements: ["Python", "SQL"],
      applyUrl: "https://job-boards.greenhouse.io/acme/jobs/42", importCheck: { status: "verified" } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it("shares a board read between imported roles and refreshes changed details", async () => {
    mockFeed({ jobs: [gh(), { ...gh(43), title: "Updated role" }] });
    const originals = [imported(), imported("https://boards.greenhouse.io/acme/jobs/43")];
    const result = await refreshImportedJobs(originals);
    expect(result[1].title).toBe("Updated role");
    expect(result.map((job) => job.id)).toEqual(originals.map((job) => job.id));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retains provider monitoring when the returned posting uses a custom employer URL", async () => {
    mockFeed({ jobs: [{ ...gh(), absolute_url: "https://careers.example.com/job?gh_jid=42" }] });
    const original = imported();
    const [first] = await refreshImportedJobs([original]);
    expect(first.url).toBe("https://careers.example.com/job?gh_jid=42");
    expect(first.importUrl).toBe(original.importUrl);
    const [second] = await refreshImportedJobs([first]);
    expect(second.importCheck?.status).toBe("verified");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith("https://boards-api.greenhouse.io/"))).toBe(true);
  });
  it("marks a missing published role closed only after a successful valid board read", async () => {
    mockFeed({ jobs: [] });
    const [job] = await refreshImportedJobs([imported()]);
    expect(job.active).toBe(false);
    expect(job.importCheck?.status).toBe("closed");
    expect(assessMatchLocally(initialDemoState().profile, job).category).toBe("excluded");
  });
  it.each([429, 404, 500])("preserves availability on failed provider reads (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
    const before = imported();
    const [job] = await refreshImportedJobs([before]);
    expect(job).toMatchObject({ id: before.id, title: before.title, active: true, importCheck: { status: "unavailable" } });
  });
  it.each([{ error: "invalid" }, { jobs: [null] }, { jobs: [], meta: { total: 5 } }, { jobs: [{ id: 42, title: "Bad URL", absolute_url: "http://localhost/" }] }])(
    "does not infer closure from a malformed or incomplete catalog", async (data) => {
      mockFeed(data);
      const [job] = await refreshImportedJobs([imported()]);
      expect(job.active).toBe(true);
      expect(job.importCheck?.status).toBe("unavailable");
    });
  it("retains directly linked unlisted Ashby roles and does not falsely close absent ones", async () => {
    mockFeed({ jobs: [{ title: "Unlisted role", isListed: false, jobUrl: "https://jobs.ashbyhq.com/acme/job-id",
      applyUrl: "https://jobs.ashbyhq.com/acme/job-id/application", descriptionPlain: "Python", isRemote: true }] });
    const [found, absent] = await refreshImportedJobs([imported("https://jobs.ashbyhq.com/acme/job-id/application"),
      imported("https://jobs.ashbyhq.com/acme/other-id")]);
    expect(found).toMatchObject({ active: true, title: "Unlisted role", importCheck: { status: "verified" } });
    expect(absent).toMatchObject({ active: true, importCheck: { status: "unavailable" } });
  });
  it("normalizes Lever requirements and apply links", async () => {
    mockFeed([{ id: "job-id", text: "Analyst", hostedUrl: "https://jobs.lever.co/acme/job-id", applyUrl: "https://jobs.lever.co/acme/job-id/apply",
      workplaceType: "remote", categories: { location: "US", commitment: "Full-time" }, lists: [{ content: "<li>SQL</li>" }] }]);
    const [job] = await refreshImportedJobs([imported("https://jobs.lever.co/acme/job-id/apply")]);
    expect(job).toMatchObject({ source: "lever", remote: true, requirements: ["SQL"], employmentType: "Full-time" });
  });
  it.each(["https://www.linkedin.com/jobs/view/42", "https://indeed.com/viewjob?jk=42", "https://careers.example.com/jobs/42",
    "https://jobs.lever.co/acme", "https://jobs.lever.co/acme/job/apply/extra", "https://jobs.lever.co:444/acme/job",
    "https://job-boards.greenhouse.io/..%2F..%2F/jobs/42"]) ("leaves unsupported links for handoff without fetching them: %s", async (url) => {
      vi.stubGlobal("fetch", vi.fn());
      const [job] = await refreshImportedJobs([imported(url)]);
      expect(job.importCheck?.status).toBe("manual");
      expect(fetch).not.toHaveBeenCalled();
    });
  it.each(["http://example.com/", "https://127.0.0.1/", "https://localhost/", "https://user:pass@jobs.lever.co/acme/job"])(
    "rejects unsafe links: %s", (url) => expect(() => imported(url)).toThrow());
  it("marks cached matching stale when import availability becomes unconfirmed", async () => {
    mockFeed({ jobs: [gh()] });
    const [job] = await refreshImportedJobs([imported()]);
    const unconfirmed = { ...job, importCheck: { status: "unavailable" as const, checkedAt: "later", message: "Availability unconfirmed" } };
    const profile = initialDemoState().profile;
    expect(matchKey(profile, job)).not.toBe(matchKey(profile, unconfirmed));
    expect(assessMatchLocally(profile, unconfirmed)).toMatchObject({ category: "uncertain", uncertainty: expect.arrayContaining(["Availability unconfirmed"]) });
  });
  it("applies only the owner's still-existing imports without rewriting application snapshots or approval", async () => {
    mockFeed({ jobs: [gh()] });
    const original = imported();
    const state = initialDemoState();
    state.importedJobs = [original]; state.jobs = [original];
    state.matchCache = { [matchKey(state.profile, original)]: assessMatchLocally(state.profile, original) };
    const applications = structuredClone(state.applications);
    const updated = await refreshImportedJobs([original]);
    expect(applyImportedRefresh(state, [original], updated)).toBe(1);
    expect(state.jobs[0].title).toBe("Junior Data Analyst");
    expect(state.applications).toEqual(applications);
    expect(state.matchCache).toEqual({});
    const other = initialDemoState(); other.importedJobs = [];
    expect(applyImportedRefresh(other, [original], updated)).toBe(0);
    expect(other.importedJobs).toEqual([]);
    state.importedJobs = [];
    expect(applyImportedRefresh(state, [original], updated)).toBe(0);
  });
  it("does not replace a more recent refresh or changed target", async () => {
    mockFeed({ jobs: [gh()] });
    const original = imported(); const state = initialDemoState();
    state.importedJobs = [{ ...original, importCheck: { status: "verified", checkedAt: "2030-01-01" } }];
    const updates = await refreshImportedJobs([original], "2026-09-30");
    expect(applyImportedRefresh(state, [original], updates)).toBe(0);
    state.importedJobs = [{ ...original, url: "https://example.com/changed" }];
    expect(applyImportedRefresh(state, [original], updates)).toBe(0);
  });
  it("bounds parallel API reads to four", async () => {
    let active = 0; let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active++; peak = Math.max(active, peak);
      await new Promise((resolve) => setTimeout(resolve, 2)); active--;
      return { ok: true, json: async () => ({ jobs: [] }) };
    }));
    await refreshImportedJobs(Array.from({ length: 9 }, (_, i) => imported(`https://boards.greenhouse.io/acme${i}/jobs/42`)));
    expect(peak).toBe(4); expect(fetch).toHaveBeenCalledTimes(9);
  });
});


it("imports and refreshes Lever EU through its fixed regional public API", async () => {
  const url = "https://jobs.eu.lever.co/acme/job-id/apply";
  expect(importedPosting(url)).toEqual({ board: { source: "lever", slug: "acme", region: "eu" }, sourceId: "job-id" });
  mockFeed([{ id: "job-id", text: "Engineer", hostedUrl: url.replace("/apply", ""), applyUrl: url }]);
  const [job] = await refreshImportedJobs([imported(url)]);
  expect(job.importCheck?.status).toBe("verified");
  expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.eu.lever.co/v0/postings/acme?mode=json", expect.any(Object));
});
