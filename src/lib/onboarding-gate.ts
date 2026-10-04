import { resumeOnboardingStatus } from "@/lib/onboarding-completion";
import type { Profile } from "@/lib/types";

export const ONBOARDING_REQUIRED_ERROR =
  "Complete the required onboarding before starting matching or preparing an application.";

/** The server-side prerequisite for every new matching/application initiation. */
export function isResumeOnboardingComplete(profile: Profile): boolean {
  return resumeOnboardingStatus(profile).complete;
}

export function assertResumeOnboardingComplete(profile: Profile, operation = "starting this operation"): void {
  const status = resumeOnboardingStatus(profile);
  if (status.complete) return;
  const details = status.missing.length ? ` Missing: ${status.missing.join(", ")}.` : "";
  throw new Error(`${ONBOARDING_REQUIRED_ERROR} (${operation}).${details}`);
}

/**
 * These actions only inspect, cancel, or recover already-started work. They
 * remain available while onboarding is incomplete so an interrupted attempt
 * can reach a deterministic outcome without authorizing another submission.
 */
export const onboardingSafeActions = new Set([
  "enrollPilot",
  "withdrawPilot",
  "onboarding",
  "onboardingDraft",
  "finishOnboarding",
  "profile",
  "automationSettings",
  "pauseAutomation",
  "pause",
  "feedback",
  "labelMatch",
  "timeSaved",
  "import",
  "select",
  "checkSubmissionResult",
  "stopSubmissionVerification",
  "cancel",
  "reviewManualFailure",
  "restartBrowser",
]);

export function actionNeedsCompletedOnboarding(action: string): boolean {
  return !onboardingSafeActions.has(action);
}
