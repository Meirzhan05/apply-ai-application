import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { jevTriage, redactedProfile } from "@/lib/jev";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Jev data minimization", () => {
  it("removes identifiers even when they appear inside confirmed fact text", () => {
    const profile = initialDemoState().profile;
    profile.phone = "212-555-0199";
    profile.facts = [{ id: "fact", text: `${profile.name} built Python projects. Contact ${profile.email}, ${profile.phone}, https://linkedin.com/in/example`, verified: true, source: "user" }];
    profile.sensitiveAnswers = { disability: "private" };
    profile.currentLocation = { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" };
    profile.willingToRelocate = false;
    const result = redactedProfile(profile);
    const serialized = JSON.stringify(result);
    for (const value of [profile.name, profile.email, profile.phone, "linkedin.com", "private", "Almaty", "Kazakhstan", "willingToRelocate"]) expect(serialized).not.toContain(value);
    expect(result.facts[0].text).toContain("Python projects");
    expect(result.sensitiveAnswers).toEqual({});
  });
  it("redacts every applicant string sent to the Jev request", async () => {
    const state = initialDemoState();
    state.profile.phone = "212-555-0199";
    state.profile.skills = ["TypeScript", `${state.profile.name} ${state.profile.email} ${state.profile.phone}`];
    state.profile.graduationYear = `2027 ${state.profile.email}`;
    state.profile.preferredTitles = [`Engineer ${state.profile.name}`];
    state.profile.preferredLocations = [`New York ${state.profile.phone}`];
    state.profile.workAuthorization = `Unspecified ${state.profile.email}`;
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ answers: { experience: { type: "choice", choice: "unknown", confidence: 0.8 }, skills: { type: "choice", choice: "some", confidence: 0.8 } } }) });
    vi.stubGlobal("fetch", request);
    await jevTriage(state.profile, state.jobs[0]);
    const payload = JSON.parse(request.mock.calls[0][1].body);
    const applicant = JSON.parse(payload.state).applicant;
    const serialized = JSON.stringify(applicant);
    for (const identifier of [state.profile.name, state.profile.email, state.profile.phone]) expect(serialized).not.toContain(identifier);
    const exportedProfile = JSON.stringify(redactedProfile(state.profile));
    for (const identifier of [state.profile.name, state.profile.email, state.profile.phone]) expect(exportedProfile).not.toContain(identifier);
    expect(applicant.skills[0]).toBe("TypeScript");
    expect(applicant.graduationYear).toContain("2027");
    expect(Object.keys(applicant).sort()).toEqual(["graduationYear", "headline", "skills", "verifiedFacts"]);
  });
});
