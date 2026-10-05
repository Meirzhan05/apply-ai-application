import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { Profile } from "@/lib/types";
import { completeOnboardingFixture } from "@/lib/testing/onboarding";
import { finishResumeOnboarding, resumeOnboardingStatus } from "@/lib/onboarding-completion";
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

  it.each(["queued", "extracting", "checking", "failed", "budget_limited"] as const)("keeps completed setup accessible while its same-source recovery is %s", status => {
    const profile = completeProfile();
    profile.resumeExtraction = { id: "recovery", status, filename: profile.resumeFileName!, attempts: 1, requestedAt: "2026-01-01", updatedAt: "2026-01-01",
      pending: { source: profile.resumeSource!, document: profile.resumeSourceDocument!, onboardingImport: { token: "recovery", reused: true,
        baseline: { name: profile.name, phone: profile.phone } } } };
    expect(isResumeOnboardingComplete(profile)).toBe(true);
    expect(resumeOnboardingStatus(profile).missing).not.toContain("resumeExtraction");
    profile.resumeExtraction.pending!.source = { ...profile.resumeSource!, sha256: "different-resume" };
    expect(isResumeOnboardingComplete(profile)).toBe(false);
    profile.resumeExtraction.pending!.source = profile.resumeSource!;
    profile.resumeImport = { token: "replacement-import", startedAt: "2026-01-01" };
    expect(isResumeOnboardingComplete(profile)).toBe(false);
  });

  it("keeps reviewed setup accessible during the saved-source read, but not for an unrelated import", () => {
    const profile = completeProfile();
    profile.resumeImport = { token: "recovery", startedAt: "2026-01-01", reusedSourceHash: profile.resumeSource!.sha256 };
    expect(isResumeOnboardingComplete(profile)).toBe(true);
    profile.resumeImport.reusedSourceHash = "different-resume";
    expect(isResumeOnboardingComplete(profile)).toBe(false);
  });

  it("does not let same-source recovery bypass missing required answers or initial completion", () => {
    const profile = completeProfile();
    profile.resumeImport = { token: "recovery", startedAt: "2026-01-01", reusedSourceHash: profile.resumeSource!.sha256 };
    profile.phone = "";
    expect(isResumeOnboardingComplete(profile)).toBe(false);
    profile.phone = "+1 212 555 0100";
    delete profile.onboarding!.completedAt;
    expect(isResumeOnboardingComplete(profile)).toBe(false);
  });

  it("keeps saved profile, resume and outcome recovery actions available", () => {
    expect(actionNeedsCompletedOnboarding("onboardingDraft")).toBe(false);
    expect(actionNeedsCompletedOnboarding("profile")).toBe(false);
    expect(actionNeedsCompletedOnboarding("savedProfileAnswer")).toBe(false);
    expect(actionNeedsCompletedOnboarding("checkSubmissionResult")).toBe(false);
    expect(actionNeedsCompletedOnboarding("reviewForm")).toBe(false);
    expect(actionNeedsCompletedOnboarding("select")).toBe(true);
    expect(actionNeedsCompletedOnboarding("futureUnknownAction")).toBe(true);
    expect(actionNeedsCompletedOnboarding("draft")).toBe(true);
    expect(actionNeedsCompletedOnboarding("startBrowser")).toBe(true);
  });

  it.each(["queued", "extracting", "checking", "failed", "budget_limited"] as const)("does not admit a previously completed profile while extraction is %s", status => {
    const profile = completeProfile();
    profile.resumeExtraction = { id: "replacement", status, filename: "resume.docx", attempts: 1, requestedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const review = resumeOnboardingStatus(profile);
    expect(review.missing).toContain("resumeExtraction");
    expect(isResumeOnboardingComplete(profile)).toBe(false);
    expect(() => finishResumeOnboarding(profile, review.reviewHash)).toThrow(/required information/);
  });

  it("requires the application contact email when a resume explicitly has none, preserving the account email", () => {
    const profile = completeProfile();
    expect(profile.email).toBeTruthy();
    profile.contactEmail = "";
    expect(resumeOnboardingStatus(profile).missing).toContain("email");
    profile.contactEmail = "applicant@example.com";
    expect(resumeOnboardingStatus(profile).missing).not.toContain("email");
  });
});
