import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import {
  activateAutomation,
  automationStatus,
  onboardingCompleteness,
  onboardingMissingLabel,
  pauseAutomation,
  reusableFactualAnswers,
  saveOnboarding,
  updateAutomationSettings,
} from "@/lib/onboarding";

describe("autonomous onboarding", () => {
  it("starts with safe defaults and reports missing declarations separately", () => {
    const profile = initialDemoState().profile;

    expect(automationStatus(profile)).toMatchObject({
      enabled: false,
      paused: false,
      settings: {
        resumeTailoring: true,
        coverLetterMode: "required-only",
        essayMode: "automatic-truthful",
      },
    });
    expect(onboardingCompleteness(profile).complete).toBe(false);
    expect(onboardingCompleteness(profile).missing).toContain("workAuthorization");
    expect(onboardingCompleteness(profile).missing).toContain("requiresSponsorship");
    expect(onboardingMissingLabel("confirmedResumeFact")).toBe("resume experience");
  });

  it("persists confirmed facts, explicit legal answers, settings, and a versioned activation", () => {
    const profile = initialDemoState().profile;
    const initialVersion = profile.automationVersion;

    saveOnboarding(profile, {
      questionnaire: {
        workAuthorization: "yes",
        requiresSponsorship: "no",
      },
      facts: profile.facts.map((fact) => ({ ...fact, verified: true })),
    });
    updateAutomationSettings(profile, {
      resumeTailoring: false,
      coverLetterMode: "disabled",
      essayMode: "automatic-truthful",
      preferredTitles: [],
      preferredLocations: [],
      remoteOnly: false,
    });

    const authorization = activateAutomation(profile, "applicant-confirmed");
    expect(onboardingCompleteness(profile).complete).toBe(true);
    expect(profile.automationVersion).toBeGreaterThan(initialVersion);
    expect(authorization).toMatchObject({
      version: profile.automationVersion,
      status: "enabled",
      reason: "applicant-confirmed",
    });
    expect(automationStatus(profile)).toMatchObject({
      enabled: true,
      paused: false,
      settings: {
        resumeTailoring: false,
        coverLetterMode: "disabled",
      },
    });

    pauseAutomation(profile);
    expect(automationStatus(profile)).toMatchObject({ enabled: false, paused: true });
  });

  it("does not treat an explicit negative answer as an unanswered declaration", () => {
    const profile = initialDemoState().profile;
    saveOnboarding(profile, {
      questionnaire: { workAuthorization: "no", requiresSponsorship: "no" },
      facts: profile.facts,
    });

    const result = onboardingCompleteness(profile);
    expect(result.missing).not.toContain("workAuthorization");
    expect(result.missing).not.toContain("requiresSponsorship");
    expect(result.complete).toBe(true);
    expect(profile.onboarding?.questionnaire.workAuthorization).toBe("no");
  });

  it("rejects activation until experience facts are available", () => {
    const profile = initialDemoState().profile;
    saveOnboarding(profile, {
      questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" },
      facts: profile.facts.map((fact) => ({ ...fact, verified: false })),
    });

    expect(() => activateAutomation(profile, "applicant-confirmed")).toThrow(
      /upload a resume or add at least one experience fact/i,
    );
    expect(automationStatus(profile).enabled).toBe(false);
  });

  it("bumps the authorization version when settings change", () => {
    const profile = initialDemoState().profile;
    saveOnboarding(profile, {
      questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" },
      facts: profile.facts,
    });
    activateAutomation(profile, "applicant-confirmed");
    const before = profile.automationVersion;

    updateAutomationSettings(profile, { resumeTailoring: false });

    expect(profile.automationVersion).toBeGreaterThan(before);
    expect(profile.automationAuthorization?.version).toBe(profile.automationVersion);
  });

  it("makes explicit questionnaire answers reusable by browser factual fields", () => {
    const profile = initialDemoState().profile;
    saveOnboarding(profile, {
      questionnaire: {
        workAuthorization: "yes",
        requiresSponsorship: "no",
        availability: "May 2026",
        graduationYear: "2027",
      },
    });

    expect(reusableFactualAnswers(profile)).toMatchObject({
      workAuthorization: "Yes",
      requiresSponsorship: "No",
      availability: "May 2026",
    });
    expect(profile.graduationYear).toBe("2027");
  });

  it("lets the latest legal declaration replace or clear a legacy saved answer", () => {
    const profile = initialDemoState().profile;
    profile.sensitiveAnswers = {
      requiresSponsorship: "Yes",
      workAuthorization: "No",
      gender: "Woman",
    };
    saveOnboarding(profile, {
      questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" },
    });

    expect(reusableFactualAnswers(profile)).toMatchObject({
      workAuthorization: "Yes",
      requiresSponsorship: "No",
      gender: "Woman",
    });

    saveOnboarding(profile, {
      questionnaire: { workAuthorization: "unknown" },
    });
    expect(reusableFactualAnswers(profile)).not.toHaveProperty("workAuthorization");
    expect(reusableFactualAnswers(profile).requiresSponsorship).toBe("No");
  });
});
