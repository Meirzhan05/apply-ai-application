import { withModelUsageContext } from "../src/lib/model-usage";
import { newId } from "../src/lib/crypto";
import { task } from "@trigger.dev/sdk";
import { reserveServiceBudget } from "../src/lib/budget";
import { assessMatch, assessMatchLocally } from "../src/lib/matching";
import { matchKey, matchReservationId } from "../src/lib/match-cache";
import { loadState, mutateState } from "../src/lib/repository";

export const assessUserMatches = task({
  id: "assess-user-matches",
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  maxDuration: 300,
  run: async ({ userId }: { userId: string }, options) => {
    const runId = options?.ctx.run.id ?? newId();
    if (!process.env.OPENAI_API_KEY) return { assessed: 0 };
    const state = await loadState(userId);
    if (!state.profile.facts.some((fact) => fact.verified)) return { assessed: 0 };
    const profileVersion = state.profile.updatedAt;
    const pending = state.jobs
      .filter(
        (job) =>
          job.active &&
          !state.matchCache?.[matchKey(state.profile, job)] &&
          assessMatchLocally(state.profile, job).category !== "excluded",
      )
      .sort(
        (a, b) =>
          assessMatchLocally(state.profile, b).score -
          assessMatchLocally(state.profile, a).score,
      )
      .slice(0, 12);
    let assessed = 0;
    for (const job of pending) {
      const latest = await loadState(userId);
      if (latest.profile.updatedAt !== profileVersion)
        return { assessed, stopped: "profile_changed" };
      const allowed = await reserveServiceBudget(
        userId,
        matchReservationId(state.profile, job),
        0.005,
      );
      if (!allowed) break;
      const assessment = await withModelUsageContext({ userId, runId, jobId: job.id, backgroundJobId: `matching:${job.id}` }, () => assessMatch(state.profile, job));
      try {
        const saved = await mutateState(userId, (current) => {
          if (current.profile.updatedAt !== profileVersion) return false;
          current.matchCache ??= {};
          for (const key of Object.keys(current.matchCache))
            if (key.startsWith(`${job.id}:`)) delete current.matchCache[key];
          current.matchCache[matchKey(current.profile, job)] = assessment;
          return true;
        });
        if (!saved) return { assessed, stopped: "profile_changed" };
      } catch (error) {
        // Auth deletion cascades through app_states. An in-flight model call
        // must not recreate that owner's state or continue assessing jobs.
        if (error && typeof error === "object" && "code" in error &&
          error.code === "23503" && "message" in error &&
          typeof error.message === "string" &&
          error.message.includes('"app_states_user_id_fkey"'))
          return { assessed, stopped: "owner_removed" };
        throw error;
      }
      assessed++;
    }
    return { assessed };
  },
});
