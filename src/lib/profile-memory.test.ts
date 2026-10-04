import { expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { personalQuestionKey, profileDetailValue, profileMemorySnapshot, rememberPersonalAnswer, applicationPersonalValues } from "@/lib/profile-memory";
import { autonomyProfileHash } from "@/lib/autonomous-policy";
import { packetProfileHash } from "@/lib/packet-profile";
import { selectApplication, setPacket } from "@/lib/workflow";
import { withPacketFiles } from "@/lib/packet-files";

it("maps personal links and common labels without reusing employer or screening answers", () => {
  for (const label of ["GitHub", "Your GitHub profile URL", "Please provide your GitHub profile (optional)"]) expect(personalQuestionKey(label)).toBe("githubUrl");
  expect(personalQuestionKey("LinkedIn profile")).toBe("linkedinUrl");
  expect(personalQuestionKey("What languages do you speak?")).toBe("languages");
  for (const label of ["Company website", "Your manager's LinkedIn", "Employer location", "Preferred location", "Will you relocate?", "Requires sponsorship", "Consent to recording", "Why this company?", "Expected salary"]) expect(personalQuestionKey(label)).toBeUndefined();
});

it("learns a personal answer for the next application while keeping existing values and authorizations stable", async () => {
  const state = initialDemoState(); const profile = state.profile;
  const app = selectApplication(state, state.jobs[0].id, profile.id);
  const fact = profile.facts[0];
  setPacket(state, app, await withPacketFiles(profile, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Fixture", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] }));
  const before = { autonomy: autonomyProfileHash(profile), packet: packetProfileHash(profile), memory: structuredClone(app.profileMemory) };
  rememberPersonalAnswer(profile, app.id, "GitHub profile", "https://github.com/riley-example");
  rememberPersonalAnswer(profile, app.id, "Languages spoken", "English, Spanish");
  rememberPersonalAnswer(profile, app.id, "Company website", "https://employer.example.com");
  expect(profile.savedAnswers?.map(answer => answer.key)).toEqual(["githubUrl", "languages"]);
  expect(profileDetailValue(profile, "githubUrl")).toBe("https://github.com/riley-example");
  expect(profileMemorySnapshot(profile).languages).toBe("English, Spanish");
  expect(applicationPersonalValues(profile, app)).toEqual(before.memory);
  expect(autonomyProfileHash(profile)).toBe(before.autonomy);
  expect(packetProfileHash(profile)).toBe(before.packet);
  const next = selectApplication(state, state.jobs[1].id, profile.id);
  setPacket(state, next, app.packet!);
  expect(applicationPersonalValues(profile, next).githubUrl).toBe("https://github.com/riley-example");
  expect(applicationPersonalValues(profile, { ...app, profileMemory: undefined }).githubUrl).toBe("");
});

it("manual edits and intentional clears win over learned values; sign-in email stays independent", () => {
  const profile = initialDemoState().profile; const authEmail = profile.email;
  rememberPersonalAnswer(profile, "application", "Email address", "candidate@example.com");
  expect(profileDetailValue(profile, "contactEmail")).toBe("candidate@example.com");
  expect(profile.email).toBe(authEmail);
  profile.githubUrl = "https://github.com/manual";
  profile.detailSources = { githubUrl: { source: "user", value: profile.githubUrl }, contactEmail: { source: "user", value: "" } };
  rememberPersonalAnswer(profile, "application", "GitHub", "https://github.com/new");
  expect(profileDetailValue(profile, "githubUrl")).toBe("https://github.com/manual");
  expect(profileDetailValue(profile, "contactEmail")).toBe("");
});

it("freezes canonical legacy links without guessing an ambiguous portfolio or resurrecting cleared links", () => {
  const profile = initialDemoState().profile;
  profile.links = ["https://linkedin.com/in/candidate", "https://github.com/candidate", "https://unrelated.example.com/project"];
  expect(profileMemorySnapshot(profile)).toMatchObject({
    linkedinUrl: "https://linkedin.com/in/candidate",
    githubUrl: "https://github.com/candidate",
    portfolioUrl: "",
  });
  profile.linkedinUrl = "";
  profile.detailSources = { linkedinUrl: { source: "user", value: "" } };
  expect(profileMemorySnapshot(profile).linkedinUrl).toBe("");
});

it("preserves automatic authorization and manual packet snapshots through later learning and packet revisions", async () => {
  const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  const fact = state.profile.facts[0];
  const packet = await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Fixture", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
  app.profileMemory = profileMemorySnapshot(state.profile); app.profileMemoryVersion = state.profile.automationVersion;
  app.autonomousAuthorization = { version: 1, userId: state.profile.id, profileVersion: state.profile.automationVersion, targetUrl: state.jobs[0].applyUrl, authorizedAt: new Date().toISOString() };
  const captured = structuredClone(app.profileMemory);
  rememberPersonalAnswer(state.profile, "different-application", "GitHub", "https://github.com/learned-later");
  setPacket(state, app, packet); expect(app.profileMemory).toEqual(captured);
  app.autonomousAuthorization = undefined;
  setPacket(state, app, packet); expect(app.profileMemory).toEqual(captured);
});
