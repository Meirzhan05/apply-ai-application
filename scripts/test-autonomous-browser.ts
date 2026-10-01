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
  let radioNativeVariant: "stable" | "changed" = "stable";
  let persisted: Application | undefined;
  const server = createServer((request, response) => {
    const mode = new URL(request.url!, "http://localhost").searchParams.get("mode") || "confirmed";
    response.setHeader("Content-Type", "text/html");
    if (request.method === "POST") {
      assert.ok(persisted?.submissionAttemptedAt, "The attempt must be persisted before receiver sees the click");
      counts.set(mode, (counts.get(mode) || 0) + 1);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (mode === "radio-human") {
          const body = Buffer.concat(chunks).toString("utf8");
          assert.match(body, /name="workPattern"[\s\S]*?pattern-office/, "The radio must submit its exact native value");
        }
        response.end(mode === "confirmed" || mode === "radio-human" ? "<h1>Application received</h1>" : "<h1>Still processing</h1>");
      });
    } else if (mode === "redirected" && !request.url?.startsWith("/other")) { response.statusCode = 302; response.setHeader("Location", `/other?mode=${mode}`); response.end(); }
    else {
      const radioFixture = mode === "radio-human";
      const radioValues = radioNativeVariant === "changed" ? ["pattern-remote-new", "pattern-office-new"] : ["pattern-remote", "pattern-office"];
      response.end(`<form method="post" ${mode === "action-drift" ? 'action="/other"' : ""} enctype="multipart/form-data"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" type="email" required></label><label>Resume<input type="file" name="resume" required></label>${radioFixture ? `<fieldset><legend>Preferred work pattern</legend><label><input type="radio" name="workPattern" value="${radioValues[0]}" required>Remote</label><label><input type="radio" name="workPattern" value="${radioValues[1]}" required>Office</label></fieldset>` : ""}<button>Submit application</button></form>`);
    }
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
    const radioState = initialDemoState();
    saveOnboarding(radioState.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); activateAutomation(radioState.profile, "controlled radio browser test");
    const radioJob: Job = { ...radioState.jobs[0], url: `http://localhost:${address.port}/?mode=radio-human`, applyUrl: `http://localhost:${address.port}/?mode=radio-human` }; radioState.jobs = [radioJob];
    const radioApp = selectApplication(radioState, radioJob.id, radioState.profile.id);
    radioApp.autonomousAuthorization = { version: 1, userId: radioState.profile.id, profileVersion: radioState.profile.automationVersion!, targetUrl: radioJob.applyUrl, expectedFormUrl: radioJob.applyUrl, expectedSubmitAction: radioJob.applyUrl, authorizedAt: new Date().toISOString(), profileHash: autonomyProfileHash(radioState.profile), jobHash: autonomyJobHash(radioJob), postingIdentity: canonicalJobUrl(radioJob.url) };
    const radioFact = radioState.profile.facts.find((item) => item.verified)!;
    setPacket(radioState, radioApp, await withPacketFiles(radioState.profile, { version: 1, schemaVersion: 1, summary: "Controlled radio test", resumeLines: [{ text: radioFact.text, factIds: [radioFact.id] }], answers: [], createdAt: new Date().toISOString(), model: "verified-facts-template", profileHash: packetProfileHash(radioState.profile) }));
    sealAutonomousPacket(radioApp); radioApp.status = "filling";
    radioApp.autonomousHumanAnswers = [{ version: 1, userId: radioState.profile.id, applicationId: radioApp.id, targetUrl: radioJob.applyUrl, profileHash: autonomyProfileHash(radioState.profile), formHash: "observed-radio", question: { identifier: "workPattern", label: "Preferred work pattern", kind: "radio", options: ["Remote", "Office"], optionValues: ["pattern-remote", "pattern-office"] }, value: "pattern-office", confirmedAt: new Date().toISOString() }];
    const radioPrepared = await prepareBrowser(radioApp, radioJob, radioState.profile, async (session) => { radioApp.browserSessionId = session.sessionId; return true; }, async () => { assertAutonomous(radioApp, radioState.profile, radioJob, "fill"); return true; });
    assert.equal(radioPrepared.form.readyToSubmit, true); assert.equal(radioPrepared.form.fields.find((field) => field.identifier === "workPattern" && field.checked)?.value, "Office");
    setFormSnapshot(radioApp, radioPrepared.form); radioApp.autonomousAuthorization.formHash = radioApp.form!.hash; radioApp.status = "submitting"; persisted = radioApp;
    const radioResult = await submitBrowser(radioApp, { profile: radioState.profile, job: radioJob, beforeAttempt: async (baseline) => { assertAutonomous(radioApp, radioState.profile, radioJob, "submit"); radioApp.submissionAttemptedAt = baseline.attemptedAt; radioApp.submissionVerification = baseline; return true; } });
    assert.equal(radioResult.confirmed, true); assert.equal(counts.get("radio-human"), 1); assert.deepEqual(radioApp.approvals, []);
    await cancelBrowser(radioApp); console.log("PASS automatic radio-human: persisted owner answer matched the exact group, selected the opaque native value, and submitted once");
    radioNativeVariant = "changed";
    const changedJob = radioJob;
    const changedApp = structuredClone(radioApp);
    changedApp.status = "filling"; changedApp.form = undefined; changedApp.browserSessionId = undefined; changedApp.submissionAttemptedAt = undefined; changedApp.submissionVerification = undefined; changedApp.submissionReceipt = undefined;
    const changed = await prepareBrowser(changedApp, changedJob, radioState.profile, async (session) => { changedApp.browserSessionId = session.sessionId; return true; }, async () => { assertAutonomous(changedApp, radioState.profile, changedJob, "fill"); return true; });
    assert.equal(changed.form.readyToSubmit, false); assert.match(changed.form.blockers?.join(" ") || "", /exact option|complete the field/i);
    await cancelBrowser(changedApp); console.log("PASS automatic radio-changed: native option mutation remained blocked before any write");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
