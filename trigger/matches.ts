import { withModelUsageContext } from "../src/lib/model-usage";
import { newId } from "../src/lib/crypto";
import { task } from "@trigger.dev/sdk";
import { reserveServiceBudget } from "../src/lib/budget";
import { assessMatch, assessMatchLocally } from "../src/lib/matching";
import { matchKey, matchReservationId } from "../src/lib/match-cache";
import { loadState, mutateState } from "../src/lib/repository";
import { appendDiscoveryEvent, enqueueStrongMatch } from "../src/lib/discovery";
import { queueMatchAssessment } from "../src/lib/match-queue";
import { controlledFixtureAllowsJob } from "../src/lib/controlled-tests";

function pendingJobs(state: Awaited<ReturnType<typeof loadState>>) {
  return state.jobs
    .filter((job) => job.active && controlledFixtureAllowsJob(state, state.profile.id, job) && !state.matchCache?.[matchKey(state.profile, job)] && assessMatchLocally(state.profile, job).category !== "excluded")
    .sort((a, b) => assessMatchLocally(state.profile, b).score - assessMatchLocally(state.profile, a).score);
}

export const assessUserMatches = task({
  id: "assess-user-matches",
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  maxDuration: 300,
  run: async ({ userId, continuationToken }: { userId: string; continuationToken?: string }, options) => {
    const runId = options?.ctx.run.id ?? newId();
    if (!process.env.OPENAI_API_KEY) return { assessed: 0 };
    const state = await loadState(userId);
    if (!state.profile.facts.some((fact) => fact.verified)) return { assessed: 0 };
    if (continuationToken) {
      const marker = state.discovery?.matchContinuation;
      if (!marker || marker.token !== continuationToken || marker.profileUpdatedAt !== state.profile.updatedAt)
        return { assessed: 0, stopped: "stale_continuation" };
      await mutateState(userId, (current) => {
        if (current.discovery?.matchContinuation?.token === continuationToken)
          current.discovery.matchContinuation = undefined;
      });
    }
    const profileVersion = state.profile.updatedAt;
    const pending = pendingJobs(state).slice(0, 12);
    let assessed = 0;
    let budgetExhausted = false;
    for (const job of pending) {
      const latest = await loadState(userId);
      if (latest.profile.updatedAt !== profileVersion)
        return { assessed, stopped: "profile_changed" };
      const allowed = await reserveServiceBudget(
        userId,
        matchReservationId(state.profile, job),
        0.005,
      );
      if (!allowed) { budgetExhausted = true; break; }
      const assessment = await withModelUsageContext({ userId, runId, jobId: job.id, backgroundJobId: `matching:${job.id}` }, () => assessMatch(state.profile, job));
      try {
        const saved = await mutateState(userId, (current) => {
          if (current.profile.updatedAt !== profileVersion) return false;
          current.matchCache ??= {};
          for (const key of Object.keys(current.matchCache))
            if (key.startsWith(`${job.id}:`)) delete current.matchCache[key];
          current.matchCache[matchKey(current.profile, job)] = assessment;
          appendDiscoveryEvent(current, {
            id: `matched:${job.id}:${assessment.evaluatedAt}:${profileVersion}`,
            kind: "matched",
            jobId: job.id,
            source: job.source,
            at: assessment.evaluatedAt,
            arrivalAt: job.discoveredAt,
            delayMs: Math.max(0, Date.parse(assessment.evaluatedAt) - Date.parse(job.discoveredAt)),
            detail: assessment.category === "strong" ? "Strong match found from confirmed facts." : `Match assessed as ${assessment.category}.`,
          });
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
      if (assessment.category === "strong") await enqueueStrongMatch(userId, job.id, profileVersion);
    }
    const latest = await loadState(userId);
    if (latest.profile.updatedAt !== profileVersion) return { assessed, stopped: "profile_changed" };
    const remaining = pendingJobs(latest).length;
    if (remaining > 0 && !budgetExhausted) {
      const continuationToken = newId();
      const persisted = await mutateState(userId, (current) => {
        if (current.profile.updatedAt !== profileVersion) return false;
        current.discovery ??= { sources: [], events: [] };
        current.discovery.pendingMatches = pendingJobs(current).length;
        current.discovery.matchContinuation = { token: continuationToken, profileUpdatedAt: profileVersion, requestedAt: new Date().toISOString() };
        return true;
      });
      if (persisted) {
        await queueMatchAssessment(userId, continuationToken);
        return { assessed, continued: true, pending: remaining };
      }
      return { assessed, stopped: "profile_changed" };
    }
    await mutateState(userId, (current) => {
      if (current.profile.updatedAt === profileVersion && current.discovery) {
        current.discovery.pendingMatches = remaining;
        current.discovery.matchContinuation = undefined;
      }
    });
    return { assessed };
  },
});
