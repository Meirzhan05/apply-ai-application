import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeMissingJobs,
  configuredBoards,
  dedupeJobs,
  fetchBoard,
  canonicalJobUrl,
  normalizePostingUrl,
  classifyImport,
} from "@/lib/sources";
import { initialDemoState } from "@/lib/demo-data";
import { explicitConflict } from "@/lib/matching";

afterEach(() => vi.unstubAllGlobals());

describe("public source normalization", () => {
  it("retains provider-declared hybrid work arrangements for matching", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [{
      id: "hybrid-role", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/hybrid-role",
      workplaceType: "hybrid", categories: { location: "Boston, MA" },
    }] }));
    const [job] = await fetchBoard({ source: "lever", slug: "acme" });
    const profile = initialDemoState().profile;
    profile.workArrangements = ["hybrid"];
    expect(job).toMatchObject({ workArrangement: "hybrid" });
    expect(explicitConflict(profile, job)).toBeNull();
    profile.workArrangements = ["remote", "on-site"];
    expect(explicitConflict(profile, job)).toMatch(/work arrangement/);
  });
  it("shows Greenhouse's current hosted posting destination before approval", () => {
    const old = "https://boards.greenhouse.io/acme/jobs/42?gh_jid=42#app";
    const current = "https://job-boards.greenhouse.io/acme/jobs/42?gh_jid=42#app";
    expect(normalizePostingUrl(old)).toBe(current);
    expect(classifyImport(old).url).toBe(current);
    expect(canonicalJobUrl(old)).toBe(canonicalJobUrl(current));
    expect(normalizePostingUrl("https://careers.acme.com/jobs/42")).toBe("https://careers.acme.com/jobs/42");
    expect(normalizePostingUrl("https://boards.greenhouse.io/embed/job_app?token=42")).toBe("https://boards.greenhouse.io/embed/job_app?token=42");
  });
  it("preserves distinct openings with the same employer, title, and location", () => {
    const base = initialDemoState().jobs[0];
    const first = { ...base, id: "role:1", url: "https://example.com/jobs/1", description: "Payments team" };
    const second = { ...base, id: "role:2", url: "https://example.com/jobs/2", description: "Search team" };
    expect(dedupeJobs([first, second])).toHaveLength(2);
  });

  it("removes tracking aliases while preserving job-ID parameters and SPA routes", () => {
    expect(canonicalJobUrl("https://example.com/jobs?gh_jid=42&utm_source=email&gh_src=ad")).toBe("https://example.com/jobs?gh_jid=42");
    expect(canonicalJobUrl("https://example.com/jobs?gh_jid=43")).not.toBe(canonicalJobUrl("https://example.com/jobs?gh_jid=42"));
    expect(canonicalJobUrl("https://example.com/#/jobs/1")).not.toBe(canonicalJobUrl("https://example.com/#/jobs/2"));
    const base = initialDemoState().jobs[0];
    expect(dedupeJobs([{ ...base, id: "role:1", url: "https://example.com/jobs/1" }, { ...base, id: "role:2", url: "https://example.com/jobs/1?utm_campaign=digest" }])).toHaveLength(1);
  });

  it("keeps the active posting when a closed snapshot points to the same URL", () => {
    const base = initialDemoState().jobs[0];
    const open = { ...base, id: "open" };
    expect(dedupeJobs([{ ...base, id: "closed", active: false }, open])).toEqual([open]);
  });

  it("rejects a rate-limited source instead of treating it as an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await expect(fetchBoard({ source: "greenhouse", slug: "acme" })).rejects.toThrow("429");
  });

  it("rejects malformed catalogs instead of closing existing jobs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: "unavailable" }) }));
    await expect(fetchBoard({ source: "ashby", slug: "acme" })).rejects.toThrow("invalid catalog");
  });

  it("normalizes requirements from a Greenhouse response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            jobs: [
              {
                id: 42,
                title: "Junior Analyst",
                absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
                location: { name: "Remote" },
                content:
                  "<ul><li>Experience with SQL</li><li>Python skills</li></ul>",
              },
            ],
          }),
        }),
    );
    const [job] = await fetchBoard({ source: "greenhouse", slug: "acme" });
    expect(job.requirements).toEqual(["Experience with SQL", "Python skills"]);
    expect(job.applyUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/42");
  });

  it("deduplicates roles and closes only jobs from successfully fetched boards", () => {
    const now = new Date().toISOString();
    const base = {
      id: "greenhouse:acme:1",
      source: "greenhouse" as const,
      sourceId: "1",
      sourceLabel: "Greenhouse",
      company: "Acme",
      title: "Engineer",
      location: "New York",
      remote: null,
      employmentType: "Full-time",
      description: "",
      requirements: [],
      url: "https://example.com/1",
      applyUrl: "https://example.com/1",
      active: true,
      discoveredAt: now,
    };
    const other = { ...base, id: "lever:other:2", source: "lever" as const };
    expect(
      dedupeJobs([base, { ...base, id: "greenhouse:acme:2" }]),
    ).toHaveLength(1);
    const result = closeMissingJobs(
      [base, other],
      [{ source: "greenhouse", slug: "acme" }],
      new Set(),
    );
    expect(result.closed).toBe(1);
    expect(result.jobs[0].active).toBe(false);
    expect(result.jobs[1].active).toBe(true);
    expect(
      configuredBoards("greenhouse:acme,lever:example,ashby:demo"),
    ).toHaveLength(2);
  });

  it.each([false, true])("extracts qualifications without duties or benefits from Greenhouse (escaped=%s)", async (escaped) => {
    const html = '<h3>Responsibilities</h3><ul><li>Ship product features</li></ul>' +
      '<h3>Requirements</h3><ul><li>Experience with Python</li><li>CS degree expected by Summer 2027</li></ul>' +
      '<h3>Benefits</h3><ul><li>Competitive salary and equity</li><li>Health coverage</li></ul>';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [{
      id: 42, title: "Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/42",
      content: escaped ? html.replace(/</g, "&lt;").replace(/>/g, "&gt;") : html,
    }] }) }));
    const [job] = await fetchBoard({ source: "greenhouse", slug: "acme" });
    expect(job.requirements).toEqual(["Experience with Python", "CS degree expected by Summer 2027"]);
    expect(job.description).toContain("Ship product features");
    expect(job.description).toContain("Competitive salary and equity");
    expect(job.description).not.toMatch(/<|&lt;/);
  });

  it("uses Ashby candidate headings and retains bold paragraphs inside qualification bullets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [{
      id: "role", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/role",
      descriptionHtml: '<h2>What you’ll do</h2><ul><li>Build agents</li></ul>' +
        '<h2>What we’re looking for</h2><ul><li><p><strong>Experience with Python</strong></p></li><li>React skills</li></ul>' +
        '<h2>Even better...</h2><ul><li>Experience with LLMs</li></ul>' +
        '<h2>What we offer</h2><ul><li>Competitive salary and equity</li></ul>',
    }] }) }));
    const [job] = await fetchBoard({ source: "ashby", slug: "acme" });
    expect(job.requirements).toEqual(["Experience with Python", "React skills", "Experience with LLMs"]);
  });

  it("preserves Lever list headings when separating qualifications from responsibilities", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => [{
      id: "role", text: "Engineer", hostedUrl: "https://jobs.lever.co/acme/role",
      lists: [
        { text: "Responsibilities", content: "<li>Ship product features</li>" },
        { text: "What you'll bring", content: "<li>Experience with Java</li>" },
        { text: "Benefits", content: "<li>Paid vacation</li>" },
      ],
    }] }));
    const [job] = await fetchBoard({ source: "lever", slug: "acme" });
    expect(job.requirements).toEqual(["Experience with Java"]);
    expect(job.description).toContain("Paid vacation");
  });

  it("keeps bold paragraph section labels without mistaking bold requirements for boundaries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [{
      id: 42, title: "Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/42",
      content: '<p><strong>Qualifications</strong></p><ul><li><p><strong>Python skills</strong></p></li></ul>' +
        '<p><strong>Compensation</strong></p><ul><li>Salary $150,000</li></ul>',
    }] }) }));
    expect((await fetchBoard({ source: "greenhouse", slug: "acme" }))[0].requirements).toEqual(["Python skills"]);
  });

  it("returns unknown requirements when a posting contains only benefits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [{
      id: 42, title: "Engineer", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/42",
      content: "<h3>Benefits</h3><ul><li>Competitive salary and equity</li></ul>",
    }] }) }));
    expect((await fetchBoard({ source: "greenhouse", slug: "acme" }))[0].requirements).toEqual([]);
  });

  it("preserves Ashby secondary locations so a New York applicant is not rejected for a San Francisco primary location", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [{
      id: "role", title: "Engineer", jobUrl: "https://jobs.ashbyhq.com/acme/role", isRemote: false,
      location: "San Francisco, CA", secondaryLocations: [
        { location: "New York, NY" }, { location: " San Francisco, CA " }, {}, null,
      ],
    }] }) }));
    const [job] = await fetchBoard({ source: "ashby", slug: "acme" });
    expect(job.location).toBe("San Francisco, CA; New York, NY");
    const profile = { ...initialDemoState().profile, remoteOnly: false, strictLocations: true,
      preferredLocations: ["New York"], workAuthorization: "Unspecified" };
    expect(explicitConflict(profile, job)).toBeNull();
  });
});
