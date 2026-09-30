import { describe, expect, it } from "vitest";
import { sponsorshipPolicy } from "@/lib/sponsorship-policy";

describe("explicit employment sponsorship policies", () => {
  it.each([
    "No visa sponsorship is available.",
    "No visa sponsorship.",
    "We do not offer visa sponsorship.",
    "We cannot provide employment sponsorship.",
    "Immigration sponsorship will be unavailable.",
    "We do not sponsor visas.",
    "We can't sponsor candidates.",
    "We can’t sponsor employees.",
    "We do not provide sponsorship for this role.",
    "No sponsorship is available for the position.",
    "You must already be authorized to work without sponsorship.",
  ])("recognizes explicit unavailability: %s", (text) => {
    expect(sponsorshipPolicy(text)).toBe("unavailable");
  });
  it.each([
    "Visa sponsorship is available for this role.",
    "We offer work visa sponsorship to successful applicants.",
    "We provide visa sponsorship.",
    "Sponsorship is available for this position.",
    "We do not sponsor sports teams. Visa sponsorship is available for this role.",
    "We do not offer sponsorship for conferences. We provide visa sponsorship to successful applicants.",
    "No sponsorship is available for this event. Visa sponsorship is available for this role.",
  ])("recognizes affirmative employment statements: %s", (text) => {
    expect(sponsorshipPolicy(text)).toBe("available");
  });
  it.each([
    "We do not sponsor sports teams.",
    "We do not offer sponsorship for conferences.",
    "No sponsorship is available for this event.",
    "No sponsorship is required to apply.",
    "We do not sponsor.",
    "Visa sponsorship may be available.",
    "Visa sponsorship is available only for senior roles.",
    "We offer visa sponsorship if the applicant meets additional eligibility requirements.",
    "We cannot guarantee visa sponsorship is available.",
    "We cannot provide visa sponsorship unless you qualify for an exception.",
    "We do not offer visa sponsorship for contractors only.",
    "We do not offer visa sponsorship. Visa sponsorship is available for this role.",
    "Visa sponsorship is not required.",
    "",
  ])("retains uncertain or conflicting statements: %s", (text) => {
    expect(sponsorshipPolicy(text)).toBe("unknown");
  });
});
