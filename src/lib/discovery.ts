import { newId } from "@/lib/crypto";
import { assertAutomationEnabled, assertAutonomous, authorizeKnownAnswerApplication } from "@/lib/autonomous-policy";
import { explicitConflict, requiredRuleUncertainty } from "@/lib/matching";
import { matchKey } from "@/lib/match-cache";
import { canonicalJobUrl } from "@/lib/sources";
import { loadState, mutateState } from "@/lib/repository";
import { selectApplication } from "@/lib/workflow";
import { controlledFixtureAllowsJob } from "@/lib/controlled-tests";
import type { AppState, DiscoveryEvent, DiscoverySource, DiscoveryState, Job, MatchAssessment, Profile } from "@/lib/types";

export interface DiscoveryArrival {
  jobId: string;
  source: string;
  discoveredAt: string;
}

export interface DiscoveryRefreshReport {
  refreshedAt: string;
  sourceStatus: DiscoverySource[];
  arrivals: DiscoveryArrival[];
}

function discoveryState(state: AppState): DiscoveryState {
  state.discovery ??= { sources: [], events: [] };
  state.discovery.sources ??= [];
  state.discovery.events ??= [];
  return state.discovery;
}

export function appendDiscoveryEvent(state: AppState, event: Omit<DiscoveryEvent, "id"> & { id?: string }): void {
  const discovery = discoveryState(state);
  const id = event.id ?? newId();
  // Refresh retries and serialized queue replays are expected. A stable event
  // id lets those retries remain observable without duplicating a transition.
  if (discovery.events.some((current) => current.id === id)) return;
  discovery.events.push({ ...event, id });
}

export function recordDiscoveryRefresh(state: AppState, report: DiscoveryRefreshReport): void {
  const discovery = discoveryState(state);
  discovery.lastRefreshAt = report.refreshedAt;
  discovery.sources = report.sourceStatus.map((source) => ({ ...source }));
  for (const source of report.sourceStatus) {
    if (source.status === "unavailable") appendDiscoveryEvent(state, {
      id: `unavailable:${source.source}:${source.checkedAt}`,
      kind: "unavailable",
      source: source.source,
      at: source.checkedAt,
      detail: source.error ? `Source unavailable: ${source.error}` : "Source unavailable.",
    });
  }
  for (const arrival of report.arrivals) {
    const delayMs = Math.max(0, Date.parse(report.refreshedAt) - Date.parse(arrival.discoveredAt));
    appendDiscoveryEvent(state, {
      id: `arrived:${arrival.jobId}:${arrival.discoveredAt}`,
      kind: "arrived",
      jobId: arrival.jobId,
      source: arrival.source,
      at: report.refreshedAt,
      arrivalAt: arrival.discoveredAt,
      delayMs,
      detail: "New public listing discovered.",
    });
  }
}

export function autonomousMatchBlockReason(profile: Profile, job: Job, assessment: MatchAssessment): string | null {
  if (!job.active) return "This listing is closed.";
  const conflict = explicitConflict(profile, job);
  if (conflict) return conflict;
  if (assessment.category !== "strong") return "Only strong matches can be queued automatically.";
  if (!assessment.evidence.length) return "A strong match requires grounded evidence.";
  const ruleUncertainty = requiredRuleUncertainty(profile, job);
  if (ruleUncertainty.length) return ruleUncertainty[0];
  return null;
}

export interface EnqueueStrongMatchResult {
  queued: boolean;
  applicationId?: string;
  reason?: "profile_changed" | "automation_blocked" | "job_unavailable" | "match_unavailable" | "duplicate" | "ineligible";
}

export async function enqueueStrongMatch(
  userId: string,
  jobId: string,
  expectedProfileUpdatedAt: string,
  options: { cacheKey?: string } = {},
): Promise<EnqueueStrongMatchResult> {
  let result: EnqueueStrongMatchResult = { queued: false, reason: "match_unavailable" };
  try {
    result = await mutateState(userId, (state) => {
      if (state.profile.updatedAt !== expectedProfileUpdatedAt) return { queued: false, reason: "profile_changed" as const };
      try {
        assertAutomationEnabled(state.profile);
      } catch {
        return { queued: false, reason: "automation_blocked" as const };
      }
      const job = state.jobs.find((item) => item.id === jobId);
      if (!job?.active) return { queued: false, reason: "job_unavailable" as const };
      if (!controlledFixtureAllowsJob(state, userId, job)) return { queued: false, reason: "ineligible" as const };
      const key = options.cacheKey ?? matchKey(state.profile, job);
      const assessment = state.matchCache?.[key];
      if (!assessment) return { queued: false, reason: "match_unavailable" as const };
      if (autonomousMatchBlockReason(state.profile, job, assessment)) return { queued: false, reason: "ineligible" as const };
      const existing = state.applications.find((application) => application.userId === userId && (application.jobId === job.id || canonicalJobUrl(application.jobSnapshot?.url || "") === canonicalJobUrl(job.url)));
      let application = existing;
      if (application) {
        if (application.status === "cancelled") return { queued: false, reason: "duplicate" as const };
        if (!application.autonomousAuthorization) return { queued: false, reason: "duplicate" as const };
        if (application.queuedRun || application.runToken || application.status !== "selected") return { queued: false, reason: "duplicate" as const };
        // Continue the original authorized posting identity when a refresh
        // supplies an alias URL. The canonical duplicate check prevents a
        // second application without silently rebinding the first one.
        const originalJob = state.jobs.find((item) => item.id === application!.jobId) ?? application.jobSnapshot;
        assertAutonomous(application, state.profile, originalJob, "draft");
      } else {
        application = selectApplication(state, job.id, userId);
        authorizeKnownAnswerApplication(application, state.profile, job);
      }
      const requestedAt = new Date().toISOString();
      application.queuedRun = { id: newId(), kind: "draft", requestedAt, reason: "waiting" };
      application.error = undefined;
      const arrival = state.discovery?.events.slice().reverse().find((event) => event.kind === "arrived" && event.jobId === job.id);
      appendDiscoveryEvent(state, {
        id: `queued:${application.id}:${application.queuedRun.id}`,
        kind: "queued",
        jobId: job.id,
        source: job.source,
        at: requestedAt,
        arrivalAt: arrival?.arrivalAt,
        delayMs: arrival?.arrivalAt ? Math.max(0, Date.parse(requestedAt) - Date.parse(arrival.arrivalAt)) : undefined,
        detail: "Strong match queued for the authorized application workflow.",
      });
      return { queued: true, applicationId: application.id };
    });
  } catch (error) {
    // A policy change between the CAS read and authorization is a normal skip;
    // other failures should remain visible to the worker for retry/alerting.
    if (error instanceof Error && /enable your current automation|authorization changed|listing is no longer available|closed/i.test(error.message)) return { queued: false, reason: "automation_blocked" };
    throw error;
  }
  if (result.queued) await (await import("@/lib/application-queue")).dispatchUserQueue(userId);
  return result;
}

export async function discoveryStateForUser(userId: string): Promise<DiscoveryState | undefined> {
  return (await loadState(userId)).discovery;
}
