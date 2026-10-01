import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Page } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { draftPacket } from "../src/lib/drafting";
import { prepareBrowser, repairEducationFields, refreshBrowserSnapshot, submitBrowser, cancelBrowser, fillApprovedBrowserAnswers } from "../src/lib/browser-runner";
import { browserQuestions, browserTakeoverReasons } from "../src/lib/browser-questions";
import { approveBrowserAnswers } from "../src/lib/browser-question-approval";
import { approveFill, approveSubmit, selectApplication, setFormSnapshot, setPacket } from "../src/lib/workflow";
import type { Application } from "../src/lib/types";
import { hashJson } from "../src/lib/crypto";
import { essayContentHash, essayEvidenceHash } from "../src/lib/answer-policy";

async function main() {
process.env.DEMO_MODE = "true";
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.OPENAI_API_KEY;
const submissions = new Map<string, number>();
const uploadAttempts = new Map<string, number>();
const results: Array<{ test: string; passed: boolean }> = [];
const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://localhost");
  const scenario = url.searchParams.get("scenario") || "normal";
  if (request.method === "POST" && url.pathname === "/upload") {
    const attempt = (uploadAttempts.get(scenario) || 0) + 1;
    uploadAttempts.set(scenario, attempt);
    const explicitRetry = url.searchParams.get("retry") === "1";
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (!explicitRetry) request.destroy();
    });
    request.on("end", () => {
      if (!explicitRetry) return;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ uploaded: bytes > 0 }));
    });
    return;
  }
  if (request.method === "POST") {
    submissions.set(scenario, (submissions.get(scenario) || 0) + 1);
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "text/html");
      if (scenario === "slow-confirmation") setTimeout(() => response.end("<h1>Application received</h1>"), 12000);
      else response.end(scenario === "uncertain" ? "<h1>Processing request</h1>" : "<h1>Application received</h1>");
    });
    return;
  }
  response.setHeader("Content-Type", "text/html");
  if (scenario === "delayed-form") {
    response.end(`<html><body><input type="file" style="display:none"><script>setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<form><label>First name<input required></label><label>Email<input type="email" required></label><label>Resume<input type="file" required></label><button>Submit application</button></form>'); }, 900);</script></body></html>`);
    return;
  }
  if (scenario === "posting-page") {
    response.end('<html><body><h1>Public job posting</h1><button type="button">Apply</button></body></html>');
    return;
  }
  if (url.pathname === "/recaptcha/api2/bframe") {
    response.end("<html><body>Synthetic challenge frame</body></html>");
    return;
  }
  const group = (question: string, name: string, options: string[], required = true) => `<fieldset><label class="ashby-application-form-question-title ${required ? "_required_fixture" : ""}">${question}</label>${options.map((option, index) => `<input type="radio" name="${name}" id="${name}-${index}"><label for="${name}-${index}">${option}</label>`).join("")}</fieldset>`;
  const education = `<fieldset><label class="ashby-application-form-question-title _required_fixture">What University do you currently attend?</label><input role="combobox" aria-autocomplete="list" aria-controls="schools" placeholder="Start typing..."><ul id="schools" role="listbox" hidden></ul></fieldset>${group("What is your anticipated graduation season?", "graduation", ["Winter 2027", "Spring 2027", "Fall 2027"])}<label>Name pronunciation<input name="pronunciation"></label><script>
    const school=document.querySelector('[role=combobox]'); const list=document.querySelector('#schools');
    const choices=${JSON.stringify(scenario === "education-exact" ? ["Stetson University", "Other"] : scenario === "education-no-other" ? ["Stanford University"] : ["Stanford University", "Other"])};
    function show(query) { list.hidden=false; list.innerHTML=''; for(const text of choices.filter(choice => choice.toLowerCase().includes(query.toLowerCase()))) {const option=document.createElement('li'); option.setAttribute('role','option'); option.textContent=text; option.addEventListener('click',()=>{school.value=text; school.dataset.selected='true'; list.hidden=true; if(text==='Other' && !document.querySelector('[name=otherSchool]')) school.closest('fieldset').insertAdjacentHTML('afterend','<label>If you selected Other above, please list what school you attended<input name="otherSchool" required></label>'); });list.append(option);} }
    school.addEventListener('input',()=>show(school.value));school.addEventListener('keydown',event=>{if(event.key==='ArrowDown')show(school.value)});
    </script>`;
  const extra = scenario.startsWith("education-") ? education : scenario.startsWith("grouped") ? `<label>Preferred First & Last Name<input name="preferred" required></label><label>Why are you excited to join us?<textarea required></textarea></label>${group("Which office would you prefer?", "office", ["San Francisco office", "New York office", "No preference"])}${group("Are you legally authorized to work in the United States?", "authorization", ["Yes", "No"])}${group("Will you now or in the future require visa sponsorship?", "sponsorship", ["Yes", "No"])}${group("How did you hear about this opportunity?", "source", Array.from({length:35}, (_, i) => `Source ${i}`))}<label><input type="checkbox" name="newsletter">Subscribe to newsletter</label><fieldset><label class="ashby-application-form-question-title _required_fixture">What University do you currently attend?</label><input role="combobox" aria-autocomplete="list" placeholder="Start typing..."><ul role="listbox" hidden><li role="option">${initialDemoState().profile.school}</li></ul></fieldset><script>document.querySelector('[name=resume]').addEventListener('change', () => {const hidden=document.createElement('input'); hidden.type='hidden'; document.querySelector('form').prepend(hidden)}); const school=document.querySelector('[role=combobox]'); school.addEventListener('input', () => {document.querySelector('[role=listbox]').hidden=false}); document.querySelector('[role=option]').addEventListener('click', () => {school.dataset.selected='true'; document.querySelector('[role=listbox]').hidden=true});</script>`
    : scenario === "complex" ? Array.from({ length: 41 }, (_, i) => `<label>Optional question ${i}<input name="optional-${i}"></label>`).join("")
    : scenario === "questions" ? `${group("Will you now or in the future require visa sponsorship?", "questionSponsor", ["Yes", "No"])}<label>Favorite snack<select name="snack" required><option value="">Choose</option><option>Chips</option><option>Fruit</option></select></label><label>Why are you excited to join us?<textarea name="why" required></textarea></label><label>Optional nickname<input name="nickname"></label>`
    : scenario === "unknown" ? '<label>Do you hold a secret clearance?<input name="clearance" required></label>'
    : scenario === "login" ? '<label>Password<input type="password"></label>'
    : scenario === "captcha" ? '<div data-sitekey="fixture">CAPTCHA takeover fixture</div>'
    : scenario === "recaptcha-recovery" || scenario === "captcha-active-challenge" || scenario === "captcha-wrong-provider" ? `<div class="g-recaptcha" data-sitekey="fixture">reCAPTCHA takeover fixture</div><textarea name="g-recaptcha-response" style="display:none"></textarea>${scenario === "captcha-active-challenge" ? '<iframe src="/recaptcha/api2/bframe" title="reCAPTCHA challenge"></iframe>' : scenario === "captcha-wrong-provider" ? '<input type="hidden" name="h-captcha-response" value="unrelated-provider-response">' : ""}`
    : scenario === "hcaptcha-recovery" ? '<div class="h-captcha" data-sitekey="fixture">hCaptcha takeover fixture</div><input type="hidden" name="h-captcha-response">'
    : scenario === "consent" ? '<label><input name="consent" type="checkbox" required>Accept application terms</label>'
    : scenario === "cover" ? '<label>Cover letter<input name="letter" type="file" required></label>'
    : scenario === "custom-control" ? '<div role="combobox" aria-required="true">Choose your degree</div>'
    : scenario === "aria-required" ? '<label>Portfolio<input name="portfolio" aria-required="true"></label>'
    : scenario === "upload-pending" ? '<div role="status" aria-busy="true">Uploading resume…</div>' : "";
  const uploadScript = scenario === "upload-rejected" ? `<script>document.querySelector('[name="resume"]').addEventListener('change', () => { const error=document.createElement('p'); error.setAttribute('role','alert'); error.textContent='Resume upload failed: file rejected'; document.querySelector('form').append(error); });</script>`
    : scenario === "upload-delayed" ? `<script>document.querySelector('[name="resume"]').addEventListener('change', () => { const status=document.createElement('p'); status.setAttribute('role','status'); status.setAttribute('aria-busy','true'); status.textContent='Uploading resume'; document.querySelector('form').append(status); setTimeout(()=>status.remove(),600); });</script>`
    : scenario === "upload-interrupted" ? `<script>
      const resume=document.querySelector('[name="resume"]');
      async function uploadResume(event) {
        document.querySelector('#upload-error')?.remove();
        document.querySelector('#upload-result')?.remove();
        const status=document.createElement('p'); status.setAttribute('role','status'); status.setAttribute('aria-busy','true'); status.textContent='Uploading resume'; document.querySelector('form').append(status);
        try {
          const response=await fetch('/upload?scenario=upload-interrupted' + (event.type === 'click' ? '&retry=1' : ''), {method:'POST', body:resume.files[0]});
          if (!response.ok || !(await response.json()).uploaded) throw new Error('Upload rejected');
          const result=document.createElement('p'); result.id='upload-result'; result.textContent='Resume uploaded'; document.querySelector('form').append(result);
        } catch {
          const error=document.createElement('p'); error.id='upload-error'; error.setAttribute('role','alert'); error.textContent='Resume upload failed: interrupted connection'; document.querySelector('form').append(error);
        } finally {status.remove();}
      }
      resume.addEventListener('change',uploadResume);
      const retry=document.createElement('button'); retry.type='button'; retry.textContent='Retry resume upload'; retry.addEventListener('click',uploadResume); document.querySelector('form').append(retry);
      </script>` : "";
  const resume = scenario === "greenhouse-style" ? '<label for="resume">Attach</label><input id="resume" type="file" required>' : '<label>Resume<input name="resume" type="file" required></label>';
  const shortcut = scenario === "greenhouse-style" ? '<button type="button">Apply</button>' : scenario === "ambiguous-action" ? '<button type="button">Submit</button>' : "";
  const submitLabel = scenario === "ambiguous-action" ? "Apply" : "Submit application";
  response.end(`<html><body>${shortcut}<form method="POST" enctype="multipart/form-data"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" type="email" required></label>${resume}${extra}<button>${submitLabel}</button></form>${uploadScript}</body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const base = `http://127.0.0.1:${address.port}`;
const liveApps: Application[] = [];

async function fill(scenario: string, onSession?: Parameters<typeof prepareBrowser>[3]) {
  const state = initialDemoState();
  if (scenario.startsWith("education-")) { state.profile.school = "Stetson University"; state.profile.graduationYear = scenario === "education-year-only" ? "2027" : "May 2027 (expected)"; }
  const job = { ...state.jobs[0], applyUrl: `${base}/apply?scenario=${scenario}`, url: `${base}/apply?scenario=${scenario}` };
  state.jobs[0] = job;
  const app = selectApplication(state, job.id, state.profile.id);
  liveApps.push(app);
  const packet = await draftPacket(state.profile, job);
  packet.answers = [];
  if (scenario.startsWith("grouped")) {
    const fact = state.profile.facts[0];
    const essay = { question: "Why are you excited to join us?", answer: fact.text, factIds: [fact.id], author: "ai" as const, requiresUserInput: false, confirmedAt: new Date().toISOString(), aiDraft: { version: 1 as const, model: "synthetic-test-fixture", sentences: [{text:fact.text, kind:"fact" as const, factIds:[fact.id]}], evidenceHash:essayEvidenceHash(state.profile,[fact.id]), contentHash:"", generatedAt:new Date().toISOString() } };
    essay.aiDraft.contentHash = essayContentHash(essay);
    packet.answers = [essay, ...[
      ["Which office would you prefer?", "San Francisco"],
      ["Are you legally authorized to work in the United States?", "Yes"],
      ["Will you now or in the future require visa sponsorship?", scenario === "grouped-ambiguous" ? "Not now. I can do OPT" : "No"],
      ["How did you hear about this opportunity?", "Source 17"],
    ].map(([question, answer]) => ({question, answer, factIds:[], author:"human" as const, userProvided:true, requiresUserInput:false}))];
    // The answers are part of the approval fingerprint, not a human rewrite of an AI essay.
    assert.notEqual(hashJson(packet.answers), hashJson([]));
  }
  setPacket(state, app, packet);
  approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
  app.status = "filling";
  const result = await prepareBrowser(app, job, state.profile, onSession);
  app.browserSessionId = result.sessionId;
  app.browserConnectUrl = result.connectUrl;
  return { state, app, result };
}
function pageFor(app: Application): Page {
  const runtime = globalThis as unknown as { applyAiLocalBrowsers: Map<string, { page: Page }> };
  return runtime.applyAiLocalBrowsers.get(app.browserSessionId!)!.page;
}
async function test(name: string, run: () => Promise<void>) {
  if (process.env.TEST_BROWSER_CASE && !name.includes(process.env.TEST_BROWSER_CASE)) return;
  await run();
  results.push({ test: name, passed: true });
  console.log(`PASS ${name}`);
}
try {
  await test("in-app questions: a required checkbox is filled only after explicit agreement", async () => {
    const { state, app, result } = await fill("consent"); setFormSnapshot(app, result.form);
    const question = browserQuestions(app.form)[0];
    assert.equal(question.kind, "checkbox"); assert.deepEqual(question.options, []);
    assert.throws(() => approveBrowserAnswers(app, state.profile, app.form!.hash, [{ questionId: question.id, value: "No" }]), /exact option/);
    assert.equal(await pageFor(app).locator('[name=consent]').isChecked(), false);
    const approvals = approveBrowserAnswers(app, state.profile, app.form!.hash, [{ questionId: question.id, value: "Yes" }]);
    app.browserAnswerApprovals = approvals; app.browserQuestionRun = { token: "consent", startedAt: new Date().toISOString(), kind: "answers" }; app.status = "filling";
    const form = await fillApprovedBrowserAnswers(app, app.jobSnapshot!, state.profile, approvals);
    assert.equal(await pageFor(app).locator('[name=consent]').isChecked(), true);
    assert.equal(form.readyToSubmit, true); assert.equal(submissions.get("consent"), undefined);
  });
  await test("in-app questions: explicit human answers and confirmed AI essay resume the same browser without submitting", async () => {
    const { state, app, result } = await fill("questions");
    setFormSnapshot(app, result.form);
    const questions = browserQuestions(app.form);
    assert.equal(questions.length, 3);
    assert.equal(browserTakeoverReasons(app.form).length, 0);
    const ai = questions.find(question => question.owner === "ai")!;
    const fact = state.profile.facts[0];
    const essay = { question: ai.label, answer: fact.text, factIds: [fact.id], author: "ai" as const, requiresUserInput: true, aiDraft: { version: 1 as const, model: "synthetic", sentences: [{ text: fact.text, kind: "fact" as const, factIds: [fact.id] }], evidenceHash: essayEvidenceHash(state.profile, [fact.id]), contentHash: "" } };
    essay.aiDraft.contentHash = essayContentHash(essay);
    app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId!, packetHash: app.packetHash!, answers: { [ai.id]: essay } };
    const approvals = approveBrowserAnswers(app, state.profile, app.form!.hash, questions.map(question => question.owner === "ai" ? { questionId: question.id, confirmEssay: true, answerHash: essay.aiDraft.contentHash } : { questionId: question.id, value: question.label.includes("sponsorship") ? "No" : "Chips" }));
    app.browserAnswerApprovals = approvals; app.browserQuestionRun = { token: "questions", startedAt: new Date().toISOString(), kind: "answers" }; app.status = "filling";
    const originalSession = app.browserSessionId;
    const form = await fillApprovedBrowserAnswers(app, app.jobSnapshot!, state.profile, approvals);
    assert.equal(app.browserSessionId, originalSession); assert.equal(form.readyToSubmit, true);
    assert.equal(form.fields.find(field => field.identifier === "questionSponsor" && field.value === "No")?.checked, true);
    assert.equal(form.fields.find(field => field.identifier === "snack")?.value, "Chips");
    assert.equal(form.fields.find(field => field.identifier === "why")?.value, fact.text);
    assert.equal(form.fields.find(field => field.identifier === "nickname")?.value, "");
    assert.equal(submissions.get("questions"), undefined);
    setFormSnapshot(app, form); assert.equal(app.status, "final_review");
    await assert.rejects(() => submitBrowser(app), /both approvals/);
  });
  await test("in-app questions: a changed live form receives no stale answers", async () => {
    const { state, app, result } = await fill("unknown"); setFormSnapshot(app, result.form);
    const question = browserQuestions(app.form)[0];
    const approvals = approveBrowserAnswers(app, state.profile, app.form!.hash, [{ questionId: question.id, value: "No" }]);
    app.browserAnswerApprovals = approvals; app.browserQuestionRun = { token: "changed", startedAt: new Date().toISOString(), kind: "answers" }; app.status = "filling";
    await pageFor(app).locator('[name=email]').fill("human-edit@example.com");
    const form = await fillApprovedBrowserAnswers(app, app.jobSnapshot!, state.profile, approvals);
    assert.equal(form.fields.find(field => field.identifier === "clearance")?.value, "");
    assert.equal(form.fields.find(field => field.identifier === "email")?.value, "human-edit@example.com");
    assert.equal(submissions.get("unknown"), undefined);
  });
  await test("in-app questions: cancellation stops writes before a field is filled", async () => {
    const { state, app, result } = await fill("unknown"); setFormSnapshot(app, result.form);
    const question = browserQuestions(app.form)[0];
    const approvals = approveBrowserAnswers(app, state.profile, app.form!.hash, [{ questionId: question.id, value: "No" }]);
    app.browserAnswerApprovals = approvals; app.browserQuestionRun = { token: "cancel", startedAt: new Date().toISOString(), kind: "answers" }; app.status = "filling";
    await assert.rejects(() => fillApprovedBrowserAnswers(app, app.jobSnapshot!, state.profile, approvals, async () => false), /stopped/);
    assert.equal(await pageFor(app).locator('[name=clearance]').inputValue(), "");
  });
  for (const scenario of ["education-other", "education-exact", "education-no-other", "education-year-only"]) await test(`${scenario}: handles known education without guessing or requesting optional details`, async () => {
    const {state, app, result} = await fill(scenario);
    const page = pageFor(app);
    assert.equal(await page.locator('[name=pronunciation]').inputValue(), "");
    assert.equal(result.form.blockers?.some(blocker => /pronunciation/.test(blocker)), false);
    assert.equal(await page.locator('#graduation-1').isChecked(), scenario !== 'education-year-only');
    if (scenario === 'education-exact') {
      assert.equal(await page.locator('[role=combobox]').inputValue(), state.profile.school);
      assert.equal(await page.locator('[name=otherSchool]').count(), 0);
    } else if (scenario !== 'education-no-other') {
      assert.equal(await page.locator('[role=combobox]').inputValue(), 'Other');
      assert.equal(await page.locator('[name=otherSchool]').inputValue(), state.profile.school);
    } else assert.equal(await page.locator('[role=combobox]').inputValue(), '');
    assert.equal(result.form.readyToSubmit, ['education-other','education-exact'].includes(scenario));
    assert.equal(submissions.get(scenario), undefined);
    if (scenario === 'education-other') {
      await page.locator('[name=otherSchool]').fill('');
      await page.locator('[name=email]').fill('takeover-edit@example.com');
      await page.locator('#graduation-1').evaluate(element => { (element as HTMLInputElement).checked = false; });
      setFormSnapshot(app, await refreshBrowserSnapshot(app));
      assert.equal(app.status, 'needs_user_action');
      const repaired = await repairEducationFields(app, app.jobSnapshot!, state.profile);
      assert.equal(repaired.readyToSubmit, true);
      assert.equal(await page.locator('[name=otherSchool]').inputValue(), state.profile.school);
      assert.equal(await page.locator('[name=email]').inputValue(), 'takeover-edit@example.com');
      assert.equal(await page.locator('#graduation-1').isChecked(), true);
      const approvals = app.approvals; app.approvals=[];
      await assert.rejects(() => repairEducationFields(app, app.jobSnapshot!, state.profile), /requires fill approval/);
      app.approvals=approvals; app.submissionAttemptedAt = new Date().toISOString();
      await assert.rejects(() => repairEducationFields(app, app.jobSnapshot!, state.profile), /cannot be filled again/);
    }
    await cancelBrowser(app);
  });
  await test("delayed hydration fills approved details after the real form appears", async () => {
    const {state, app, result} = await fill("delayed-form");
    assert.equal(result.needsAction, false);
    assert.equal(result.form.fields.find((field) => field.label === "Email")?.value, state.profile.email);
    assert.ok(result.form.attachments.length);
    assert.equal(submissions.get("delayed-form"), undefined);
    await cancelBrowser(app);
  });
  for (const scenario of ["grouped", "grouped-ambiguous"]) await test(`${scenario}: fills approved essays and choices after upload shifts indexes, with more than 40 native controls`, async () => {
    const {state, app, result} = await fill(scenario);
    const page = pageFor(app);
    assert.ok(result.form.fields.length > 40);
    assert.equal(result.form.fields.find((field) => field.label === "Preferred First & Last Name")?.value, state.profile.name);
    assert.equal(await page.locator("textarea").inputValue(), app.packet!.answers[0].answer);
    assert.equal(await page.locator("#authorization-0").isChecked(), true);
    assert.equal(await page.locator("#office-0").isChecked(), true);
    assert.equal(await page.locator("#source-17").isChecked(), true);
    assert.equal(await page.locator("[name=newsletter]").isChecked(), false);
    assert.equal(await page.locator("[role=combobox]").getAttribute("data-selected"), "true");
    assert.equal(result.form.readyToSubmit, scenario === "grouped");
    assert.equal(await page.locator("#sponsorship-1").isChecked(), scenario === "grouped");
    if (scenario === "grouped-ambiguous") {
      assert.equal(await page.locator("#sponsorship-0").isChecked(), false);
      assert.ok(result.form.blockers?.some((blocker) => /Choose an exact option.*sponsorship/.test(blocker)));
    } else {
      setFormSnapshot(app, result.form);
      approveSubmit(app, state.profile.id, app.form!.hash);
      await page.locator("#authorization-0").uncheck().catch(async () => page.locator("#authorization-0").evaluate((element) => { (element as HTMLInputElement).checked = false; }));
      await assert.rejects(() => submitBrowser(app), /FORM_CHANGED/);
    }
    assert.equal(submissions.get(scenario), undefined);
    await cancelBrowser(app);
  });
  await test("cancellation before filling releases the newly created browser", async () => {
    let sessionId: string | undefined;
    await assert.rejects(() => fill("cancel-before-fill", async (session) => {
      sessionId = session.sessionId;
      return false;
    }), /cancelled before filling/);
    assert.ok(sessionId);
    const runtime = globalThis as unknown as { applyAiLocalBrowsers: Map<string, unknown> };
    assert.equal(runtime.applyAiLocalBrowsers.has(sessionId), false);
    assert.equal(submissions.get("cancel-before-fill"), undefined);
  });
  await test("fills a valid form, hashes uploaded PDF bytes, submits once, verifies confirmation", async () => {
    const { state, app, result } = await fill("normal");
    assert.equal(result.needsAction, false);
    assert.equal(result.form.readyToSubmit, true);
    const file = app.packet!.files![0];
    assert.equal(result.form.fields.find((field) => field.kind === "file")?.fileHashes?.[0], `${file.filename}:${file.size}:${file.sha256}`, "Uploaded PDF must be the exact file in the approved packet");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal((await submitBrowser(app)).confirmed, true);
    await assert.rejects(() => submitBrowser(app), /both approvals/);
    assert.equal(submissions.get("normal"), 1);
  });
  await test("observes a slow confirmation after click timeout without clicking twice", async () => {
    const { state, app, result } = await fill("slow-confirmation");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal((await submitBrowser(app)).confirmed, true);
    assert.equal(submissions.get("slow-confirmation"), 1);
    await assert.rejects(() => submitBrowser(app), /both approvals/);
  });
  await test("a complex form remains open for takeover and requires a fresh review", async () => {
    const { state, app, result } = await fill("complex");
    assert.equal(result.needsAction, true);
    assert.equal(result.form.readyToSubmit, false);
    assert.ok(result.form.blockers?.some((blocker) => /more than 40 fields/.test(blocker)));
    const page = pageFor(app);
    assert.equal(page.isClosed(), false);
    assert.equal(await page.locator('[name="email"]').inputValue(), "", "The agent must pause before entering details on a complex form");
    setFormSnapshot(app, result.form);
    assert.throws(() => approveSubmit(app, state.profile.id, app.form!.hash), /form changed/i);
    await page.locator('[name="firstName"]').fill("Synthetic");
    await page.locator('[name="lastName"]').fill("Takeover");
    await page.locator('[name="email"]').fill("takeover@example.com");
    await page.locator('[name="resume"]').setInputFiles({ name: "takeover-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("Synthetic takeover fixture") });
    setFormSnapshot(app, await refreshBrowserSnapshot(app));
    assert.equal(app.form!.readyToSubmit, true);
    assert.equal(app.form!.fields.find((field) => field.label === "Email")?.value, "takeover@example.com");
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal(submissions.get("complex"), undefined);
    await cancelBrowser(app);
    assert.equal(page.isClosed(), true);
  });
  await test("Greenhouse-style Attach control uploads the resume and ignores the Apply shortcut", async () => {
    const { state, app, result } = await fill("greenhouse-style");
    assert.equal(result.needsAction, false);
    assert.ok(result.form.fields.find((field) => field.kind === "file")?.fileHashes?.length);
    assert.equal(result.form.submitControl?.label, "Submit application");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal((await submitBrowser(app)).confirmed, true);
    assert.equal(submissions.get("greenhouse-style"), 1);
  });
  await test("a posting-page Apply shortcut cannot be approved as a completed application", async () => {
    const { app, result } = await fill("posting-page");
    assert.equal(result.needsAction, true);
    assert.equal(result.form.readyToSubmit, false);
    assert.ok(result.form.blockers?.some((blocker) => /No application fields/.test(blocker)));
    assert.equal(pageFor(app).isClosed(), false);
    assert.equal(submissions.get("posting-page"), undefined);
    await cancelBrowser(app);
  });
  await test("an unrelated Submit button cannot replace the actual application's Apply action", async () => {
    const { app, result } = await fill("ambiguous-action");
    assert.equal(result.needsAction, true);
    assert.equal(result.form.readyToSubmit, false);
    assert.ok(result.form.blockers?.some((blocker) => /ambiguous/.test(blocker)));
    assert.equal(submissions.get("ambiguous-action"), undefined);
    await cancelBrowser(app);
  });
  for (const scenario of ["unknown", "login", "captcha", "consent", "cover", "custom-control", "aria-required", "upload-rejected", "upload-pending"]) {
    await test(`requires takeover for ${scenario}`, async () => {
      const { app, result } = await fill(scenario);
      assert.equal(result.needsAction, true);
      assert.equal(result.form.readyToSubmit, false);
      if (scenario === "cover") assert.equal(result.needsCoverLetter, true);
      app.form = { ...result.form, hash: "unapproved" };
      app.status = "final_review";
      assert.throws(() => approveSubmit(app, app.userId, "unapproved"), /form changed/i);
      assert.equal(submissions.get(scenario), undefined);
      await cancelBrowser(app);
    });
  }
  for (const [scenario, responseName] of [["recaptcha-recovery", "g-recaptcha-response"], ["hcaptcha-recovery", "h-captcha-response"]]) {
    await test(`completed ${scenario} permits review; expiry invalidates approval before a click`, async () => {
      const { state, app, result } = await fill(scenario);
      assert.equal(result.needsAction, true);
      const responseField = pageFor(app).locator(`[name="${responseName}"]`);
      assert.equal(await responseField.inputValue(), "", "The agent must leave CAPTCHA responses alone");
      await responseField.evaluate((element) => { (element as HTMLInputElement).value = "synthetic-human-completion"; (element as HTMLElement).style.display = "block"; });
      setFormSnapshot(app, await refreshBrowserSnapshot(app));
      assert.equal(app.form!.readyToSubmit, true, "Completed widget remains visible but must not permanently block review");
      assert.equal(JSON.stringify(app.form).includes("synthetic-human-completion"), false, "Provider response must not be persisted in the review packet");
      approveSubmit(app, state.profile.id, app.form!.hash);
      await responseField.evaluate((element) => { (element as HTMLInputElement).value = ""; });
      await assert.rejects(() => submitBrowser(app), /FORM_CHANGED/);
      assert.equal(submissions.get(scenario), undefined);
      app.status = "final_review";
      setFormSnapshot(app, await refreshBrowserSnapshot(app));
      assert.equal(app.status, "needs_user_action");
      assert.throws(() => approveSubmit(app, state.profile.id, app.form!.hash), /form changed/i);
      await responseField.evaluate((element) => { (element as HTMLInputElement).value = "synthetic-second-completion"; });
      setFormSnapshot(app, await refreshBrowserSnapshot(app));
      approveSubmit(app, state.profile.id, app.form!.hash);
      assert.equal((await submitBrowser(app)).confirmed, true);
      assert.equal(submissions.get(scenario), 1);
    });
  }
  await test("a response for another CAPTCHA provider does not unblock reCAPTCHA", async () => {
    const { app, result } = await fill("captcha-wrong-provider");
    assert.equal(result.needsAction, true);
    assert.equal(result.form.readyToSubmit, false);
    await cancelBrowser(app);
  });
  await test("a visible challenge still blocks review when an earlier response exists", async () => {
    const { app } = await fill("captcha-active-challenge");
    await pageFor(app).locator('[name="g-recaptcha-response"]').evaluate((element) => { (element as HTMLTextAreaElement).value = "synthetic-old-response"; });
    const reviewed = await refreshBrowserSnapshot(app);
    assert.equal(reviewed.readyToSubmit, false);
    assert.ok(reviewed.blockers?.some((blocker) => /CAPTCHA/.test(blocker)));
    assert.equal(submissions.get("captcha-active-challenge"), undefined);
    await cancelBrowser(app);
  });
  await test("a delayed upload completes before final review", async () => {
    const { app, result } = await fill("upload-delayed");
    assert.equal(result.needsAction, false);
    assert.equal(result.form.readyToSubmit, true);
    await cancelBrowser(app);
  });
  await test("a network-interrupted upload blocks submission until user retry and fresh approval", async () => {
    const { state, app, result } = await fill("upload-interrupted");
    assert.ok((uploadAttempts.get("upload-interrupted") || 0) >= 1, "The test must exercise an actual HTTP upload");
    assert.equal(result.needsAction, true, JSON.stringify({ uploadAttempts: uploadAttempts.get("upload-interrupted"), ready: result.form.readyToSubmit, blockers: result.form.blockers }));
    assert.equal(result.form.readyToSubmit, false);
    assert.ok(result.form.fields.find((field) => field.kind === "file")?.fileHashes?.length, "Selected PDF bytes remain present despite the failed upload");
    assert.ok(result.form.blockers?.some((blocker) => /interrupted connection/.test(blocker)));
    setFormSnapshot(app, result.form);
    assert.throws(() => approveSubmit(app, state.profile.id, app.form!.hash), /form changed/i);
    assert.equal(submissions.get("upload-interrupted"), undefined);
    const fileHash = result.form.fields.find((field) => field.kind === "file")!.fileHashes;
    await pageFor(app).getByRole("button", { name: "Retry resume upload" }).click();
    await pageFor(app).locator("#upload-result").waitFor({ state: "visible", timeout: 5000 });
    setFormSnapshot(app, await refreshBrowserSnapshot(app));
    assert.equal(app.form!.readyToSubmit, true, JSON.stringify({ uploadAttempts: uploadAttempts.get("upload-interrupted"), blockers: app.form!.blockers }));
    assert.deepEqual(app.form!.fields.find((field) => field.kind === "file")!.fileHashes, fileHash, "User retry must upload the same approved file");
    assert.equal(app.approvals.some((approval) => approval.kind === "submit"), false);
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal((await submitBrowser(app)).confirmed, true);
    assert.equal(submissions.get("upload-interrupted"), 1);
  });
  await test("a changed submit destination invalidates approval without a click", async () => {
    const { state, app, result } = await fill("destination-change");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    await pageFor(app).locator("form").evaluate((form) => { (form as HTMLFormElement).action = "/different-destination"; });
    await assert.rejects(() => submitBrowser(app), /FORM_CHANGED/);
    assert.equal(submissions.get("destination-change"), undefined);
    await cancelBrowser(app);
  });
  await test("a replaced file with the same filename invalidates final approval", async () => {
    const { state, app, result } = await fill("file-change");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    await pageFor(app).locator('input[type="file"]').setInputFiles({ name: "tailored-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from("Different content") });
    await assert.rejects(() => submitBrowser(app), /FORM_CHANGED/);
    assert.equal(submissions.get("file-change"), undefined);
    app.status = "final_review";
    setFormSnapshot(app, await refreshBrowserSnapshot(app));
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal((await submitBrowser(app)).confirmed, true);
    assert.equal(submissions.get("file-change"), 1);
  });
  await test("a new required question invalidates approval and requires takeover", async () => {
    const { state, app, result } = await fill("changed-form");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    await pageFor(app).evaluate(() => { const input = document.createElement("input"); input.name = "new_question"; input.required = true; document.querySelector("form")!.append(input); });
    await assert.rejects(() => submitBrowser(app), /FORM_CHANGED/);
    assert.equal(submissions.get("changed-form"), undefined);
    await cancelBrowser(app);
  });
  await test("ambiguous confirmation never triggers a second click", async () => {
    const { state, app, result } = await fill("uncertain");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    assert.equal((await submitBrowser(app)).confirmed, false);
    await assert.rejects(() => submitBrowser(app), /both approvals/);
    assert.equal(submissions.get("uncertain"), 1);
  });
  await test("cancellation releases the session; expiry cannot submit", async () => {
    const { state, app, result } = await fill("cancel");
    setFormSnapshot(app, result.form);
    approveSubmit(app, state.profile.id, app.form!.hash);
    await cancelBrowser(app);
    await assert.rejects(() => submitBrowser(app), /session expired/);
    assert.equal(submissions.get("cancel"), undefined);
  });
  assert.ok(results.length, "No browser cases matched TEST_BROWSER_CASE");
  console.log(JSON.stringify({ browserCases: results.length, passed: results.length }));
} finally {
  await Promise.allSettled(liveApps.map((app) => cancelBrowser(app)));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
