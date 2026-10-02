import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rm, writeFile } from "node:fs/promises";
import { initialDemoState } from "../src/lib/demo-data";
import { activateAutomation, saveOnboarding } from "../src/lib/onboarding";
import { authorizeKnownAnswerApplication, assertAutonomous, sealAutonomousPacket } from "../src/lib/autonomous-policy";
import { selectApplication, setPacket, setFormSnapshot } from "../src/lib/workflow";
import { withPacketFiles } from "../src/lib/packet-files";
import { packetProfileHash, withGroundedCoverLetter } from "../src/lib/drafting";
import { bytesHash } from "../src/lib/resume-artifacts";
import { originalResumeManifest, saveDemoOriginalResume } from "../src/lib/original-resume";
import { hashJson } from "../src/lib/crypto";
import { prepareBrowser, submitBrowser, cancelBrowser } from "../src/lib/browser-runner";
import type { Application, Job } from "../src/lib/types";

async function main() {
  process.env.DEMO_MODE = "true"; delete process.env.OPENAI_API_KEY;
  let app: Application | undefined;
  const received = new Map<string, Buffer>();
  const modes = ["original-pdf", "original-docx", "original-tampered", "docx-rejected", "required-letter", "required-letter-mime-rejected", "disabled-letter", "optional-letter", "enabled-letter"];
  assert.ok(!process.env.TEST_MATERIAL_CASE || modes.includes(process.env.TEST_MATERIAL_CASE), "Unknown controlled material case");
  const server = createServer((request, response) => {
    const mode = new URL(request.url!, "http://localhost").searchParams.get("mode");
    if (!mode || !modes.includes(mode)) { response.statusCode = 404; response.end(); return; }
    response.setHeader("Content-Type", "text/html");
    if (request.method === "POST") {
      assert.ok(app?.submissionAttemptedAt); assert.equal(received.has(mode), false);
      const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { received.set(mode, Buffer.concat(chunks)); response.end("<h1>Application received</h1>"); });
    } else response.end(`<form method="post" enctype="multipart/form-data"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" type="email" required></label><label>Resume<input type="file" name="resume" ${mode === "docx-rejected" ? 'accept=".pdf"' : ''} required></label>${mode.includes("letter") ? `<label>Cover letter<input type="file" name="cover" ${mode === "required-letter-mime-rejected" ? 'accept=".docx"' : ""} ${["required-letter", "required-letter-mime-rejected", "disabled-letter"].includes(mode) ? 'required' : ''}></label>` : ''}<button>Submit application</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    for (const mode of modes.filter((item) => !process.env.TEST_MATERIAL_CASE || item === process.env.TEST_MATERIAL_CASE)) {
      const state = initialDemoState(); const profile = state.profile;
      saveOnboarding(profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } });
      profile.automationSettings!.coverLetterMode = mode === "disabled-letter" ? "disabled" : mode === "enabled-letter" ? "enabled" : "required-only";
      const original = ["original-pdf", "original-docx", "original-tampered", "docx-rejected"].includes(mode);
      const extension = mode === "original-pdf" ? "pdf" : "docx";
      const bytes = Buffer.from(extension === "pdf" ? "%PDF-confirmed-original-material" : "PK-confirmed-original-docx-material");
      const key = `${profile.id}/${randomUUID()}.${extension}`;
      if (original) {
        profile.automationSettings!.resumeTailoring = false; profile.resumeFileName = `My original résumé.${extension}`;
        profile.resumeSource = { storageKey: key, size: bytes.length, sha256: bytesHash(bytes), mimeType: extension === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }; await saveDemoOriginalResume(key, bytes);
      }
      activateAutomation(profile, "local synthetic material preference");
      const job: Job = { ...state.jobs[0], url: `http://localhost:${address.port}/?mode=${mode}`, applyUrl: `http://localhost:${address.port}/?mode=${mode}` }; state.jobs = [job];
      app = selectApplication(state, job.id, profile.id); authorizeKnownAnswerApplication(app, profile, job);
      const fact = profile.facts.find((item) => item.verified)!;
      let packet = await withPacketFiles(profile, { schemaVersion: 1, version: 1, resumeMode: original ? "original" : "tailored", ...(original ? { originalResume: originalResumeManifest(profile) } : {}), summary: "Synthetic materials", resumeLines: original ? [] : [{ text: fact.text, factIds: [fact.id] }], answers: [], profileHash: packetProfileHash(profile), model: "verified-template", createdAt: new Date().toISOString() });
      if (mode === "enabled-letter") packet = await withGroundedCoverLetter(profile, job, packet);
      setPacket(state, app, packet); sealAutonomousPacket(app); app.status = "filling";
      try {
        const active = app;
        if (mode === "original-tampered") {
          await writeFile(`.data/resumes/${key}`, Buffer.from("altered upload")); let allocated = false;
          await assert.rejects(prepareBrowser(active, job, profile, async () => { allocated = true; return true; }, async () => true), /original résumé bytes changed/);
          assert.equal(allocated, false); assert.equal(received.has(mode), false); console.log("PASS original-tampered: changed stored bytes blocked before browser allocation"); continue;
        }
        const result = await prepareBrowser(active, job, profile, async (opened) => { active.browserSessionId = opened.sessionId; return true; }, async () => { assertAutonomous(active, profile, job, "fill"); return true; }, async () => {
          const revised = await withGroundedCoverLetter(profile, job, active.packet!); active.packet = revised; active.packetHash = hashJson(revised); active.autonomousAuthorization!.requiredCoverLetter = true; sealAutonomousPacket(active); return revised;
        });
        if (["disabled-letter", "docx-rejected", "required-letter-mime-rejected"].includes(mode)) {
          assert.equal(result.needsAction, true); assert.equal(received.has(mode), false); if (mode !== "required-letter-mime-rejected") assert.equal(active.packet!.coverLetter, undefined);
          else { assert.ok(active.packet!.coverLetter); assert.match(result.form.blockers!.join(" "), /cover-letter control does not accept/); }
          if (mode === "docx-rejected") assert.match(result.form.blockers!.join(" "), /does not accept.*will not be converted/);
        } else {
          setFormSnapshot(active, result.form); active.autonomousAuthorization!.formHash = active.form!.hash; active.status = "submitting";
          const submitted = await submitBrowser(active, { profile, job, beforeAttempt: async (baseline) => { assertAutonomous(active, profile, job, "submit"); active.submissionAttemptedAt = baseline.attemptedAt; active.submissionVerification = baseline; return true; } });
          assert.equal(submitted.confirmed, true); const body = received.get(mode)!;
          if (original) assert.ok(body.includes(bytes), "Receiver must receive exact original bytes");
          const letter = ["required-letter", "enabled-letter"].includes(mode);
          assert.equal(body.includes(Buffer.from('filename="cover-letter.pdf"')), letter); assert.equal(Boolean(active.packet!.coverLetter), letter);
          if (letter) { const file = active.packet!.files!.find((item) => item.kind === "cover-letter")!; assert.ok(active.form!.fields.some((field) => field.fileHashes?.includes(`${file.filename}:${file.size}:${file.sha256}`)), JSON.stringify(active.form!.fields)); }
        }
        console.log(`PASS ${mode}: exact authorized artifacts, MIME preference and same-session letter continuation`);
      } finally { await cancelBrowser(app); if (original) await rm(`.data/resumes/${key}`, { force: true }); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
