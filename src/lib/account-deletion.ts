import { runs } from "@trigger.dev/sdk";
import { adminSupabase } from "@/lib/supabase-admin";
import { releaseRemoteBrowser } from "@/lib/browser-provider";
import { readBrowserUsage } from "@/lib/browser-usage";
import { pilotReportDigest, redactPilotReportOwner } from "@/lib/pilot-report";
import type { AppState, Application, PilotReportSnapshot } from "@/lib/types";
import { accountOperationLeases, beginAccountDeletion, releaseAccountOperation } from "@/lib/account-lifecycle";

const STORAGE_BUCKETS = ["resumes", "application-files", "form-shots"] as const;
const OWNER_TASKS = [
  "draft-application-packet",
  "fill-application-form",
  "submit-application-form",
  "assess-user-matches",
  "discover-user-jobs",
  "refresh-user-imported-jobs",
] as const;
const ACTIVE_RUN_STATUSES = ["QUEUED", "EXECUTING", "WAITING", "DELAYED", "DEQUEUED", "PENDING_VERSION"] as const;
const ERASED_OWNER = "__deleted_account__";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("The signed-in account identity is invalid.");
}

function safeStorageSegment(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

/** Deletes and verifies every nested object below this account's bucket prefix. */
export async function removeAccountStorage(ownerId: string): Promise<void> {
  const storage = adminSupabase().storage;
  for (const bucketName of STORAGE_BUCKETS) {
    const bucket = storage.from(bucketName);
    for (;;) {
      const objects = await listStorageTree(bucket, ownerId);
      if (!objects.length) break;
      for (let offset = 0; offset < objects.length; offset += 100) {
        const { error: removeError } = await bucket.remove(objects.slice(offset, offset + 100));
        if (removeError) throw new Error(`Private ${bucketName} files could not be removed. Deletion is locked; retry to continue.`);
      }
    }
    const remaining = await bucket.list(ownerId, { limit: 100, offset: 0 });
    if (remaining.error || remaining.data?.length) throw new Error(`Some private ${bucketName} files remain. Deletion is locked; retry to continue.`);
  }
}

async function listStorageTree(bucket: ReturnType<ReturnType<typeof adminSupabase>["storage"]["from"]>, prefix: string): Promise<string[]> {
  const output: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await bucket.list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error("Nested private files could not be verified. Deletion is locked; retry to continue.");
    for (const item of data ?? []) {
      if (!safeStorageSegment(item.name)) throw new Error("A private object path could not be verified. Deletion is locked; contact support.");
      if (item.id) output.push(`${prefix}/${item.name}`);
      else output.push(...await listStorageTree(bucket, `${prefix}/${item.name}`));
    }
    if (!data || data.length < 1000) break;
  }
  return output;
}

function terminal(status: string): boolean {
  return ["CANCELED", "COMPLETED", "CRASHED", "EXPIRED", "FAILED", "SYSTEM_FAILURE", "TIMED_OUT"].includes(status);
}

async function ownerRuns(ownerId: string): Promise<Array<{ id: string; status: string }>> {
  if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Background runs could not be inspected. Deletion is locked; retry when the worker service is available.");
  const active: Array<{ id: string; status: string }> = [];
  for await (const item of runs.list({ taskIdentifier: [...OWNER_TASKS], status: [...ACTIVE_RUN_STATUSES], limit: 100 })) {
    const listed = item as typeof item & { tags?: string[] };
    if (listed.tags?.includes(`owner:${ownerId}`)) {
      active.push({ id: listed.id, status: listed.status });
      continue;
    }
    // Older runs predate owner tags. Inspect their payload and fail closed if
    // ownership cannot be established, instead of canceling another user's run.
    const detail = await runs.retrieve(listed.id) as unknown as { payload?: unknown; status?: string; tags?: string[] };
    const payload = detail.payload;
    const payloadOwner = payload && typeof payload === "object" ? (payload as Record<string, unknown>).userId : undefined;
    if (detail.tags?.includes(`owner:${ownerId}`) || payloadOwner === ownerId) active.push({ id: listed.id, status: detail.status ?? listed.status });
    else if (typeof payloadOwner !== "string" && !detail.tags?.some((tag) => tag.startsWith("owner:"))) throw new Error("A legacy background run has no verifiable account owner. Deletion is locked; retry after that run is reconciled.");
  }
  return active;
}

