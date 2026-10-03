import { expect, it } from "vitest";
import { importInput, importedRole, roleForPosting } from "@/lib/import-input";

it("distinguishes exact supported postings from board homepages and other employers", () => {
  for (const url of ["https://boards.greenhouse.io/team/jobs/123", "https://job-boards.greenhouse.io/team/jobs/123", "https://jobs.lever.co/team/abc/apply", "https://jobs.ashbyhq.com/team/abc/application"])
    expect(importInput(url)).toEqual({ error: "", manual: false });
  for (const url of ["https://company.com/careers/role", "https://jobs.lever.co/team", "https://boards.greenhouse.io/team", "https://jobs.lever.co.evil.com/team/abc"])
    expect(importInput(url)).toEqual({ error: "", manual: true });
});

it("explains incomplete, insecure, credential-bearing and private links before submission", () => {
  for (const url of ["", "not a link", "http://company.com/job", "https://me:secret@company.com/job", "https://localhost/job", "https://127.0.0.1/job", "https://[::1]/job"])
    expect(importInput(url).error).not.toBe("");
});


it("finds the actual imported role among concurrent additions and provider aliases", async () => {
  const { initialDemoState } = await import("./demo-data");
  const before = initialDemoState().jobs;
  const unrelated = { ...before[0], id: "other", url: "https://other.example/job" };
  const added = { ...before[0], id: "new", url: "https://job-boards.greenhouse.io/team/jobs/123", importUrl: "https://job-boards.greenhouse.io/team/jobs/123" };
  expect(importedRole(before, [...before, unrelated, added], "https://boards.greenhouse.io/team/jobs/123?utm_source=test#app")?.id).toBe("new");
  expect(importedRole(before, [...before, unrelated], added.url)).toBeUndefined();
  expect(importedRole([added], [added], added.url)).toBeUndefined();
  expect(roleForPosting([added], "https://boards.greenhouse.io/team/jobs/123?gh_src=test#app")?.id).toBe("new");
});
