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
export const onboardingSafeActions = [
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
  "checkSubmissionResult",
  "stopSubmissionVerification",
  "cancel",
  "reviewManualFailure",
  "restartBrowser",
 ] as const;
export type OnboardingSafeAction = typeof onboardingSafeActions[number];
const onboardingSafeActionSet: ReadonlySet<OnboardingSafeAction> = new Set(onboardingSafeActions);

export function isOnboardingSafeAction(action: string): action is OnboardingSafeAction {
  return onboardingSafeActionSet.has(action as OnboardingSafeAction);
}

export function actionNeedsCompletedOnboarding(action: string): boolean {
  // Unknown actions fail closed until they are explicitly classified above.
  return !isOnboardingSafeAction(action);
}
