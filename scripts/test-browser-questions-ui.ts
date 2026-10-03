import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { draftPacket } from "../src/lib/drafting";
import { publicState } from "../src/lib/public-state";
import { approveFill, selectApplication, setFormSnapshot, setPacket } from "../src/lib/workflow";
import { browserQuestions } from "../src/lib/browser-questions";
import { approveBrowserAnswers } from "../src/lib/browser-question-approval";
import { reviseEssay, essayContentHash, essayEvidenceHash } from "../src/lib/answer-policy";
import type { ScreeningAnswer } from "../src/lib/types";

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  await mkdir(".data/questions", { recursive: true });
  try {
    for (const [name, width, height] of ([["desktop", 1440, 1000], ["mobile", 390, 844]] as const).filter(([label]) => !process.env.TEST_VIEWPORT || label === process.env.TEST_VIEWPORT)) {
      const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
      const packet = await draftPacket(state.profile, state.jobs[0]); packet.answers = [];
      setPacket(state, app, packet); approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
      app.browserSessionId = "synthetic-questions-session";
      setFormSnapshot(app, { version: 1, url: state.jobs[0].applyUrl, capturedAt: new Date().toISOString(), readyToSubmit: false, attachments: [], fields: [
        { identifier: "sponsor", label: "Will you now or in the future require visa sponsorship?", kind: "select", required: true, valid: false, value: "", options: ["Yes", "No"] },
        { identifier: "why", label: "Why are you excited to join us?", kind: "textarea", required: true, valid: false, value: "" },
      ], blockers: ["Correct or complete the field: Will you now or in the future require visa sponsorship?", "Correct or complete the field: Why are you excited to join us?"] });
      const fact = state.profile.facts[0]; const ai = browserQuestions(app.form).find(question => question.owner === "ai")!;
      const essay: ScreeningAnswer = { question: ai.label, answer: `${fact.text} I want to bring this experience to a team building useful tools.`, author: "ai", requiresUserInput: true, factIds: [fact.id], aiDraft: { version: 1, model: "synthetic", contentHash: "", evidenceHash: essayEvidenceHash(state.profile, [fact.id]), sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "I want to bring this experience to a team building useful tools.", kind: "perspective", factIds: [] }] } };
      essay.aiDraft!.contentHash = essayContentHash(essay);
      app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId, packetHash: app.packetHash!, answers: { [ai.id]: essay } };
      const page = await browser.newPage({ viewport: { width, height } }); const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let attempts = 0;
      await page.route("**/api/actions", route => {
        const { action, payload } = route.request().postDataJSON();
        assert.equal(payload.applicationId, app.id);
        if (action === "reviseBrowserEssay") {
          assert.equal(payload.formHash, app.form!.hash);
          assert.equal(payload.questionId, ai.id);
          assert.equal(payload.sessionId, app.browserSessionId);
          assert.equal(payload.packetHash, app.packetHash);
          assert.equal(payload.answerHash, app.browserQuestionDrafts!.answers[ai.id].aiDraft!.contentHash);
          app.browserQuestionDrafts!.answers[ai.id] = reviseEssay(state.profile, app.browserQuestionDrafts!.answers[ai.id], payload.text);
          return route.fulfill({ json: { ok: true } });
        }
        assert.equal(action, "answerBrowserQuestions");
        const approvals = approveBrowserAnswers(app, state.profile, payload.formHash, payload.answers);
        assert.equal(approvals.find(approval => approval.question.identifier === "sponsor")?.answer.answer, "No");
        assert.equal(approvals.find(approval => approval.question.owner === "ai")?.answer.userRevision?.contentHash, app.browserQuestionDrafts!.answers[ai.id].userRevision!.contentHash);
        if (++attempts === 1) return route.fulfill({ status: 400, json: { error: "The form changed. Refresh its current state before answering." } });
        const form = { ...app.form!, readyToSubmit: true, blockers: [], fields: app.form!.fields.map(field => ({ ...field, valid: true, value: approvals.find(approval => approval.question.identifier === field.identifier)!.answer.answer })) };
        setFormSnapshot(app, form);
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3101");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Help the agent keep going" }); await dialog.waitFor();
      const send = dialog.getByRole("button", { name: "Save answers and continue" });
      assert.equal(await send.isDisabled(), true);
      await dialog.getByLabel("Will you now or in the future require visa sponsorship?", { exact: true }).selectOption("No");
      assert.equal(await dialog.locator("textarea").count(), 1);
      const essayInput = dialog.getByLabel(ai.label, { exact: true });
      assert.equal(await essayInput.evaluate(element => (element as HTMLTextAreaElement).readOnly), true);
      await dialog.getByLabel("I reviewed and confirm this exact answer").check();
      await dialog.getByRole("button", { name: "Edit wording", exact: true }).click();
      assert.equal(await send.isDisabled(), true);
      await essayInput.fill("I want to apply my survey project experience to this team.");
      await dialog.getByRole("button", { name: "Save essay revision", exact: true }).click();
      await dialog.getByText("Edited by you · your confirmation needed", { exact: true }).waitFor();
      assert.equal(await dialog.getByLabel("I reviewed and confirm this exact answer").isChecked(), false);
      assert.equal(await send.isDisabled(), true);
      await dialog.getByLabel("I reviewed and confirm this exact answer").check();
      assert.equal(await send.isEnabled(), true);
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Answer 2 questions" }).click();
      assert.equal(await dialog.getByRole("combobox").inputValue(), "No");
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await dialog.locator(".essay-evidence > summary").click();
      await dialog.evaluate(element => { element.scrollTop = 0; });
      await dialog.screenshot({ path: `.data/questions/${name}.png` });
      await send.click(); await dialog.getByRole("alert").waitFor();
      assert.match(await dialog.getByRole("alert").innerText(), /form changed/);
      await dialog.getByRole("alert").scrollIntoViewIfNeeded();
      await dialog.screenshot({ path: `.data/questions/error-${name}.png` });
      await send.click(); await dialog.waitFor({ state: "hidden" });
      await page.getByRole("heading", { name: "Final form review" }).waitFor();
      assert.equal(app.browserSessionId, "synthetic-questions-session"); assert.equal(app.status, "final_review");
      assert.equal(app.approvals.some(approval => approval.kind === "submit"), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      app.status = "needs_user_action"; app.form = { ...app.form!, readyToSubmit: false, blockers: ["CAPTCHA requires your takeover."] };
      await page.reload(); await page.getByRole("button", { name: "Applications", exact: true }).click();
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page.getByRole("heading", { name: "Browser help needed" }).waitFor();
      app.browserSessionExpiresAt = new Date(Date.now() - 1).toISOString();
      app.error = "The browser session ended. Restart it to continue.";
      await page.reload(); await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByRole("heading", { name: "Your browser session ended", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Refresh form state", exact: true }).count(), 0);
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.equal(await page.getByText("Complete the browser steps above, then refresh the form for review.", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Review packet for a new browser session", exact: true }).isVisible(), true);
      await page.screenshot({ path: `.data/questions/expired-${name}.png` });
      app.browserSessionExpiresAt = undefined; app.error = undefined;
      setFormSnapshot(app, { ...app.form!, readyToSubmit: false, blockers: [], fields: [
        ...app.form!.fields.map(field => ({ ...field, value: "", valid: false })),
        ...Array.from({ length: 12 }, (_, index) => ({ identifier: `detail-${index}`, label: `Applicant detail ${index + 1}`, kind: "text", required: true, value: "", valid: false })),
      ] });
      app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId!, packetHash: app.packetHash!, answers: { [ai.id]: essay } };
      await page.reload(); await page.getByRole("button", { name: "Applications", exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.evaluate(element => element.scrollHeight > element.clientHeight), true);
      await dialog.evaluate(element => { element.scrollTop = 0; });
      await dialog.screenshot({ path: `.data/questions/long-${name}.png` });
      await dialog.getByLabel("Applicant detail 12", { exact: true }).scrollIntoViewIfNeeded();
      await send.scrollIntoViewIfNeeded();
      assert.equal(await send.isVisible(), true);
      await dialog.screenshot({ path: `.data/questions/long-bottom-${name}.png` });
      setFormSnapshot(app, { ...app.form!, readyToSubmit: false, blockers: [], fields: [{ identifier: "consent", label: "Accept application terms", kind: "checkbox", required: true, value: "on", checked: false, valid: false }] });
      await page.reload(); await page.getByRole("button", { name: "Applications", exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.getByRole("combobox").count(), 0);
      assert.equal(await send.isDisabled(), true);
      await dialog.getByLabel("Accept application terms", { exact: true }).check();
      assert.equal(await send.isEnabled(), true);
      await dialog.screenshot({ path: `.data/questions/checkbox-${name}.png` });
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: batch popup, exact options, editable essay with fresh exact confirmation, preserved edits, visible errors, same session, separate submit approval, CAPTCHA fallback, no overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
