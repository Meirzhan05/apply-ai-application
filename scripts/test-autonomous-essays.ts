import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initialDemoState } from "../src/lib/demo-data";
import { activateAutomation, saveOnboarding } from "../src/lib/onboarding";
import { authorizeKnownAnswerApplication, assertAutonomous, sealAutonomousPacket, assertAutonomousDestination } from "../src/lib/autonomous-policy";
import { prepareAutonomousFormEssays } from "../src/lib/autonomous-essays";
import { selectApplication, setPacket, setFormSnapshot } from "../src/lib/workflow";
import { withPacketFiles } from "../src/lib/packet-files";
import { packetProfileHash } from "../src/lib/drafting";
import { hashJson } from "../src/lib/crypto";
import { prepareBrowser, submitBrowser, cancelBrowser } from "../src/lib/browser-runner";
import type { Application } from "../src/lib/types";

async function main() {
  const usageDirectory = await mkdtemp(path.join(tmpdir(), "apply-essay-usage-"));
  Object.assign(process.env, { NODE_ENV: "test", MODEL_USAGE_TEST_DIR: usageDirectory, SERVICE_COSTS_TEST_DIR: usageDirectory, BROWSER_USAGE_TEST_DIR: usageDirectory });
  process.env.DEMO_MODE = "true"; process.env.OPENAI_API_KEY = "controlled-local-provider";
  const modes = ["grounded", "general", "conditional", "conditional-late", "factual-age", "cover-disabled", "failed-grounding", "optional"];
  assert.ok(!process.env.TEST_ESSAY_CASE || modes.includes(process.env.TEST_ESSAY_CASE), "Unknown controlled essay case");
  let mode = "grounded"; let app: Application | undefined; let posted = 0; let generations = 0;
  const state = initialDemoState(); state.profile.id = randomUUID();
  const profile = state.profile; const fact = profile.facts.find((item) => item.verified)!;
  const question = "Describe a challenging project.";
  const nativeFetch = globalThis.fetch;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/responses") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString());
      const generation = body.text.format.name === "application_essay"; if (generation) generations++;
      const output = generation ? { sentences: mode === "general" ? [
        { text: "A useful way to approach a difficult project is to clarify the constraints and test the riskiest assumption first.", kind: "perspective", factIds: [] },
        { text: "Small experiments can help evaluate tradeoffs without assuming a particular personal history or result.", kind: "perspective", factIds: [] },
      ] : [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "Small experiments can help evaluate technical tradeoffs.", kind: "perspective", factIds: [] }] } : { grounded: mode !== "failed-grounding", unsupportedClaims: mode === "failed-grounding" ? ["No supported claim"] : [] };
      response.end(JSON.stringify({ id: `response-${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model, output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } } })); return;
    }
    response.setHeader("Content-Type", "text/html");
    if (request.method === "POST") {
      assert.ok(app?.submissionAttemptedAt); posted++; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString();
      if (mode !== "optional") assert.ok(body.includes(mode === "general" ? "A useful way" : fact.text));
      response.end("<h1>Application received</h1>"); return;
    }
    const label = mode === "factual-age" ? "Describe your relevant experience and confirm your age." : mode === "cover-disabled" ? "Explain your interest in this role in a cover letter." : question;
    const followup = '<label>Describe a relevant experience.<textarea name="followup" required></textarea></label>';
    const essay = `<label>${label}<textarea name="essay" ${mode === "conditional-late" ? `oninput="if(!document.getElementById('followup').innerHTML)document.getElementById('followup').innerHTML=decodeURIComponent('${encodeURIComponent(followup)}')"` : ""} ${mode === "optional" ? "" : "required"}></textarea></label>`;
    response.end(`<form method="post" enctype="multipart/form-data"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input type="email" name="email" required></label><label>Resume<input type="file" name="resume" required ${mode === "conditional" ? `onchange="document.getElementById('conditional').innerHTML=decodeURIComponent('${encodeURIComponent(essay)}')"` : ""}></label>${mode === "conditional" ? '<div id="conditional"></div>' : essay}${mode === "conditional-late" ? '<div id="followup"></div>' : ""}<button>Submit application</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://localhost:${address.port}`;
  process.env.OPENAI_BASE_URL = `${origin}/v1`;
  globalThis.fetch = (input, init) => { const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); if (url.origin !== origin) throw new Error("External requests are disabled for this controlled test."); return nativeFetch(input, init); };
  try {
    for (mode of modes.filter((item) => !process.env.TEST_ESSAY_CASE || item === process.env.TEST_ESSAY_CASE)) {
      posted = 0; generations = 0; state.applications = [];
      saveOnboarding(profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); profile.automationSettings!.coverLetterMode = "disabled"; activateAutomation(profile, "synthetic essay test");
      const job = { ...state.jobs[0], url: `${origin}/?mode=${mode}`, applyUrl: `${origin}/?mode=${mode}` }; state.jobs = [job];
      app = selectApplication(state, job.id, profile.id); authorizeKnownAnswerApplication(app, profile, job);
      setPacket(state, app, await withPacketFiles(profile, { schemaVersion: 1, version: 1, model: "verified-template", summary: "Synthetic essay test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], profileHash: packetProfileHash(profile), createdAt: new Date().toISOString() })); sealAutonomousPacket(app); app.status = "filling";
      const active = app;
      try {
        const result = await prepareBrowser(active, job, profile, async (opened) => { active.browserSessionId = opened.sessionId; return true; }, async () => { assertAutonomous(active, profile, job, "fill"); return true; }, undefined, async (observed) => {
          assertAutonomousDestination(active, observed); const packet = await prepareAutonomousFormEssays(profile, job, active, observed, async () => assertAutonomous(active, profile, job, "fill")); active.packet = packet; active.packetHash = hashJson(packet); sealAutonomousPacket(active); return packet;
        });
        if (["factual-age", "cover-disabled"].includes(mode)) { assert.equal(result.needsAction, true); assert.equal(generations, 0); assert.equal(posted, 0); console.log(`PASS ${mode}: missing declaration/material setting remained a blocker`); continue; }
        assert.equal(result.needsAction, false); setFormSnapshot(active, result.form); active.autonomousAuthorization!.formHash = active.form!.hash; assertAutonomous(active, profile, job, "submit"); active.status = "submitting";
        const submitted = await submitBrowser(active, { profile, job, beforeAttempt: async (baseline) => { assertAutonomous(active, profile, job, "submit"); active.submissionAttemptedAt = baseline.attemptedAt; active.submissionVerification = baseline; return true; } });
        assert.equal(submitted.confirmed, true); assert.equal(posted, 1); assert.equal(generations, mode === "optional" ? 0 : mode === "conditional-late" ? 2 : 1); assert.equal(active.approvals.length, 0); assert.ok(active.packet!.answers.every((answer) => !answer.confirmedAt)); console.log(`PASS ${mode}: one controlled submission, exact grounded answer, no legacy approvals`);
      } catch (error) { if (mode !== "failed-grounding") throw error; assert.match(String(error), /grounded truthfully/); assert.equal(posted, 0); console.log("PASS failed-grounding: no answer written or submitted"); }
      finally { await cancelBrowser(active); await rm(`.data/screenshots/${active.id}.png`, { force: true }); await rm(`.data/screenshots/${active.id}-confirmation.png`, { force: true }); }
    }
  } finally { globalThis.fetch = nativeFetch; await new Promise<void>((resolve) => server.close(() => resolve())); await rm(`.data/application-files/${profile.id}`, { recursive: true, force: true }); await rm(usageDirectory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
