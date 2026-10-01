import assert from "node:assert/strict";
import { createServer } from "node:http";
import { initialDemoState } from "../src/lib/demo-data";
import { activateAutomation, saveOnboarding } from "../src/lib/onboarding";
import { assertAutonomous, autonomyProfileHash, autonomyJobHash, sealAutonomousPacket } from "../src/lib/autonomous-policy";
import { selectApplication, setPacket, setFormSnapshot } from "../src/lib/workflow";
import { withPacketFiles } from "../src/lib/packet-files";
import { packetProfileHash } from "../src/lib/drafting";
import { prepareBrowser, submitBrowser, cancelBrowser } from "../src/lib/browser-runner";
import { canonicalJobUrl } from "../src/lib/sources";
import type { Application, Job } from "../src/lib/types";

async function main() {
  process.env.DEMO_MODE = "true";
  delete process.env.OPENAI_API_KEY;
  const counts = new Map<string, number>();
  let persisted: Application | undefined;
  const server = createServer((request, response) => {
    const mode = new URL(request.url!, "http://localhost").searchParams.get("mode") || "confirmed";
    response.setHeader("Content-Type", "text/html");
    if (request.method === "POST") {
      assert.ok(persisted?.submissionAttemptedAt, "The attempt must be persisted before receiver sees the click");
      counts.set(mode, (counts.get(mode) || 0) + 1);
      request.resume(); request.on("end", () => response.end(mode === "confirmed" ? "<h1>Application received</h1>" : "<h1>Still processing</h1>"));
    } else if (mode === "redirected" && !request.url?.startsWith("/other")) { response.statusCode = 302; response.setHeader("Location", `/other?mode=${mode}`); response.end(); }
    else response.end(`<form method="post" ${mode === "action-drift" ? 'action="/other"' : ""} enctype="multipart/form-data"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" type="email" required></label><label>Resume<input type="file" name="resume" required></label><button>Submit application</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    for (const mode of ["confirmed", "uncertain", "paused", "allocation-paused", "redirected", "action-drift"]) {
      const state = initialDemoState();
      saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); activateAutomation(state.profile, "controlled browser test");
      const job: Job = { ...state.jobs[0], url: `http://localhost:${address.port}/?mode=${mode}`, applyUrl: `http://localhost:${address.port}/?mode=${mode}` }; state.jobs = [job];
      const app = selectApplication(state, job.id, state.profile.id);
      app.autonomousAuthorization = { version: 1, userId: state.profile.id, profileVersion: state.profile.automationVersion!, targetUrl: job.applyUrl, expectedFormUrl: job.applyUrl, expectedSubmitAction: job.applyUrl, authorizedAt: new Date().toISOString(), profileHash: autonomyProfileHash(state.profile), jobHash: autonomyJobHash(job), postingIdentity: canonicalJobUrl(job.url) };
      const fact = state.profile.facts.find((item) => item.verified)!;
      setPacket(state, app, await withPacketFiles(state.profile, { version: 1, schemaVersion: 1, summary: "Controlled known-answer test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], createdAt: new Date().toISOString(), model: "verified-facts-template", profileHash: packetProfileHash(state.profile) }));
      sealAutonomousPacket(app); app.status = "filling";
      const prepare = (): ReturnType<typeof prepareBrowser> => prepareBrowser(app, job, state.profile, async (session) => { app.browserSessionId = session.sessionId; return true; }, async () => {
        if (mode === "allocation-paused") state.profile.automationAuthorization!.status = "paused";
        assertAutonomous(app, state.profile, job, "fill"); return true;
      });
      if (["allocation-paused", "redirected"].includes(mode)) {
        await assert.rejects(prepare(), mode === "allocation-paused" ? /enable your current automation/ : /different application URL|destination changed/);
        assert.equal(counts.get(mode) || 0, 0);
        if (mode === "allocation-paused") assert.equal(app.browserSessionId, undefined);
        await cancelBrowser(app); console.log(`PASS automatic ${mode}: current allocation permission and exact posting URL prevent provider/control work`); continue;
      }
      const prepared = await prepare();
      assert.equal(prepared.form.readyToSubmit, true); assert.equal(prepared.needsAction, false); app.browserSessionId = prepared.sessionId;
      setFormSnapshot(app, prepared.form); app.autonomousAuthorization.formHash = app.form!.hash; app.status = "submitting";
      persisted = app;
      const options = { profile: state.profile, job, beforeAttempt: async (baseline: NonNullable<Application["submissionVerification"]>) => {
        if (mode === "paused") state.profile.automationAuthorization!.status = "paused";
        assertAutonomous(app, state.profile, job, "submit");
        app.submissionAttemptedAt = baseline.attemptedAt; app.submissionVerification = baseline; return true;
      } };
      try {
        if (mode === "action-drift") {
          await assert.rejects(submitBrowser(app, options), /FORM_CHANGED|submit destination/); assert.equal(counts.get(mode) || 0, 0); assert.equal(app.submissionAttemptedAt, undefined);
        }
        else if (mode === "paused") { await assert.rejects(submitBrowser(app, options), /enable your current automation/); assert.equal(counts.get(mode) || 0, 0); assert.equal(app.submissionAttemptedAt, undefined); }
        else {
          const result = await submitBrowser(app, options); assert.equal(result.confirmed, mode === "confirmed"); assert.equal(counts.get(mode), 1); assert.ok(app.submissionAttemptedAt); assert.deepEqual(app.approvals, []);
          await assert.rejects(submitBrowser(app, options), /already attempted/); assert.equal(counts.get(mode), 1);
        }
        console.log(`PASS automatic ${mode}: known fields and exact résumé uploaded, durable pre-click gate, no legacy approvals, at most one attempt`);
      } finally { await cancelBrowser(app); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
