import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { tasks, runs } from "@trigger.dev/sdk";
import {remoteBrowserStatus} from "../src/lib/browser-provider";
import { initialDemoState } from "../src/lib/demo-data";
import { loadState, mutateState } from "../src/lib/repository";
import { selectApplication, setPacket, approveFill, approveSubmit, transition } from "../src/lib/workflow";
import { packetProfileHash } from "../src/lib/drafting";
import { withPacketFiles } from "../src/lib/packet-files";
import { issueControlledTestGrant } from "../src/lib/controlled-tests";
import { queueApplicationRun } from "../src/lib/application-queue";
import { cancelBrowser } from "../src/lib/browser-runner";

async function main() {
  process.env.DEMO_MODE = "false";
  const origin = process.env.TEST_REMOTE_APP_URL || process.env.APP_ORIGIN;
  if (!origin || !origin.startsWith("https://")) throw new Error("Configure the deployed HTTPS app and production Trigger environment.");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const id = randomUUID();
  const { data, error } = await db.auth.admin.createUser({ email: `cloud-submit-${id}@example.com`, email_confirm: true });
  assert.equal(error, null);
  const userId = data.user!.id;
  let applicationId = "";
  let token = "";
  let reviewedSessionId = "";
  try {
    assert.equal((await fetch(`${origin}/api/internal/controlled-form?token=invalid`)).status, 404);
    applicationId = await mutateState(userId, async (state) => {
      const profile = { ...initialDemoState().profile, id: userId, name: "Synthetic Cloud Submit", email: data.user!.email!, demo: false };
      state.profile = profile;
      const job = { ...initialDemoState().jobs[1], id: `controlled-submit:${id}`, source: "imported" as const, sourceId: id, url: `${origin}/api/internal/controlled-form`, applyUrl: `${origin}/api/internal/controlled-form` };
      state.importedJobs = [job];
      state.jobs = [job];
      const app = selectApplication(state, job.id, userId);
      const issued = issueControlledTestGrant(userId, app.id);
      token = issued.token;
      job.url = job.applyUrl = `${origin}/api/internal/controlled-form?token=${token}`;
      app.jobSnapshot = { ...job };
      app.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0 };
      const fact = profile.facts.find((item) => item.verified)!;
      setPacket(state, app, await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Synthetic cloud submission test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], createdAt: new Date().toISOString(), model: "controlled-fixture", profileHash: packetProfileHash(profile) }));
      approveFill(app, userId, app.packetHash!, job.applyUrl);
      return app.id;
    });
    const premature = new FormData();
    premature.set("token", token);
    assert.equal((await fetch(`${origin}/api/internal/controlled-form?token=${token}`, { method: "POST", headers: { Origin: origin }, body: premature })).status, 403, "Receiver must refuse an unapproved submission");
    await queueApplicationRun(userId, applicationId, "fill");
    const deadline = Date.now() + 150000;
    let app;
    do {
      app = (await loadState(userId)).applications.find((item) => item.id === applicationId)!;
      if (app.status !== "filling") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    assert.equal(app!.status, "final_review", app!.error);
    assert.equal(app!.form?.readyToSubmit, true);
    assert.equal(app!.packet?.schemaVersion, 1);
    const file = app!.packet!.files![0];
    assert.equal(app!.form?.fields.find((field) => field.kind === "file")?.fileHashes?.[0], `${file.filename}:${file.size}:${file.sha256}`, "Cloud upload must match the reviewed packet file");
    assert.equal(app!.approvals[0].version, 1);
    reviewedSessionId = app!.browserSessionId!;
    assert.ok(reviewedSessionId);
    await mutateState(userId, (state) => {
      const target = state.applications.find((item) => item.id === applicationId)!;
      approveSubmit(target, userId, target.form!.hash);
      transition(target, ["approved_to_submit"], "submitting");
      target.submissionStartedAt = new Date().toISOString();
    });
    const payload = { userId, applicationId };
    if (process.env.TEST_CLOUD_CLOSED === "true") await mutateState(userId, (state) => {
      const target = state.applications.find((item) => item.id === applicationId)!;
      const imported = state.importedJobs!.find((item) => item.id === target.jobId)!;
      imported.active = false; // Close the job after both approvals and queueing.
    });
    const handle = await tasks.trigger("submit-application-form", payload);
    const result = await runs.poll(handle.id, { pollIntervalMs: 1000 });
    if (result.status !== "COMPLETED") {
      const failed = (await loadState(userId)).applications.find((item) => item.id === applicationId)!;
      console.error(JSON.stringify({ workerStatus: result.status, applicationStatus: failed.status, attempted: Boolean(failed.submissionAttemptedAt), received: failed.controlledTest?.submissions }));
    }
    assert.equal(result.status, "COMPLETED", "Cloud submit worker must complete");
    app = (await loadState(userId)).applications.find((item) => item.id === applicationId)!;
    if (process.env.TEST_CLOUD_CLOSED === "true") {
      assert.equal(app.status, "needs_user_action");
      assert.equal(app.controlledTest?.submissions, 0);
      assert.equal(app.submissionAttemptedAt, undefined);
      assert.equal(app.browserSessionId, undefined);
      assert.equal(app.approvals.some((approval) => approval.kind === "submit"), false);
      assert.equal((result.output as { blocked?: boolean }).blocked, true);
      const reviewedBrowser = { ...app, browserSessionId: reviewedSessionId };
      let session = await remoteBrowserStatus(reviewedBrowser);
      const releaseDeadline = Date.now() + 15_000;
      while (session === "active" && Date.now() < releaseDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        session = await remoteBrowserStatus(reviewedBrowser);
      }
      assert.equal(session, "stopped", "Provider must confirm the reviewed session was released");
      const duplicate = await tasks.trigger("submit-application-form", payload);
      assert.deepEqual((await runs.poll(duplicate.id, { pollIntervalMs: 1000 })).output, { skipped: true });
      assert.equal((await loadState(userId)).applications.find((item) => item.id === applicationId)!.controlledTest?.submissions, 0);
      console.log("PASS cloud job closure after both approvals: no submit attempted, zero accepted submissions, final approval cleared, browser released, duplicate delivery skipped");
      return;
    }
    assert.equal(app.status, "submitted", JSON.stringify({ error: app.error, receiptText: app.submissionReceipt?.text, received: app.controlledTest?.submissions }));
    assert.equal(app.controlledTest?.submissions, 1);
    assert.deepEqual(app.approvals.map((approval) => approval.version), [1, 1]);
    assert.ok(app.submissionAttemptedAt);
    assert.ok(app.submittedAt);
    assert.match(app.submissionReceipt?.text || "", /Application received/);
    assert.ok(app.submissionReceipt?.screenshotPath);
    const proof = await db.storage.from("form-shots").download(`${userId}/${applicationId}-confirmation.png`);
    assert.equal(proof.error, null);
    assert.ok(proof.data!.size > 1000);
    console.log("PASS protected cloud controlled form: fill, both bound approvals, one submit click, confirmation, persisted receipt and private screenshot");
    const duplicate = await tasks.trigger("submit-application-form", payload);
    const duplicateResult = await runs.poll(duplicate.id, { pollIntervalMs: 1000 });
    assert.equal(duplicateResult.status, "COMPLETED");
    assert.deepEqual(duplicateResult.output, { skipped: true });
    assert.equal((await loadState(userId)).applications.find((item) => item.id === applicationId)!.controlledTest?.submissions, 1);
    assert.equal((await fetch(`${origin}/api/internal/controlled-form?token=${token}`, { method: "POST", headers: { Origin: origin }, body: premature })).status, 403);
    console.log("PASS duplicate cloud task is skipped and receiver refuses replay; no employer contacted");
  } finally {
    if (applicationId) {
      const app = (await loadState(userId)).applications.find((item) => item.id === applicationId);
      if (app) await cancelBrowser({ ...app, browserSessionId: app.browserSessionId || reviewedSessionId }).catch(() => undefined);
      await db.storage.from("form-shots").remove([`${userId}/${applicationId}.png`, `${userId}/${applicationId}-confirmation.png`]);
    }
    await db.auth.admin.deleteUser(userId);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
