import { afterEach, describe, expect, it, vi } from "vitest";
import { sendActionNeeded, sendDigest } from "@/lib/email";
import { initialDemoState } from "@/lib/demo-data";
import { matchKey } from "@/lib/match-cache";
import { assessMatchLocally } from "@/lib/matching";
import { selectApplication } from "@/lib/workflow";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("test inbox restriction", () => {
  function setup(email: string) {
    vi.stubEnv("RESEND_API_KEY", "synthetic-test-key");
    vi.stubEnv("EMAIL_FROM", "Apply <onboarding@resend.dev>");
    vi.stubEnv("EMAIL_TEST_RECIPIENT", "owner@example.com");
    const state = initialDemoState();
    state.profile.demo = false;
    state.profile.email = email;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    return { state, fetchMock };
  }

  it("rejects another recipient before contacting the provider", async () => {
    const { state, fetchMock } = setup("another@example.com");
    await expect(sendActionNeeded(state, "Review your draft")).rejects.toThrow("authorized test inbox");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the test inbox and reuses the same provider idempotency key", async () => {
    const { state, fetchMock } = setup("Owner@example.com");
    await sendActionNeeded(state, "Review your draft");
    await sendActionNeeded(state, "Review your draft");
    const first = fetchMock.mock.calls[0][1];
    const second = fetchMock.mock.calls[1][1];
    expect(JSON.parse(first.body).to).toBe("Owner@example.com");
    expect(first.headers["Idempotency-Key"]).toBe(second.headers["Idempotency-Key"]);
  });
  it("omits a job the owner dismissed from the daily digest", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    state.feedback = [{ jobId: state.jobs[0].id, kind: "dismissed", reason: "Wrong role", updatedAt: new Date().toISOString() }];
    expect(await sendDigest(state, state.jobs)).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).html).not.toContain(state.jobs[0].title);
  });
  it("orders the digest using the same current AI scores as the dashboard", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    const template = state.jobs[0];
    state.jobs = [
      { ...template, id: "lower", title: "TypeScript Analyst" },
      { ...template, id: "higher", title: "Cloud Analyst" },
    ];
    state.matchCache = Object.fromEntries(state.jobs.map((job, index) => [matchKey(state.profile, job), { ...assessMatchLocally(state.profile, job), category: "strong", score: index ? 90 : 10, model: "synthetic-cache" }]));
    expect(await sendDigest(state, state.jobs)).toBe(true);
    const html = JSON.parse(fetchMock.mock.calls[0][1].body).html;
    expect(html.indexOf("Cloud Analyst")).toBeLessThan(html.indexOf("TypeScript Analyst"));
  });
  it("excludes already covered and future jobs at the batch watermark", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    const asOf = new Date("2026-09-30T13:00:00Z");
    state.lastDigestAt = "2026-09-30T01:00:00Z";
    const template = state.jobs[0];
    state.jobs = [
      { ...template, id: "covered", title: "Already covered", url: "https://example.com/covered", applyUrl: "https://example.com/covered", discoveredAt: "2026-09-30T00:00:00Z" },
      { ...template, id: "new", title: "New arrival", url: "https://example.com/new", applyUrl: "https://example.com/new", discoveredAt: "2026-09-30T12:00:00Z" },
      { ...template, id: "later", title: "Next batch arrival", url: "https://example.com/later", applyUrl: "https://example.com/later", discoveredAt: "2026-09-30T13:00:01Z" },
    ];
    expect(await sendDigest(state, state.jobs, asOf)).toBe(true);
    const html = JSON.parse(fetchMock.mock.calls[0][1].body).html;
    expect(html).toContain("New arrival");
    expect(html).not.toContain("Already covered");
    expect(html).not.toContain("Next batch arrival");
  });
  it("catches up postings after a missed digest without calling old jobs new on first delivery", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    const asOf = new Date("2026-09-30T13:00:00Z");
    state.jobs = [{ ...state.jobs[0], discoveredAt: "2026-09-29T01:00:00Z" }];
    expect(await sendDigest(state, state.jobs, asOf)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    state.lastDigestAt = "2026-09-28T13:00:00Z";
    expect(await sendDigest(state, state.jobs, asOf)).toBe(true);
  });
  it("includes fresh owner imports and suppresses duplicate URLs", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    const asOf = new Date();
    const job = { ...state.jobs[0], discoveredAt: new Date(asOf.getTime() - 1000).toISOString() };
    state.importedJobs = [{ ...job, id: "owner-import", title: "Owned imported role" }];
    expect(await sendDigest(state, [job], asOf)).toBe(true);
    const message = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(message.html).toContain("Owned imported role");
    expect(message.html).not.toContain(job.title);
    expect(message.subject).toBe("Apply: 1 new role");
  });
  it("rechecks hard rules before using cached AI in email", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    state.profile.remoteOnly = true;
    state.jobs = [{ ...state.jobs[0], remote: false }];
    const job = state.jobs[0];
    state.matchCache = { [matchKey(state.profile, job)]: { ...assessMatchLocally(state.profile, job), category: "strong", score: 99 } };
    expect(await sendDigest(state, state.jobs)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends an action-only digest without claiming there are new roles", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "draft_review";
    expect(await sendDigest(state, [])).toBe(true);
    const message = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(message.subject).toBe("Apply: 1 action needed");
    expect(message.html).toContain("1 application needs your review");
    expect(message.html).not.toContain("New opportunities");
  });
  it("restricts digests to the test inbox before contacting Resend", async () => {
    const { state, fetchMock } = setup("another@example.com");
    await expect(sendDigest(state, state.jobs)).rejects.toThrow("authorized test inbox");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reuses the daily digest provider key for the same owner and batch date", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    const asOf = new Date();
    await sendDigest(state, state.jobs, asOf);
    await sendDigest(state, state.jobs, asOf);
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]);
  });
  it("keeps the provider key on the schedule's New York day across UTC midnight", async () => {
    const { state, fetchMock } = setup("owner@example.com");
    state.jobs = [{ ...state.jobs[0], discoveredAt: "2026-09-30T18:00:00Z" }];
    await sendDigest(state, state.jobs, new Date("2026-09-30T23:00:00Z"));
    await sendDigest(state, state.jobs, new Date("2026-10-01T00:30:00Z"));
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]);
  });
});
