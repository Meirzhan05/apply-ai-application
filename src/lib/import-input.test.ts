import { expect, it } from "vitest";
import { importInput } from "@/lib/import-input";

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
