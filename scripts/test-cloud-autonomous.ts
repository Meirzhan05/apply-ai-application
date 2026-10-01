import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { tasks, runs } from "@trigger.dev/sdk";
import { latexFixture } from "../src/lib/latex-fixture";
import { initialDemoState } from "../src/lib/demo-data";
import { loadState, mutateState } from "../src/lib/repository";
import { selectApplication } from "../src/lib/workflow";
import { activateAutomation, saveOnboarding } from "../src/lib/onboarding";
import { authorizeKnownAnswerApplication } from "../src/lib/autonomous-policy";
import { issueControlledTestGrant } from "../src/lib/controlled-tests";
import { mkdir, writeFile } from "node:fs/promises";
import { cleanupControlledOwner, ControlledCleanupBlocked, type CleanupSession } from "./lib/controlled-cleanup";
import { readBrowserUsage, withBrowserUsageContext } from "../src/lib/browser-usage";
import { startAutonomousApplication } from "../src/lib/autonomous-application";
import { ownerUsageView } from "../src/lib/usage-view";
import { releaseRemoteBrowser, remoteBrowserStatus } from "../src/lib/browser-provider";
import { checkSubmissionResult } from "../src/lib/submission-verification";
import { chromium } from "playwright-core";

// Paid production proof is deliberately separate from deterministic verification.
// This script provisions only a synthetic owner and protected synthetic receiver.
async function main() {
  process.env.DEMO_MODE = "false";
  const origin = process.env.TEST_REMOTE_APP_URL || process.env.APP_ORIGIN;
  assert.ok(origin?.startsWith("https://"), "Configure the deployed app and production Trigger environment");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const email = `cloud-submit-${randomUUID()}@example.com`;
  const created = await db.auth.admin.createUser({ email, email_confirm: true }); assert.equal(created.error, null);
  const owner = created.data.user!.id;
  let applicationId = "";
  try {
    const link = await db.auth.admin.generateLink({ type: "magiclink", email }); assert.equal(link.error, null);
    const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" }); assert.equal(callback.status, 307);
    const cookie = callback.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const state = initialDemoState(); state.profile = { ...latexFixture().profile, id: owner, email, name: "Synthetic Autonomous Applicant", demo: false };
    saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); activateAutomation(state.profile, "Synthetic authorized end-to-end verification");
    const job = { ...state.jobs[0], id: `controlled-auto:${randomUUID()}`, source: "imported" as const, company: "Controlled Test", title: "Synthetic software engineering internship", url: `${origin}/api/internal/controlled-form`, applyUrl: `${origin}/api/internal/controlled-form` };
    state.jobs = [job]; state.importedJobs = [job]; state.applications = [];
    const app = selectApplication(state, job.id, owner); applicationId = app.id;
    const issued = issueControlledTestGrant(owner, app.id); job.url = job.applyUrl = `${origin}/api/internal/controlled-form?token=${issued.token}`; app.jobSnapshot = { ...job };
    app.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0, verification: process.env.TEST_CLOUD_VERIFICATION === "true" };
    // Receiver needs the preassigned synthetic application id to sign its URL.
    // The public action queues this sealed selected fixture through the ordinary pipeline.
    authorizeKnownAnswerApplication(app, state.profile, job);
    await mutateState(owner, (saved) => { Object.assign(saved, state); });
    assert.equal((await fetch(`${origin}/api/internal/controlled-form?token=invalid`)).status, 404);
    assert.equal((await fetch(job.applyUrl, { method: "POST", headers: { Origin: origin! }, body: new FormData() })).status, 403, "Receiver must refuse a pre-attempt request");
    const start = async () => fetch(`${origin}/api/actions`, { method: "POST", headers: { Origin: origin!, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "startAutonomous", payload: { jobId: job.id } }) });
    const response = await start();
    if (response.status !== 200) {
      const rejected = await response.json(); assert.match(rejected.error || "", /not been invited/, "Only the standing private-beta guard can require the server fixture start");
      await startAutonomousApplication(owner, job.id);
    }
    const deadline = Date.now() + 780_000;
    let current;
    do {
      current = (await loadState(owner)).applications.find((item) => item.id === applicationId)!;
      if (["submitted", "uncertain", "needs_user_action", "awaiting_verification"].includes(current.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    if (!current!.submissionAttemptedAt || !["submitted", "awaiting_verification"].includes(current!.status)) console.error(JSON.stringify({ status: current!.status, attempted: Boolean(current!.submissionAttemptedAt), received: current!.controlledTest?.submissions, packetSchema: current!.packet?.schemaVersion ?? null }));
    assert.ok(current!.submissionAttemptedAt, "No durable attempt was recorded"); assert.equal(current!.controlledTest?.submissions, 1); assert.deepEqual(current!.approvals, []);
    assert.equal(current!.packet?.schemaVersion, 2); assert.deepEqual(current!.packet?.answers, []);
    assert.equal(current!.autonomousAuthorization?.packetHash, current!.packetHash); assert.equal(current!.autonomousAuthorization?.formHash, current!.form?.hash);
    if (process.env.TEST_CLOUD_VERIFICATION === "true") {
      assert.equal(current!.status, "awaiting_verification"); const browser = await chromium.connectOverCDP(current!.browserConnectUrl!);
      try { await browser.contexts()[0].pages()[0].getByRole("button", { name: "Complete synthetic verification", exact: true }).click(); } finally { await browser.close(); }
      await checkSubmissionResult(owner, applicationId); current = (await loadState(owner)).applications.find((item) => item.id === applicationId)!;
    }
    assert.equal(current!.status, "submitted", "The controlled workflow did not confirm"); assert.match(current!.submissionReceipt?.text || "", /Application received/); assert.ok(current!.submissionReceipt?.screenshotPath);
    const duplicate = await tasks.trigger("submit-application-form", { userId: owner, applicationId, submissionToken: current!.submissionDispatch?.token }); assert.deepEqual((await runs.poll(duplicate.id, { pollIntervalMs: 1000 })).output, { skipped: true });
    await startAutonomousApplication(owner, job.id); assert.equal((await loadState(owner)).applications.filter((item) => item.jobId === job.id).length, 1);
    assert.equal((await loadState(owner)).applications.find((item) => item.id === applicationId)!.controlledTest?.submissions, 1);
    const usage = await ownerUsageView(owner); assert.ok(usage.records.length, "Model ledger should contain the real preparation calls");
    const browserSessions = usage.browser.sessions.filter((session) => session.applicationId === applicationId);
    assert.ok(browserSessions.length, "Browser ledger should identify the controlled provider session");
    for (const session of browserSessions) {
      const events = usage.browser.records.filter((record) => record.provider === session.provider && record.sessionId === session.sessionId).map((record) => record.event);
      for (const expected of ["created", "connected", "stopped"] as const) assert.ok(events.includes(expected), `Missing real browser lifecycle event: ${expected}`);
      assert.equal(session.status, "stopped"); assert.equal(session.orphaned, false);
      if (session.proxyUsedMb === null) assert.equal(session.trafficStatus, "unknown");
    }
    assert.equal(usage.browser.activeSessions, 0);
    if (current!.browserSessionId) assert.equal(await remoteBrowserStatus(current!), "stopped");
    console.log("PASS production autonomous application: one start through the ordinary service and deployed workers, grounded schema-2 materials, no review approvals, exact packet/form bindings, one durable submit attempt, employer confirmation, receipt, replay skipped, owner usage recorded; no real employer contacted");
  } finally {
    const app = applicationId ? (await loadState(owner)).applications.find((item) => item.id === applicationId) : undefined;
    const workerInFlight = Boolean(app && ["drafting", "filling", "submitting"].includes(app.status));
    if (app && !app.submissionAttemptedAt) await mutateState(owner, (state) => {
      const current = state.applications.find((item) => item.id === applicationId);
      if (current && !current.submissionAttemptedAt) { current.status = "cancelled"; current.queuedRun = undefined; }
    });
    try {
      const usage = await readBrowserUsage(owner);
      const sessions = new Map<string, CleanupSession>();
      for (const record of usage.records) {
        const sessionId = record.sessionId || record.orphanedSessionId;
        if (sessionId) sessions.set(`${record.provider}:${sessionId}`, { provider: record.provider, sessionId, runId: record.runId, applicationId: record.applicationId, jobId: record.jobId });
      }
      if (app?.browserSessionId && app.browserProvider) sessions.set(`${app.browserProvider}:${app.browserSessionId}`, { provider: app.browserProvider, sessionId: app.browserSessionId, runId: app.runToken || applicationId, applicationId, jobId: app.jobId });
      await cleanupControlledOwner(owner, {
        sessions: [...sessions.values()], workerInFlight,
        allocationUnknown: usage.records.some((record) => record.failure === "ambiguous_allocation" && !record.sessionId && !record.orphanedSessionId),
        stopAndConfirm: async (session) => withBrowserUsageContext({ userId: owner, runId: session.runId, applicationId: session.applicationId, jobId: session.jobId }, async () => {
          const target = { browserProvider: session.provider, browserSessionId: session.sessionId };
          if (await remoteBrowserStatus(target) === "stopped") return;
          await releaseRemoteBrowser(target);
          for (let attempt = 0; attempt < 5; attempt++) {
            if (await remoteBrowserStatus(target) === "stopped") return;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          throw new Error("Provider stop could not be confirmed");
        }),
        list: async (bucket, prefix, offset) => {
          const result = await db.storage.from(bucket).list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
          if (result.error || !result.data) throw new Error("Storage listing failed");
          return result.data.map((entry) => ({ name: entry.name, id: entry.id }));
        },
        remove: async (bucket, keys) => { const result = await db.storage.from(bucket).remove(keys); if (result.error) throw new Error("Storage removal failed"); },
        deleteOwner: async () => { const result = await db.auth.admin.deleteUser(owner); if (result.error) throw new Error("Owner deletion failed"); },
      });
      console.log("PASS synthetic cleanup: provider sessions confirmed stopped, owner-prefix artifacts removed and verified, owner deleted last");
    } catch (error) {
      // Safe recovery identity only: never store the signed receiver URL, cookies or credentials.
      await mkdir(".data", { recursive: true });
      const recoveryFile = `.data/controlled-cleanup-${owner}.json`;
      await writeFile(recoveryFile, JSON.stringify({ ownerId: owner, applicationId: applicationId || null, reason: error instanceof ControlledCleanupBlocked ? error.reason : "cleanup_unverified", recordedAt: new Date().toISOString() }), { mode: 0o600 });
      console.error(`Synthetic cleanup needs reconciliation; owner and ledger retained. Safe identity: ${recoveryFile}`);
      throw error;
    }
  }
}
main().catch(() => { console.error("Controlled autonomous verification failed; see the cleanup result above. No grant or credential is logged."); process.exitCode = 1; });