async function cancelOwnerRuns(ownerId: string): Promise<void> {
  for (let round = 0; round < 4; round++) {
    const active = await ownerRuns(ownerId);
    if (!active.length) return;
    await Promise.all(active.map(async (run) => {
      if (!terminal(run.status)) await runs.cancel(run.id);
    }));
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const unresolved = await Promise.all(active.map(async ({ id }) => {
        const current = await runs.retrieve(id) as unknown as { status?: string };
        return current.status && terminal(current.status) ? undefined : id;
      }));
      if (unresolved.every((id) => !id)) break;
      await pause(500);
    }
    const remaining = await ownerRuns(ownerId);
    if (!remaining.length) return;
    if (round === 3) throw new Error("Account work did not stop. The account is locked and its data remains available for a safe retry.");
  }
}

async function stopAccountBrowsers(ownerId: string): Promise<void> {
  const client = adminSupabase();
  const [{ data: stateRow, error: stateError }, usage] = await Promise.all([
    client.from("app_states").select("data").eq("user_id", ownerId).maybeSingle(),
    readBrowserUsage(ownerId),
  ]);
  if (stateError) throw new Error("Active browser sessions could not be checked. Deletion is locked; retry when account data is available.");
  const sessions = new Map<string, Pick<Application, "browserProvider" | "browserSessionId">>();
  const state = stateRow?.data as AppState | undefined;
  for (const app of state?.applications ?? []) {
    if (app.importedPreflight?.allocationUncertain && !app.importedPreflight.sessionId) throw new Error("A browser allocation may still be active but its session identity is unavailable. Deletion is locked; contact support to stop it safely.");
    const preflightAge = app.importedPreflight?.startedAt ? Date.now() - Date.parse(app.importedPreflight.startedAt) : 0;
    if (app.importedPreflight?.token && !app.importedPreflight.sessionId && preflightAge > 12 * 60_000) {
      throw new Error("An interrupted browser check has no confirmed provider session. Deletion is locked; contact support to verify it safely.");
    }
    if (app.browserSessionId) sessions.set(`${app.browserProvider ?? "browserbase"}:${app.browserSessionId}`, { browserProvider: app.browserProvider, browserSessionId: app.browserSessionId });
    if (app.browserReleasePending?.sessionId) sessions.set(`${app.browserReleasePending.provider ?? app.browserProvider ?? "browserbase"}:${app.browserReleasePending.sessionId}`, { browserProvider: app.browserReleasePending.provider ?? app.browserProvider, browserSessionId: app.browserReleasePending.sessionId });
    if (app.importedPreflight?.sessionId) sessions.set(`${app.importedPreflight.provider ?? "browserbase"}:${app.importedPreflight.sessionId}`, { browserProvider: app.importedPreflight.provider, browserSessionId: app.importedPreflight.sessionId });
  }
  const usageRecords = [...usage.records].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  for (const app of state?.applications ?? []) {
    const latest = app.browserActions?.at(-1)?.label;
    const sessionId = app.browserSessionId ?? app.browserReleasePending?.sessionId ?? app.importedPreflight?.sessionId;
    const claimedAt = app.runWorkerClaimedAt ? Date.parse(app.runWorkerClaimedAt) : NaN;
    const actionAt = app.browserActions?.at(-1)?.at ? Date.parse(app.browserActions.at(-1)!.at) : NaN;
    const matchingLedgerSession = usageRecords.some((record) => record.applicationId === app.id && record.sessionId
      && (!app.runToken || record.runId === app.runToken));
    if (!sessionId && app.status === "filling" && app.runWorkerClaimedAt && Number.isFinite(claimedAt)
      && Number.isFinite(actionAt) && actionAt >= claimedAt && latest === "Starting the authorized browser session" && !matchingLedgerSession) {
      throw new Error("A legacy browser run may have allocated a session without recording its identity. Deletion is locked; contact support to reconcile provider usage.");
    }
  }
  const finalBySession = new Map<string, boolean>();
  for (const allocation of usageRecords.filter((record) => record.event === "allocation_started")) {
    const resolved = usageRecords.some((record) => record.runId === allocation.runId && (
      record.event === "failed" && record.failure === "allocation_failed"
      || (record.event === "created" || record.event === "stopped") && Boolean(record.sessionId)
    ));
    if (!resolved) throw new Error("A browser allocation was interrupted before its provider session could be verified. Deletion is locked; contact support to resolve the session safely.");
  }
  for (const record of usageRecords) {
    if (!record.sessionId) {
      if (record.failure === "ambiguous_allocation" && !record.orphanedSessionId) throw new Error("A browser allocation has an unknown session identity. Deletion is locked; contact support to verify provider shutdown.");
      if (record.orphanedSessionId) sessions.set(`${record.provider ?? "browserbase"}:${record.orphanedSessionId}`, { browserProvider: record.provider as Application["browserProvider"], browserSessionId: record.orphanedSessionId });
      continue;
    }
    const key = `${record.provider ?? "browserbase"}:${record.sessionId}`;
    finalBySession.set(key, record.report?.status === "stopped" || record.event === "stopped");
    if (record.report?.status !== "stopped" && record.event !== "stopped") sessions.set(key, { browserProvider: record.provider as Application["browserProvider"], browserSessionId: record.sessionId });
    if (record.orphanedSessionId) sessions.set(`${record.provider ?? "browserbase"}:${record.orphanedSessionId}`, { browserProvider: record.provider as Application["browserProvider"], browserSessionId: record.orphanedSessionId });
  }
  for (const [key, app] of sessions) {
    if (finalBySession.get(key)) continue;
    const report = await releaseRemoteBrowser(app);
    if (report?.status !== "stopped") throw new Error("A browser session has not confirmed shutdown. Deletion is locked; retry after the provider is available.");
  }
}

