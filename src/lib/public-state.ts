import { assessMatchLocally } from "@/lib/matching";
import { matchKey } from "@/lib/match-cache";
import { automationStatus, onboardingCompleteness } from "@/lib/onboarding";
import { packetProfileHash } from "@/lib/packet-profile";
import type { AppState } from "@/lib/types";

export function publicState(state: AppState) {
  const profileHash = packetProfileHash(state.profile);
  return {
    ...state,
    onboarding: onboardingCompleteness(state.profile),
    automation: automationStatus(state.profile),
    applications: state.applications.map((application) => {
      const safe = { ...application };
      delete safe.browserConnectUrl;
      delete safe.controlledTest;
      return { ...safe, materialsStale: Boolean(application.packet?.profileHash && application.packet.profileHash !== profileHash) };
    }),
    matches: state.jobs
      .filter((job) => job.active)
      .map((job) => {
        const currentRules = assessMatchLocally(state.profile, job);
        return { jobId: job.id, assessment: currentRules.category === "excluded" ? currentRules :
          state.matchCache?.[matchKey(state.profile, job)] ?? currentRules };
      }),
  };
}
