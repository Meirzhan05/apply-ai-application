import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { initialDemoState } from "../src/lib/demo-data";
import type { PilotAttempt, PilotReportSnapshot } from "../src/lib/types";

/**
 * Destructive integration test. It creates two fresh synthetic Auth users,
 * deletes both only through the signed-in product endpoint, and never accepts
 * an owner ID from the command line. Non-local targets require an extra opt-in.
 */
async function main() {
  if (process.env.ACCOUNT_DELETION_TEST_CONFIRM !== "DELETE_SYNTHETIC_ACCOUNTS") {
    throw new Error("Set ACCOUNT_DELETION_TEST_CONFIRM=DELETE_SYNTHETIC_ACCOUNTS to run this destructive synthetic-account test.");
  }
  const appUrl = process.env.ACCOUNT_DELETION_BASE_URL;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!appUrl || !supabaseUrl || !publishableKey || !serviceKey) throw new Error("Set ACCOUNT_DELETION_BASE_URL and the Supabase URL, publishable key, and service role key.");
  const appOrigin = new URL(appUrl).origin;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appOrigin) && process.env.ACCOUNT_DELETION_ALLOW_NONLOCAL !== "true") {
    throw new Error("Non-local deletion tests require ACCOUNT_DELETION_ALLOW_NONLOCAL=true.");
  }
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  if (process.env.ACCOUNT_DELETION_EXPECT_SUPABASE_REF && ref !== process.env.ACCOUNT_DELETION_EXPECT_SUPABASE_REF) {
    throw new Error(`Configured Supabase project ${ref} does not match the explicitly expected project.`);
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const testId = randomUUID();
  const fixture = {
    costId: `account-deletion-test:${testId}`,
    invoiceId: `account-deletion-test:${testId}`,
    reportId: `account-deletion-test:${testId}`,
    modelIds: [randomUUID(), randomUUID()],
    browserIds: [`account-deletion-test:${testId}:a`, `account-deletion-test:${testId}:b`],
    queuedIds: [`account-deletion-test:${testId}:queue-a`, `account-deletion-test:${testId}:queue-b`],
  };
  const users: Array<{ id: string; email: string; cookie: string }> = [];
  let deletionStarted = false;
  let allChecksPassed = false;
  const period = "2099-01";
  const costAmount = 0;

  async function signInSynthetic(suffix: string) {
    const email = `apply-account-deletion-${testId}-${suffix}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    assert.equal(error, null, `create synthetic account ${suffix}`);
    const id = data.user!.id;
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    assert.equal(link.error, null, `generate synthetic callback for ${suffix}`);
    const callback = await fetch(`${appOrigin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
    assert.equal(callback.status, 307, `sign in synthetic account ${suffix}`);
    users.push({ id, email, cookie: callback.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") });
    assert.ok(users.at(-1)!.cookie, `SSR cookie for synthetic account ${suffix}`);
  }

  async function deleteThroughProduct(index: number) {
    const response = await fetch(`${appOrigin}/api/account/delete`, {
      method: "DELETE", headers: { Cookie: users[index].cookie, Origin: appOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    assert.equal(response.status, 200, result.error ?? `delete synthetic account ${index}`);
    assert.deepEqual(result, { ok: true });
  }

  async function assertPrivateObjects(ownerId: string, expected: boolean) {
    for (const bucketName of ["resumes", "application-files", "form-shots"]) {
      const bucket = admin.storage.from(bucketName);
      const listTree = async (prefix: string): Promise<string[]> => {
        const { data, error } = await bucket.list(prefix, { limit: 1000, offset: 0 });
        assert.equal(error, null, `${bucketName} list ${prefix}`);
        const files: string[] = [];
        for (const item of data ?? []) {
          if (item.id) files.push(`${prefix}/${item.name}`);
          else files.push(...await listTree(`${prefix}/${item.name}`));
        }
        return files;
      };
      const files = await listTree(ownerId);
      assert.equal(files.length > 0, expected, `${bucketName} private originals for ${ownerId}`);
    }
  }

  async function seedPrivateObjects(ownerId: string) {
    const pdf = new Blob(["%PDF-1.4\nsynthetic account deletion fixture\n"], { type: "application/pdf" });
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p1sAAAAASUVORK5CYII=", "base64"));
    for (const [bucketName, ext, body, contentType] of [
      ["resumes", "resume.pdf", pdf, "application/pdf"],
      ["application-files", "generated.pdf", pdf, "application/pdf"],
      ["form-shots", "screenshot.png", new Blob([png], { type: "image/png" }), "image/png"],
    ] as const) {
      const { error } = await admin.storage.from(bucketName).upload(`${ownerId}/nested/deep/${testId}/${ext}`, body, { contentType, upsert: false });
      assert.equal(error, null, `seed ${bucketName} nested file`);
    }
  }

  async function seedStateAndUsage(ownerId: string, index: number) {
    const now = new Date().toISOString();
    const appState = initialDemoState();
    appState.profile = {
      ...appState.profile,
      id: ownerId,
      name: `Synthetic deletion fixture ${index}`,
      email: "",
      school: "",
      phone: "",
      graduationYear: "",
      headline: "",
      skills: [],
      preferredTitles: [],
      preferredLocations: [],
      facts: [],
      sensitiveAnswers: {},
      resumeFileName: undefined,
      resumeText: undefined,
      resumeSource: undefined,
      resumeSourceDocument: undefined,
      onboarding: { questionnaire: {} },
      automationSettings: { version: 1, resumeTailoring: false, coverLetterMode: "disabled", essayMode: "automatic-truthful" },
      automationAuthorization: undefined,
      automationVersion: 1,
      demo: false,
      updatedAt: now,
    };
    appState.jobs = [];
    appState.importedJobs = [];
    appState.applications = [];
    appState.feedback = [];
    appState.matchCache = {};
    appState.lastDigestAt = now;
    const state = await admin.from("app_states").insert({ user_id: ownerId, revision: 1, data: appState });
    assert.equal(state.error, null, "seed owner app state");
    const modelId = fixture.modelIds[index];
    const modelData = {
      version: 1, id: modelId, userId: ownerId, runId: `account-deletion-test:${testId}:${index}`,
      provider: "openai", model: "fixture-only", operation: "account-deletion-integration-fixture",
      startedAt: now, completedAt: null, status: "failed", responseId: null, requestId: null,
      providerStatus: null, serviceTier: null,
      tokens: { input: null, cachedInput: null, cacheWrite: null, output: null, reasoningOutput: null },
      rate: null, estimatedUsd: null, reconciledUsd: null, failure: "provider_error",
    };
    const model = await admin.from("model_usage_records").insert({ id: modelId, user_id: ownerId, started_at: now, data: modelData });
    assert.equal(model.error, null, "seed model usage fixture");
    const browserId = fixture.browserIds[index];
    const browserData = {
      version: 1, id: browserId, userId: ownerId, runId: `account-deletion-test:${testId}:${index}`,
      provider: "browser-use", sessionId: null, event: "failed", occurredAt: now, report: null,
      failure: "allocation_failed", orphanedSessionId: null,
    };
    const browser = await admin.from("browser_usage_records").insert({ id: browserId, user_id: ownerId, occurred_at: now, data: browserData });
    assert.equal(browser.error, null, "seed browser usage fixture");
  }

  function pilotAttempt(ownerId: string, applicationId: string, evidenceIds: string[]): PilotAttempt {
    const now = new Date().toISOString();
    return {
      version: 1, id: `attempt:${testId}:${applicationId}`, applicationId, ownerId,
      consentEpisodeId: `episode:${testId}:${ownerId}`, consentVersion: "integration-fixture", consentedAt: now,
      initiatedAt: now, onboardingCompletedAt: now, automationVersion: 1, profileHash: "synthetic-profile-hash",
      profileSnapshot: { name: "Synthetic", school: "", graduationYear: "", headline: "", workAuthorization: "Unspecified", facts: [], skills: [], preferredTitles: [], preferredLocations: [], questionnaire: {} },
      postingSnapshot: { jobId: `job:${testId}`, source: "greenhouse", sourceId: "fixture", canonicalUrl: "https://example.com/job", targetIdentityHash: "target", title: "Synthetic", company: "Example", employmentType: "Internship", description: "Synthetic integration fixture", evidenceHash: "posting" },
      origin: "real", cohort: "internship", cohortClassifierVersion: "fixture",
      costEvidence: { version: 1, status: "unknown", projectedUsd: 0, evidenceIds, capturedAt: now },
      events: [{ version: 1, id: `event:${testId}:${ownerId}`, kind: "initiated", at: now, actor: { kind: "owner", userId: ownerId } }],
      reviews: [],
    };
  }

  try {
    assert.equal((await fetch(`${appOrigin}/api/state`)).status, 401, "anonymous state is private");
    await signInSynthetic("a");
    await signInSynthetic("b");
    assert.match(users[0].email, new RegExp(`^apply-account-deletion-${testId}-a@`));
    assert.match(users[1].email, new RegExp(`^apply-account-deletion-${testId}-b@`));

    for (const user of users) {
      await seedPrivateObjects(user.id);
      await seedStateAndUsage(user.id, users.indexOf(user));
      const queued = await admin.rpc("reserve_queued_service_budget", {
        p_queued_id: fixture.queuedIds[users.indexOf(user)], p_owner_id: user.id,
        p_application_id: `application:${testId}:${users.indexOf(user)}`, p_month: period, p_amount: 0.01, p_limit: 1000,
      });
      assert.equal(queued.error, null, "seed future-month queue hold");
      assert.ok(queued.data, "future-month queue hold admitted");
    }

    const attemptA = pilotAttempt(users[0].id, `application:${testId}:a`, [fixture.modelIds[0], `browser:event:${fixture.browserIds[0]}`]);
    const attemptB = pilotAttempt(users[1].id, `application:${testId}:b`, [fixture.modelIds[1], `browser:event:${fixture.browserIds[1]}`]);
    const snapshot: PilotReportSnapshot = {
      version: 1, id: fixture.reportId, createdAt: new Date().toISOString(), createdBy: { kind: "operator", userId: users[0].id },
      cutoffAt: new Date().toISOString(), gateVersion: "integration-fixture", status: "insufficient-real-evidence", reasons: ["fewer-than-20-real-initiated"],
      totals: { realInitiated: 2, confirmed: 0, unattendedConfirmed: 0, interventions: 0, controlled: 0, unknown: 0, unknownCosts: 2 },
      cohorts: { internship: { initiated: 2, confirmed: 0 }, "new-grad": { initiated: 0, confirmed: 0 }, unclassified: { initiated: 0, confirmed: 0 } },
      sourceManifest: {
        stateOwnerIds: users.map((user) => user.id), stateReadAt: new Date().toISOString(), complete: true,
        stateRows: users.map((user) => ({ ownerId: user.id, readAt: new Date().toISOString(), eventPrefixes: [] })),
        controlledExclusions: [],
        cost: { scope: "service", period, evidenceIds: [...attemptA.costEvidence.evidenceIds, ...attemptB.costEvidence.evidenceIds], unknownComponents: 0, complete: true, capturedAt: new Date().toISOString() },
      },
      attempts: [attemptA, attemptB],
    };
    const reportInsert = await admin.from("pilot_reports").insert({
      id: fixture.reportId, owner_id: users[1].id, created_by: users[0].id, cutoff_at: snapshot.cutoffAt,
      gate_version: snapshot.gateVersion, status: snapshot.status, snapshot_hash: `before:${testId}`, snapshot,
    });
    assert.equal(reportInsert.error, null, "seed synthetic shared pilot report");

    const costData = {
      version: 1, id: fixture.costId, provider: "account-deletion-fixture", invoiceId: fixture.invoiceId,
      lineId: "zero-dollar-shared-line", period, category: "hosting", amountUsd: costAmount, currency: "USD",
      description: "Synthetic zero-dollar account deletion integration fixture", allocationMethod: "equal-active-users",
      allocations: users.map((user) => ({ userId: user.id, amountUsd: 0 })), reconciles: [], importedAt: new Date().toISOString(),
    };
    const costInsert = await admin.from("service_cost_records").insert({
      id: fixture.costId, provider: costData.provider, invoice_id: fixture.invoiceId, line_id: costData.lineId,
      period, category: "hosting", amount_usd: costAmount, data: costData,
    });
    assert.equal(costInsert.error, null, "seed zero-dollar shared invoice line");

    const routeRequest = (index: number, body: unknown, origin?: string) => fetch(`${appOrigin}/api/account/delete`, {
      method: "DELETE", headers: { Cookie: users[index].cookie, ...(origin !== undefined ? { Origin: origin } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await routeRequest(0, { confirmation: "DELETE" }, "https://attacker.example")).status, 403, "cross-origin request rejected");
    assert.equal((await routeRequest(0, { confirmation: "delete" }, appOrigin)).status, 400, "wrong confirmation rejected");
    assert.equal((await routeRequest(0, { confirmation: "DELETE", userId: users[1].id }, appOrigin)).status, 400, "forged owner input rejected");
    const anonymous = await fetch(`${appOrigin}/api/account/delete`, { method: "DELETE", headers: { Origin: appOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: "DELETE" }) });
    assert.equal(anonymous.status, 401, "anonymous delete rejected");

    deletionStarted = true;
    await deleteThroughProduct(0);
    assert.equal((await admin.auth.admin.getUserById(users[0].id)).data.user, null, "Auth owner A erased after data cleanup");
    const aState = await admin.from("app_states").select("user_id").eq("user_id", users[0].id);
    assert.equal(aState.error, null);
    assert.equal(aState.data?.length, 0, "owner A app state erased");
    for (const table of ["model_usage_records", "browser_usage_records"] as const) {
      const rows = await admin.from(table).select("user_id").eq("user_id", users[0].id);
      assert.equal(rows.error, null);
      assert.equal(rows.data?.length, 0, `${table} owner A evidence erased`);
    }
    await assertPrivateObjects(users[0].id, false);
    await assertPrivateObjects(users[1].id, true);
    const bState = await fetch(`${appOrigin}/api/state`, { headers: { Cookie: users[1].cookie } });
    assert.equal(bState.status, 200, "other signed-in account remains available");
    assert.equal((await bState.json()).profile.id, users[1].id);

    const sharedReport = await admin.from("pilot_reports").select("created_by,snapshot").eq("id", fixture.reportId).single();
    assert.equal(sharedReport.error, null);
    assert.equal(sharedReport.data!.created_by, "__deleted_account__");
    assert.deepEqual(sharedReport.data!.snapshot.attempts.map((attempt: PilotAttempt) => attempt.ownerId), [users[1].id]);
    assert.deepEqual(sharedReport.data!.snapshot.sourceManifest.stateOwnerIds, [users[1].id]);
    assert.equal(JSON.stringify(sharedReport.data!.snapshot).includes(users[0].id), false, "shared snapshot contains no owner A identity");

    const sharedCost = await admin.from("service_cost_records").select("amount_usd,data").eq("id", fixture.costId).single();
    assert.equal(sharedCost.error, null);
    assert.equal(Number(sharedCost.data!.amount_usd), costAmount, "shared invoice amount remains unchanged");
    assert.deepEqual(sharedCost.data!.data.allocations.sort((a: { userId: string }, b: { userId: string }) => a.userId.localeCompare(b.userId)), [
      { userId: "__deleted_account__", amountUsd: 0 }, { userId: users[1].id, amountUsd: 0 },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
    const bQueue = await admin.from("service_budget_queue_reservations").select("queued_id").eq("owner_id", users[1].id);
    assert.equal(bQueue.data?.some((row) => row.queued_id === fixture.queuedIds[1]), true, "other owner's future-month hold survives");

    const oldState = await fetch(`${appOrigin}/api/state`, { headers: { Cookie: users[0].cookie } });
    assert.equal(oldState.status, 401, "erased user's old SSR cookie no longer reads state");
    const staleMutation = await fetch(`${appOrigin}/api/actions`, {
      method: "POST", headers: { Cookie: users[0].cookie, Origin: appOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "profile", payload: { name: "must not return" } }),
    });
    assert.notEqual(staleMutation.status, 200, "erased user's old cookie cannot mutate account state");
    const stateAfterStaleWrite = await admin.from("app_states").select("user_id").eq("user_id", users[0].id);
    assert.equal(stateAfterStaleWrite.data?.length, 0, "stale mutation did not recreate owner A state");

    // Prove the surviving owner can subsequently erase its own rows through the same authenticated path.
    await deleteThroughProduct(1);
    assert.equal((await admin.auth.admin.getUserById(users[1].id)).data.user, null, "Auth owner B erased through its own session");
    const finalReport = await admin.from("pilot_reports").select("id").eq("id", fixture.reportId);
    assert.equal(finalReport.data?.length, 0, "owner-scoped shared report removed when its remaining owner is erased");
    const finalCost = await admin.from("service_cost_records").select("amount_usd,data").eq("id", fixture.costId).single();
    assert.equal(Number(finalCost.data!.amount_usd), costAmount, "final synthetic invoice total is still preserved");
    assert.deepEqual(finalCost.data!.data.allocations, [{ userId: "__deleted_account__", amountUsd: 0 }]);
    const finalQueue = await admin.from("service_budget_queue_reservations").select("queued_id").in("queued_id", fixture.queuedIds);
    assert.equal(finalQueue.data?.length, 0, "synthetic queued holds were removed through both deletion runs");
    allChecksPassed = true;
    console.log(`PASS two synthetic accounts deleted through ${appOrigin}; private storage, app state, usage, pilot evidence, cost allocations and queue holds verified.`);
    console.log(`Synthetic zero-dollar invoice fixture retained for optional operator cleanup: ${fixture.costId} (2099-01).`);
  } finally {
    if (!deletionStarted) {
      // Setup failures occur before the assertion phase; only generated users
      // are eligible for cleanup, and the product erasure path handles them.
      for (let index = 0; index < users.length; index++) {
        try { await deleteThroughProduct(index); }
        catch { console.error(`Synthetic setup cleanup needs attention for ${users[index].id}; no real account was targeted.`); }
      }
    } else if (!allChecksPassed) {
      console.error(`Synthetic fixture retained for investigation (never a real account): ${users.map((user) => user.id).join(", ")}; report ${fixture.reportId}; invoice ${fixture.costId}.`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
