import { assessMatchLocally, jobDestinationConflict } from "@/lib/matching";
import { importedAutonomyJob } from "@/lib/import-compatibility";
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
      const job = state.jobs.find((item) => item.id === application.jobId) ?? application.jobSnapshot;
      const destinationIssue = job ? jobDestinationConflict(importedAutonomyJob(application, job)) ??
        (application.packet && application.jobSnapshot && application.jobSnapshot.location !== job.location ? "The job destination changed. Prepare and review new application materials before filling." : null) : null;
      return { ...safe, destinationIssue, materialsStale: Boolean(application.packet?.profileHash && application.packet.profileHash !== profileHash) || Boolean(application.packet && destinationIssue) };
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
