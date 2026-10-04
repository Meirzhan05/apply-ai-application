import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { Profile } from "@/lib/types";
import { completeOnboardingFixture } from "@/lib/testing/onboarding";
import {
  actionNeedsCompletedOnboarding,
  assertResumeOnboardingComplete,
  isResumeOnboardingComplete,
} from "@/lib/onboarding-gate";

function completeProfile(): Profile {
  return completeOnboardingFixture(initialDemoState().profile);
}

describe("mandatory onboarding admission", () => {
  it("requires v2 completion even when legacy profile answers exist", () => {
    const profile = initialDemoState().profile;
    profile.demo = false;
    profile.onboarding = { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" }, completedAt: new Date().toISOString() };
    expect(isResumeOnboardingComplete(profile)).toBe(false);
    expect(() => assertResumeOnboardingComplete(profile, "drafting an application packet")).toThrow(/required onboarding/i);
  });

  it("admits a source-backed v2 completion without enabling automation", () => {
    const profile = completeProfile();
    expect(isResumeOnboardingComplete(profile)).toBe(true);
    expect(() => assertResumeOnboardingComplete(profile)).not.toThrow();
    expect(profile.automationAuthorization).toBeUndefined();
  });

  it("keeps saved profile, resume and outcome recovery actions available", () => {
    expect(actionNeedsCompletedOnboarding("onboardingDraft")).toBe(false);
    expect(actionNeedsCompletedOnboarding("profile")).toBe(false);
    expect(actionNeedsCompletedOnboarding("checkSubmissionResult")).toBe(false);
    expect(actionNeedsCompletedOnboarding("draft")).toBe(true);
    expect(actionNeedsCompletedOnboarding("startBrowser")).toBe(true);
  });
});
