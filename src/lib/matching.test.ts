import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { assessMatch, assessMatchLocally, explicitConflict } from "@/lib/matching";
import { matchKey, matchReservationId } from "@/lib/match-cache";
import { publicState } from "@/lib/public-state";
import { feedbackAdjustment } from "@/lib/ranking";
import { classifyImport } from "@/lib/sources";
import { hashJson } from "@/lib/crypto";

const response = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({ default: class { responses = { parse: response }; } }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("matching boundaries", () => {
  it("rejects explicit hard-rule conflicts and leaves missing details uncertain", () => {
    const state = initialDemoState();
    state.profile.remoteOnly = true;
    expect(explicitConflict(state.profile, state.jobs[0])).toMatch(
      /not remote/,
    );
    expect(
      explicitConflict(state.profile, { ...state.jobs[0], remote: null }),
    ).toBeNull();
    expect(
      assessMatchLocally(state.profile, { ...state.jobs[0], remote: null })
        .category,
    ).not.toBe("excluded");
  });
  it("does not treat missing work authorization as an explicit rejection", () => {
    const state = initialDemoState();
    expect(explicitConflict(state.profile, state.jobs[0])).toBeNull();
    expect(
      assessMatchLocally(state.profile, state.jobs[0]).uncertainty,
    ).toContain("Work authorization has not been confirmed.");
  });
  it.each(["", " unspecified ", "F-1 international student", "F-1 international student; employment authorization and sponsorship details unconfirmed."])("keeps authorization unconfirmed for a status-only answer: %s", async (workAuthorization) => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    const state = initialDemoState();
    state.profile.workAuthorization = workAuthorization;
    const job = { ...state.jobs[0], description: "Build with TypeScript. We do not offer visa sponsorship.", requirements: ["TypeScript"] };
    response.mockResolvedValue({ output_parsed: { category: "strong", score: 99, evidence: [{ jobQuote: "TypeScript", factIds: [state.profile.facts[0].id] }], gaps: [], uncertainty: [] } });
    expect(explicitConflict(state.profile, job)).toBeNull();
    expect(assessMatchLocally(state.profile, job).uncertainty).toContain("Work authorization has not been confirmed.");
    expect((await assessMatch(state.profile, job)).uncertainty).toContain("Work authorization has not been confirmed.");
    expect(state.profile.sensitiveAnswers).toEqual({});
  });
  it("does not reuse a cached assessment that treated visa status as an authorization answer", () => {
    const state = initialDemoState();
    state.profile.workAuthorization = "F-1 international student";
    const job = state.jobs[0];
    state.jobs = [job];
    const previous = `${job.id}:${hashJson({ policyVersion: 3, profileUpdatedAt: state.profile.updatedAt, title: job.title, location: job.location, remote: job.remote, deadline: job.deadline, description: job.description, requirements: job.requirements, active: job.active, importStatus: job.importCheck?.status })}`;
    state.matchCache = { [previous]: { ...assessMatchLocally(state.profile, job), uncertainty: [], model: "previous-authorization-policy" } };
    expect(matchKey(state.profile, job)).not.toBe(previous);
    expect(publicState(state).matches[0].assessment.uncertainty).toContain("Work authorization has not been confirmed.");
  });
  it("does not confuse sponsorship that is not required with sponsorship that is unavailable", () => {
    const state = initialDemoState(); state.profile.workAuthorization = "Requires sponsorship";
    expect(explicitConflict(state.profile, { ...state.jobs[0], description: "No sponsorship is required to apply." })).toBeNull();
    expect(explicitConflict(state.profile, { ...state.jobs[0], description: "We do not offer visa sponsorship." })).toMatch(/unavailable/);
  });
  it.each([
    "We do not sponsor sports teams. Visa sponsorship is available for this role.",
    "We do not offer sponsorship for conferences. We provide visa sponsorship to successful applicants.",
    "No sponsorship is available for this event. Visa sponsorship is available for this role.",
  ])("does not reject unrelated sponsorship policies: %s", (description) => {
    const state = initialDemoState();
    state.profile.workAuthorization = "Requires sponsorship";
    expect(explicitConflict(state.profile, { ...state.jobs[0], description, requirements: [] })).toBeNull();
  });
  it("keeps an unknown required sponsorship policy uncertain despite a strong AI assessment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    const state = initialDemoState();
    state.profile.workAuthorization = "Requires sponsorship";
    const job = { ...state.jobs[0], description: "We build products with TypeScript. We do not sponsor sports teams.", requirements: ["TypeScript"] };
    response.mockResolvedValue({ output_parsed: { category: "strong", score: 99, evidence: [{ jobQuote: "TypeScript", factIds: [state.profile.facts[0].id] }], gaps: [], uncertainty: [] } });
    expect(explicitConflict(state.profile, job)).toBeNull();
    expect(assessMatchLocally(state.profile, job).category).toBe("uncertain");
    expect((await assessMatch(state.profile, job)).category).toBe("uncertain");
    expect((await assessMatch(state.profile, job)).uncertainty.join(" ")).toContain("employment sponsorship");
    expect((await assessMatch(state.profile, { ...job, description: `${job.description} Visa sponsorship is available for this role.` })).category).toBe("strong");
  });
  it("does not reuse a persisted strong assessment from the previous sponsorship policy", () => {
    const state = initialDemoState();
    state.profile.workAuthorization = "Requires sponsorship";
    const job = { ...state.jobs[0], description: "We build products with TypeScript.", requirements: ["TypeScript"] };
    state.jobs = [job];
    const oldKey = `${job.id}:${hashJson({ policyVersion: 2, profileUpdatedAt: state.profile.updatedAt, title: job.title, location: job.location, remote: job.remote, deadline: job.deadline, description: job.description, requirements: job.requirements, active: job.active })}`;
    state.matchCache = { [oldKey]: { ...assessMatchLocally(state.profile, job), category: "strong", score: 99, model: "old-cache-fixture" } };
    expect(matchKey(state.profile, job)).not.toBe(oldKey);
    expect(publicState(state).matches[0].assessment.category).toBe("uncertain");
    expect(publicState(state).matches[0].assessment.uncertainty.join(" ")).toContain("employment sponsorship");
  });
  it("applies required locations only to explicitly on-site roles", () => {
    const state = initialDemoState(); state.profile.strictLocations = true; state.profile.preferredLocations = ["New York"];
    expect(explicitConflict(state.profile, { ...state.jobs[0], location: "Boston, MA", remote: false })).toMatch(/required locations/);
    expect(explicitConflict(state.profile, { ...state.jobs[0], location: "Location not listed", remote: false })).toBeNull();
    expect(explicitConflict(state.profile, { ...state.jobs[0], location: "Boston, MA", remote: null })).toBeNull();
  });
  it("keeps aliases eligible and unknown required geography visibly uncertain", () => {
    const state = initialDemoState();
    state.profile.strictLocations = true;
    state.profile.preferredLocations = ["NYC"];
    const known = { ...state.jobs[0], location: "New York, NY", remote: false };
    expect(explicitConflict(state.profile, known)).toBeNull();
    const unknown = { ...known, location: "New York metropolitan area" };
    expect(explicitConflict(state.profile, unknown)).toBeNull();
    const assessment = assessMatchLocally(state.profile, unknown);
    expect(assessment.category).toBe("uncertain");
    expect(assessment.uncertainty.join(" ")).toContain("required locations");
    expect(explicitConflict(state.profile, { ...known, location: "Boston, MA" })).toMatch(/required locations/);
  });
  it("cannot turn an unknown required remote status into a strong match through AI", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key");
    const state = initialDemoState();
    state.profile.remoteOnly = true;
    const unknown = { ...state.jobs[0], remote: null };
    response.mockResolvedValue({ output_parsed: { category: "strong", score: 99, evidence: [{ jobQuote: unknown.title, factIds: [state.profile.facts[0].id] }], gaps: [], uncertainty: [] } });
    const assessment = await assessMatch(state.profile, unknown);
    expect(assessment.category).toBe("uncertain");
    expect(assessment.uncertainty.join(" ")).toContain("remote-only rule");
    expect((await assessMatch(state.profile, { ...unknown, remote: true })).category).toBe("strong");
    expect(matchKey(state.profile, unknown)).not.toBe(matchKey(state.profile, { ...unknown, remote: true }));
    expect(matchKey(state.profile, unknown)).not.toBe(matchKey(state.profile, { ...unknown, deadline: "2026-10-01" }));
  });
  it("applies elapsed deadlines even when an unchanged posting has a cached strong match", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T11:59:00Z"));
    const state = initialDemoState();
    const job = { ...state.jobs[0], deadline: "2026-10-01T12:00:00Z" };
    state.jobs = [job];
    const key = matchKey(state.profile, job);
    state.matchCache = { [key]: { ...assessMatchLocally(state.profile, job), category: "strong", score: 95, model: "cached-fixture" } };
    expect(publicState(state).matches[0].assessment.category).toBe("strong");
    vi.setSystemTime(new Date("2026-10-01T12:00:01Z"));
    expect(matchKey(state.profile, job)).toBe(key);
    expect(publicState(state).matches[0].assessment.category).toBe("excluded");
    expect(publicState(state).matches[0].assessment.gaps).toContain("The application deadline has passed.");
  });
  it("reserves new assessment costs for changed postings and separates owners", () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    const id = matchReservationId(state.profile, job);
    expect(matchReservationId(state.profile, { ...job })).toBe(id);
    expect(matchReservationId(state.profile, { ...job, description: `${job.description} New qualification.` })).not.toBe(id);
    expect(matchReservationId({ ...state.profile, id: "another-owner" }, job)).not.toBe(id);
    expect(matchReservationId({ ...state.profile, updatedAt: "new-profile-version" }, job)).not.toBe(id);
  });
  it("rejects unsafe imports", () => {
    expect(() => classifyImport("http://example.com/job")).toThrow(/HTTPS/);
    expect(() => classifyImport("https://127.0.0.1/job")).toThrow(/Private/);
    expect(() => classifyImport("https://user:pass@example.com/job")).toThrow(
      /credentials/,
    );
  });
  it("uses explicit feedback to adjust similar future roles", () => {
    const state = initialDemoState();
    const similar = {
      ...state.jobs[0],
      id: "similar",
      company: "Another employer",
    };
    expect(
      feedbackAdjustment(
        similar,
        [
          {
            jobId: state.jobs[0].id,
            kind: "dismissed",
            reason: "Wrong role",
            updatedAt: new Date().toISOString(),
          },
        ],
        state.jobs,
      ),
    ).toBeLessThan(0);
  });
});
