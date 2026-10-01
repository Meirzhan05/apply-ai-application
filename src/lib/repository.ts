import { initialDemoState } from "@/lib/demo-data";
import { readState, updateState } from "@/lib/store";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import type { AppState, Job } from "@/lib/types";
import { readActiveCatalogRows } from "@/lib/catalog";
import { dedupeJobs } from "@/lib/sources";
import { preparePilotMutation, type PilotMutationContext } from "@/lib/pilot";

export { isDemo } from "@/lib/demo-mode";

export async function currentUserId(): Promise<string> {
  if (isDemo()) return "demo-user";
  const { serverSupabase } = await import("@/lib/supabase");
  const client = await serverSupabase();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error("AUTH_REQUIRED");
  const allowed = (process.env.BETA_ALLOWED_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && allowed.length === 0) throw new Error("PRIVATE_BETA_NOT_CONFIGURED");
  if (allowed.length && !allowed.includes(data.user.email?.toLowerCase() || "")) throw new Error("This private beta account has not been invited yet.");
  return data.user.id;
}

async function catalog(): Promise<Job[]> {
  const rows = await readActiveCatalogRows();
  return rows.sort((a, b) => b.discovered_at.localeCompare(a.discovered_at) || a.id.localeCompare(b.id)).map((row) => row.data);
}

export async function loadState(userId: string): Promise<AppState> {
  if (isDemo()) return readState();
  const client = adminSupabase();
  const [{ data, error }, jobs] = await Promise.all([
    client
      .from("app_states")
      .select("data")
      .eq("user_id", userId)
      .maybeSingle(),
    catalog(),
  ]);
  if (error) throw error;
  return composeState(userId, data?.data as Partial<AppState> | undefined, jobs);
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
  defaults.jobs = jobs;
  defaults.lastRefreshAt = jobs.map((job) => job.lastCheckedAt || job.discoveredAt).sort().at(-1);
  defaults.activity = [];
  const combined = [...(stored?.importedJobs ?? []), ...jobs];
  const ids = new Set(combined.map((job) => job.id));
  for (const app of stored?.applications ?? [])
    if (app.jobSnapshot && !ids.has(app.jobSnapshot.id)) {
      combined.push({ ...app.jobSnapshot, active: false });
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
    const state = composeState(userId, current?.data as Partial<AppState> | undefined, await catalog());
    const previous = structuredClone(state);
    const result = await change(state);
    preparePilotMutation(previous, state, context);
    const saved: Partial<AppState> = { ...state };
    delete saved.jobs;
    if (current) {
      const { data, error } = await client
        .from("app_states")
        .update({
          data: saved,
          revision: current.revision + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("revision", current.revision)
        .select("revision");
      if (error) throw error;
      if (data && data.length > 0) return result;
    } else {
      const { error } = await client
        .from("app_states")
        .insert({ user_id: userId, data: saved, revision: 1 });
      if (!error) return result;
      if (error.code !== "23505") throw error;
    }
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