async function reconcileAbandonedLeases(ownerId: string): Promise<void> {
  const leases = await accountOperationLeases(ownerId);
  const reclaimBefore = Date.now() - 12 * 60_000;
  for (const lease of leases) {
    if (lease.operation === "worker" && lease.reference) {
      let run: { status?: string };
      try { run = await runs.retrieve(lease.reference) as unknown as { status?: string }; }
      catch { continue; }
      if (run.status && terminal(run.status)) await releaseAccountOperation(lease.leaseId);
      continue;
    }
    // All HTTP and scheduled handlers that hold leases have a 5 minute
    // platform maximum. Only reclaim them after a generous 12 minute bound,
    // by which time the platform has terminated any stalled process.
    if (lease.acquiredAt && Date.parse(lease.acquiredAt) < reclaimBefore) await releaseAccountOperation(lease.leaseId);
  }
}

async function waitForLeases(ownerId: string, includeWorkers = true): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await reconcileAbandonedLeases(ownerId);
    const outstanding = await accountOperationLeases(ownerId);
    if (includeWorkers ? outstanding.length === 0 : !outstanding.some((lease) => lease.operation !== "worker")) return;
    await pause(250);
  }
  throw new Error("Account work is still finishing. Deletion is locked; retry in a moment.");
}

async function ownedCostEvidenceIds(ownerId: string): Promise<string[]> {
  const client = adminSupabase();
  const ids = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("model_usage_records").select("data").eq("user_id", ownerId)
      .order("started_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499);
    if (error) throw new Error("Account usage records could not be checked. Deletion is locked; retry when data access is restored.");
    for (const row of data ?? []) {
      const identity = (row.data as { id?: string }).id;
      if (identity) ids.add(identity);
    }
    if (!data || data.length < 500) break;
  }
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client.from("browser_usage_records").select("data").eq("user_id", ownerId)
      .order("occurred_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499);
    if (error) throw new Error("Account usage records could not be checked. Deletion is locked; retry when data access is restored.");
    for (const row of data ?? []) {
      const record = row.data as { id?: string; provider?: string; sessionId?: string | null };
      if (!record.id) continue;
      if (record.sessionId) {
        ids.add(`browser:${record.provider}:${record.sessionId}:browser`);
        ids.add(`browser:${record.provider}:${record.sessionId}:proxy`);
      } else {
        ids.add(`browser:event:${record.id}`);
        ids.add(`browser:event:${record.id}:proxy`);
      }
    }
    if (!data || data.length < 500) break;
  }
  return [...ids];
}

