import { isUsableFact } from "../src/lib/fact-evidence";
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
import { withAccountOperation } from "../src/lib/account-lifecycle";

class MatchingContextChanged extends Error {
  constructor(readonly reason: "profile_changed" | "authorization_changed" | "job_closed" | "job_changed" | "controlled_scope_changed") {
    super(reason);
  }
}

function authorizationContext(profile: Awaited<ReturnType<typeof loadState>>["profile"]): string {
  return JSON.stringify({
    status: profile.automationAuthorization?.status ?? null,
    version: profile.automationAuthorization?.version ?? null,
    facts: profile.facts.map((fact) => ({ id: fact.id, text: fact.text, verified: isUsableFact(fact) })),
  });
}

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
  run: async ({ userId, continuationToken }: { userId: string; continuationToken?: string }, options) => withAccountOperation(userId, "worker", async () => {
    const runId = options?.ctx.run.id ?? newId();
    if (!process.env.TYPESAFE_API_KEY) return { assessed: 0 };
    const state = await loadState(userId);
    if (!state.profile.facts.some(isUsableFact)) return { assessed: 0 };
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
    const initialAuthorizationContext = authorizationContext(state.profile);
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
      let assessment;
      try {
        assessment = await withModelUsageContext({ userId, runId, jobId: job.id, backgroundJobId: `matching:${job.id}` }, () => assessMatch(state.profile, job, {
          // This runs after the usage ledger's started record is persisted and
          // immediately before the provider request. Keep the recommendation
          // matcher available for profiles that were already paused, while
          // stopping a pause/revocation or posting change that arrived during
          // this paid operation's setup.
          beforeModelCall: async () => {
            const current = await loadState(userId);
            if (current.profile.updatedAt !== profileVersion || authorizationContext(current.profile) !== initialAuthorizationContext)
              throw new MatchingContextChanged(current.profile.updatedAt !== profileVersion ? "profile_changed" : "authorization_changed");
            const currentJob = current.jobs.find((item) => item.id === job.id);
            if (!currentJob?.active) throw new MatchingContextChanged("job_closed");
            if (matchKey(current.profile, currentJob) !== matchKey(state.profile, job))
              throw new MatchingContextChanged("job_changed");
            if (!controlledFixtureAllowsJob(current, userId, currentJob))
              throw new MatchingContextChanged("controlled_scope_changed");
          },
        }));
      } catch (error) {
        if (error instanceof MatchingContextChanged) return { assessed, stopped: error.reason };
        throw error;
      }
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
  }, options?.ctx.run.id),
});
