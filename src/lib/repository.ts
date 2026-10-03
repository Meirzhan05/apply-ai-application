import { initialDemoState } from "@/lib/demo-data";
import { readState, updateState } from "@/lib/store";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import type { AppState, Job } from "@/lib/types";
import { personalSearchReadiness } from "@/lib/personal-search-policy";
import { personalSearchKey } from "@/lib/personal-search-input";
import { dedupeJobs } from "@/lib/sources";
import { preparePilotMutation, type PilotMutationContext } from "@/lib/pilot";
import { AccountDeletionInProgressError } from "@/lib/account-lifecycle";

export { isDemo } from "@/lib/demo-mode";

export async function currentUserId(): Promise<string> {
  if (isDemo()) return "demo-user";
  const { serverSupabase } = await import("@/lib/supabase");
  const client = await serverSupabase();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  return data.user.id;
}

// Only retrieve legacy postings that this owner explicitly saved or dismissed.
// An empty account never reads the shared catalog.
async function legacyPostings(stored: Partial<AppState> | undefined): Promise<Job[]> {
  const ids = (stored?.feedback ?? []).filter((item) => !item.posting).map((item) => item.jobId);
  if (!ids.length) return [];
  const jobs: Job[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const { data, error } = await adminSupabase().from("jobs").select("data").in("id", ids.slice(offset, offset + 100));
    if (error) throw error;
    jobs.push(...(data ?? []).map((row) => row.data as Job));
  }
  return jobs;
}

export async function loadState(userId: string): Promise<AppState> {
  if (isDemo()) return readState();
  const { data, error } = await adminSupabase().from("app_states").select("data").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  const stored = data?.data as Partial<AppState> | undefined;
  return composeState(userId, stored, await legacyPostings(stored));
}

function composeState(userId: string, stored: Partial<AppState> | undefined, jobs: Job[]): AppState {
  const defaults = initialDemoState();
  defaults.profile = {
    ...defaults.profile,
    id: userId,
    name: "",
    email: "",
    phone: "",
    school: "",
    graduationYear: "",
    headline: "",
    workAuthorization: "Unspecified",
    facts: [],
    skills: [],
    preferredTitles: [],
    preferredLocations: [],
    demo: false,
  };
  defaults.jobs = [];
  defaults.lastRefreshAt = undefined;
  defaults.activity = [];
  const profile = stored?.profile ?? defaults.profile;
  const personal = stored?.personalSearch;
  const discovered = personalSearchReadiness(profile).ready && personal?.resultsKey === personalSearchKey(profile) ? personal.jobs : [];
  const retained = (stored?.feedback ?? []).flatMap((item) => item.posting ? [item.posting] : []);
  const combined = [...(stored?.importedJobs ?? []), ...discovered, ...retained, ...jobs];
  const ids = new Set(combined.map((job) => job.id));
  for (const app of stored?.applications ?? [])
    if (app.jobSnapshot && !ids.has(app.jobSnapshot.id)) {
      combined.push({ ...app.jobSnapshot });
      ids.add(app.jobSnapshot.id);
    }
  // Keep an application's original posting identity available even if a
  // second source points to the same URL. Deduplicate the discovery list
  // without changing the availability of an already selected posting.
  const selectedIds = new Set((stored?.applications ?? []).map((app) => app.jobId));
  const prioritized = [...combined.filter((job) => selectedIds.has(job.id)), ...combined.filter((job) => !selectedIds.has(job.id))];
  const visible = dedupeJobs(prioritized);
  const visibleIds = new Set(visible.map((job) => job.id));
  for (const job of combined) if (selectedIds.has(job.id) && !visibleIds.has(job.id)) { visible.push(job); visibleIds.add(job.id); }
  return { ...defaults, ...stored, jobs: visible };
}

export async function mutateState<T>(
  userId: string,
  change: (state: AppState) => T | Promise<T>,
  context?: PilotMutationContext,
): Promise<T> {
  if (isDemo()) return updateState(change, context);
  const client = adminSupabase();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: current, error: readError } = await client
      .from("app_states")
      .select("data,revision")
      .eq("user_id", userId)
      .maybeSingle();
    if (readError) throw readError;
    const stored = current?.data as Partial<AppState> | undefined;
    const state = composeState(userId, stored, await legacyPostings(stored));
    const previous = structuredClone(state);
    const result = await change(state);
    preparePilotMutation(previous, state, context);
    const saved: Partial<AppState> = { ...state };
    delete saved.jobs;
    // Migrate only owner-selected legacy records, never the rest of the catalog.
    saved.feedback = state.feedback.map((item) => ({ ...item, posting: item.posting ?? state.jobs.find((job) => job.id === item.jobId) }));
    const { data: revision, error } = await client.rpc("save_account_state", {
      p_owner_id: userId,
      p_expected_revision: current?.revision ?? null,
      p_data: saved,
    });
    if (error) {
      if (error.message.includes("ACCOUNT_DELETION_IN_PROGRESS")) throw new AccountDeletionInProgressError();
      throw error;
    }
    if (revision !== null) return result;
  }
  throw new Error("The application changed concurrently. Please retry.");
}

export async function saveCatalog(jobs: Job[]): Promise<void> {
  if (isDemo()) {
    await updateState((state) => {
      const existing = new Map(state.jobs.map((job) => [job.id, job]));
      const checkedAt = new Date().toISOString();
      jobs.forEach((job) => existing.set(job.id, { ...job, discoveredAt: existing.get(job.id)?.discoveredAt ?? job.discoveredAt, lastCheckedAt: checkedAt }));
      state.jobs = [...existing.values()];
      state.lastRefreshAt = new Date().toISOString();
    });
    return;
  }
  if (jobs.length === 0) return;
  const client = adminSupabase();
  const chunks: Job[][] = [];
  for (let offset = 0; offset < jobs.length; offset += 100) chunks.push(jobs.slice(offset, offset + 100));
  // PostgREST puts .in() values in the URL. Bound each query so a real board
  // catalog cannot exceed the gateway's request-line limit.
  for (const chunk of chunks) {
    const { data: previous, error: previousError } = await client.from("jobs").select("id,discovered_at").in("id", chunk.map((job) => job.id));
    if (previousError) throw previousError;
    const discovered = new Map((previous ?? []).map((row) => [row.id, row.discovered_at]));
    const { error } = await client.from("jobs").upsert(
    chunk.map((job) => ({
      id: job.id,
      source: job.source,
      source_id: job.sourceId,
      active: job.active,
      discovered_at: discovered.get(job.id) ?? job.discoveredAt,
      data: { ...job, discoveredAt: discovered.get(job.id) ?? job.discoveredAt, lastCheckedAt: new Date().toISOString() },
    })),
    { onConflict: "id" },
  );
    if (error) throw error;
  }
}