async function readPilotReports(): Promise<Array<{ id: string; owner_id: string | null; snapshot_hash: string; snapshot: PilotReportSnapshot }>> {
  const client = adminSupabase();
  const reports: Array<{ id: string; owner_id: string | null; snapshot_hash: string; snapshot: PilotReportSnapshot }> = [];
  let lastId: string | undefined;
  for (;;) {
    let query = client.from("pilot_reports").select("id,owner_id,snapshot_hash,snapshot").order("id", { ascending: true }).limit(500);
    if (lastId) query = query.gt("id", lastId);
    const { data, error } = await query;
    if (error) throw new Error("Shared pilot evidence could not be checked. Deletion is locked; retry when data access is restored.");
    reports.push(...(data ?? []) as typeof reports);
    if (!data || data.length < 500) return reports;
    lastId = data.at(-1)!.id;
  }
}

function reportReferencesOwner(report: PilotReportSnapshot, ownerId: string, evidenceIds: Set<string>): boolean {
  return report.createdBy.userId === ownerId || report.sourceManifest.stateOwnerIds.includes(ownerId)
    || report.sourceManifest.stateRows.some((row) => row.ownerId === ownerId)
    || report.attempts.some((attempt) => attempt.ownerId === ownerId)
    || Boolean(report.sourceManifest.cost?.evidenceIds.some((id) => evidenceIds.has(id)))
    || report.attempts.some((attempt) => [
      ...(attempt.costEvidence.evidenceIds ?? []),
      ...(attempt.costEvidence.estimatedEvidenceIds ?? []),
      ...(attempt.costEvidence.measuredEvidenceIds ?? []),
      ...(attempt.costEvidence.reconciledEvidenceIds ?? []),
    ].some((id) => evidenceIds.has(id)));
}

async function eraseOwnedData(ownerId: string): Promise<void> {
  const client = adminSupabase();
  const evidenceIds = await ownedCostEvidenceIds(ownerId);
  const evidenceSet = new Set(evidenceIds);
  for (let attempt = 0; attempt < 4; attempt++) {
    const records = await readPilotReports();
    const reports = records.flatMap((record) => {
      const snapshot = record.snapshot;
      if (record.owner_id === ownerId) return [{ id: record.id, delete: true, originalSnapshotHash: record.snapshot_hash }];
      if (!reportReferencesOwner(snapshot, ownerId, evidenceSet)) return [];
      const redacted = redactPilotReportOwner(snapshot, ownerId, evidenceIds);
      return [{ id: record.id, delete: false, originalSnapshotHash: record.snapshot_hash, snapshotHash: pilotReportDigest(redacted), snapshot: redacted }];
    });
    const { error } = await client.rpc("erase_account_owned_data", { p_owner_id: ownerId, p_redacted_reports: reports });
    if (!error) return;
    if (error.message.includes("ACCOUNT_REPORT_CONFLICT") && attempt < 3) continue;
    throw new Error(error.message.includes("ACCOUNT_OPERATIONS_ACTIVE")
      ? "Account work is still finishing. Deletion is locked; retry in a moment."
      : "Account records could not be fully removed. Deletion is locked; retry to continue.");
  }
}

/**
 * Erases the verified current user. The durable deletion lock is intentionally
 * retained on every uncertain failure, making retries safe and fencing writes.
 */
export async function deleteAccount(ownerId: string, accessToken: string): Promise<void> {
  assertUuid(ownerId);
  if (!accessToken) throw new Error("The current sign-in session could not be verified. Sign in again and retry.");
  await beginAccountDeletion(ownerId);
  // Let admitted HTTP, dispatch and maintenance operations finish first so
  // none can enqueue a run after the first Trigger scan. New admissions are
  // already blocked by the durable tombstone.
  await waitForLeases(ownerId, false);
  // Cancel the remaining admitted Trigger runs, then drain worker leases.
  await cancelOwnerRuns(ownerId);
  await waitForLeases(ownerId);
  await stopAccountBrowsers(ownerId);
  await waitForLeases(ownerId);
  await removeAccountStorage(ownerId);
  await eraseOwnedData(ownerId);
  const client = adminSupabase();
  const { error: revokeError } = await client.auth.admin.signOut(accessToken, "global");
  if (revokeError) throw new Error("Account data is removed, but sessions could not be revoked. The account remains locked; retry to finish.");
  const { error: deleteError } = await client.auth.admin.deleteUser(ownerId, false);
  if (deleteError) throw new Error("Account data is removed, but account sign-in could not be disabled. The account remains locked; retry to finish.");
}

export const accountDeletionConstants = { storageBuckets: STORAGE_BUCKETS, erasedOwnerSentinel: ERASED_OWNER } as const;
