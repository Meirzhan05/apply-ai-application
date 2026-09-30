import { assessMatchLocally } from "@/lib/matching";
import { matchKey } from "@/lib/match-cache";
import type { AppState } from "@/lib/types";

export function publicState(state: AppState) {
  return {
    ...state,
    applications: state.applications.map((application) => {
      const safe = { ...application };
      delete safe.browserConnectUrl;
      delete safe.controlledTest;
      return safe;
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
