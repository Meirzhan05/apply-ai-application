import { tasks } from "@trigger.dev/sdk";
import type { discoverUserJobs } from "../../trigger/personal-search";
import { randomUUID } from "node:crypto";
import { loadState, mutateState, isDemo } from "@/lib/repository";
import { withAccountOperation } from "@/lib/account-lifecycle";
import { personalSearchReadiness } from "@/lib/personal-search-policy";
import { personalSearchKey } from "@/lib/personal-search-input";
import { discoverPersonalJobs } from "@/lib/personal-search-provider";
import { reserveServiceBudget } from "@/lib/budget";
import { recordDiscoveryRefresh } from "@/lib/discovery";
import { importedPosting, refreshImportedJobs } from "@/lib/import-jobs";
import { dedupeJobs } from "@/lib/sources";
import { queueMatchAssessment } from "@/lib/match-queue";
import type { AppState } from "@/lib/types";
import { isResumeOnboardingComplete } from "@/lib/onboarding-gate";

const refreshMs = 4 * 60 * 60 * 1000;
const activeMs = 15 * 60 * 1000;
const currentRequest = (state: AppState, requestId: string) => state.personalSearch?.requestId === requestId && isResumeOnboardingComplete(state.profile) && personalSearchReadiness(state.profile).ready && state.personalSearch.profileKey === personalSearchKey(state.profile);

export async function queuePersonalSearch(userId: string, scheduled = false): Promise<boolean> {
  if (isDemo()) return false;
  const state = await loadState(userId);
  if (!isResumeOnboardingComplete(state.profile) || !personalSearchReadiness(state.profile).ready) return false;
  const profileKey = personalSearchKey(state.profile);
  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  const queued = await mutateState(userId, (current) => {
    if (!isResumeOnboardingComplete(current.profile) || !personalSearchReadiness(current.profile).ready || personalSearchKey(current.profile) !== profileKey) return false;
    const previous = current.personalSearch;
    if (previous?.profileKey === profileKey) {
      const age = Date.now() - Date.parse(previous.requestedAt);
      if ((previous.status === "queued" || previous.status === "searching") && age < activeMs) return false;
      if (previous.status !== "queued" && previous.status !== "searching" && (!scheduled || age < refreshMs)) return false;
    }
    current.personalSearch = { status: "queued", requestId, requestedAt, profileKey,
      jobs: previous?.jobs ?? [], resultsKey: previous?.resultsKey };
    return true;
  });
  if (!queued) return false;
  try {
    if (!process.env.TRIGGER_SECRET_KEY || !process.env.OPENAI_API_KEY) throw new Error("Search service is unavailable.");
    await withAccountOperation(userId, "dispatch", () => tasks.trigger<typeof discoverUserJobs>("discover-user-jobs", { userId, requestId }, {
      concurrencyKey: userId, tags: [`owner:${userId}`], idempotencyKey: `personal-search:${userId}:${requestId}`,
    }), `search:${requestId}`);
    return true;
  } catch {
    await mutateState(userId, (current) => {
      if (current.personalSearch?.requestId === requestId) current.personalSearch.status = "failed";
    });
    if (scheduled) throw new Error("Personal search dispatch failed.");
    return false;
  }
}

export async function runPersonalSearch(userId: string, requestId: string) {
  const beforeClaim = await loadState(userId);
  if (!isResumeOnboardingComplete(beforeClaim.profile)) return { stopped: "onboarding_incomplete" };
  const claimed = await mutateState(userId, (state) => {
    if (!currentRequest(state, requestId) || state.personalSearch?.status !== "queued") return false;
    state.personalSearch.status = "searching"; return true;
  });
  if (!claimed) return { stopped: "stale_or_duplicate" };
  try {
    const state = await loadState(userId);
    // Hold a conservative allowance for at most two web searches plus tokens.
    if (!await reserveServiceBudget(userId, `personal-search:${requestId}`, 0.08)) {
      await mutateState(userId, (current) => {
        if (currentRequest(current, requestId)) current.personalSearch!.status = "budget_limited";
      });
      return { stopped: "budget_limited" };
    }
    const before = state.personalSearch?.jobs ?? [];
    const selected = [...state.feedback.flatMap((item) => item.posting ? [item.posting] : []), ...state.applications.flatMap((item) => item.jobSnapshot ? [item.jobSnapshot] : [])];
    const monitored = dedupeJobs([...before, ...selected]).filter((job) => { try { return Boolean(importedPosting(job.importUrl ?? job.url)); } catch { return false; } });
    const refreshed = monitored.length ? await refreshImportedJobs(monitored) : [];
    const jobs = await discoverPersonalJobs(state.profile, async () => {
      const latest = await loadState(userId);
      if (!currentRequest(latest, requestId) || latest.personalSearch?.status !== "searching") throw new Error("Search profile changed.");
    });
    const published = await mutateState(userId, (current) => {
      if (!currentRequest(current, requestId)) return false;
      const search = current.personalSearch!;
      const previous = new Map(search.jobs.map((job) => [job.id, job]));
      const freshIds = new Set(jobs.map((job) => job.id));
      // Preserve private posting history with current availability, including
      // selected roles that the new web search did not return.
      search.jobs = [...jobs.map((job) => ({ ...job, discoveredAt: previous.get(job.id)?.discoveredAt ?? job.discoveredAt })),
        ...refreshed.filter((job) => !freshIds.has(job.id) && (search.resultsKey === search.profileKey || selected.some((item) => item.id === job.id)))].slice(0, 200);
      const updates = new Map([...refreshed, ...search.jobs].map((job) => [job.id, job]));
      current.feedback = current.feedback.map((item) => ({ ...item, posting: updates.get(item.jobId) ?? item.posting }));
      search.resultsKey = search.profileKey; search.status = "complete";
      search.completedAt = new Date().toISOString(); current.lastRefreshAt = search.completedAt;
      current.matchCache = {};
      // Do not retain telemetry copied from the former shared catalog.
      if (!state.personalSearch?.resultsKey) current.discovery = { sources: [], events: [] };
      recordDiscoveryRefresh(current, { refreshedAt: search.completedAt, sourceStatus: [],
        arrivals: search.jobs.filter((job) => !previous.has(job.id)).map((job) => ({ jobId: job.id, source: job.source, discoveredAt: job.discoveredAt })) });
      return true;
    });
    if (published) await queueMatchAssessment(userId);
    return { discovered: published ? jobs.length : 0, stale: !published };
  } catch {
    await mutateState(userId, (current) => {
      if (currentRequest(current, requestId) && current.personalSearch?.status === "searching") current.personalSearch.status = "failed";
    });
    return { stopped: "search_failed" };
  }
}
