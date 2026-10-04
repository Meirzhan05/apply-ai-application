import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { selectApplication, setFormSnapshot } from "../src/lib/workflow";
import { browserQuestions } from "../src/lib/browser-questions";
import { essayContentHash, essayEvidenceHash } from "../src/lib/answer-policy";
import type { ScreeningAnswer } from "../src/lib/types";

// Every dashboard API request is intercepted. This never fills or submits an employer form.
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  await mkdir(".data/ashby-questions", { recursive: true });
  try {
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const state = initialDemoState();
      const app = selectApplication(state, state.jobs[0].id, state.profile.id);
      state.applications = [app];
      app.browserSessionId = "synthetic-question-session";
      app.packetHash = "synthetic-packet";
      app.status = "filling";
      const question = "Tell us more: Tell us about something you built that no one asked you to. What was it, why did you build it, and what did you learn?";
      setFormSnapshot(app, { version: 1, url: state.jobs[0].applyUrl, attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: false, fields: [
        { identifier: "essay", label: question, kind: "textarea", required: true, valid: false, value: "" },
        { identifier: "linkedin", label: "LinkedIn", kind: "text", required: true, valid: false, value: "" },
        { identifier: "location", label: "Are you based in US or Canada?", kind: "yesno", required: true, valid: false, value: "", options: ["Yes", "No"] },
      ] });
      const questions = browserQuestions(app.form);
      const fact = state.profile.facts.find(item => item.verified)!;
      const essay: ScreeningAnswer = { question, answer: fact.text, author: "ai", requiresUserInput: true, factIds: [fact.id],
        aiDraft: { version: 1, model: "synthetic", contentHash: "", evidenceHash: essayEvidenceHash(state.profile, [fact.id]), sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }] } };
      essay.aiDraft!.contentHash = essayContentHash(essay);
      app.browserQuestionDrafts = { formHash: app.form!.hash, sessionId: app.browserSessionId, packetHash: app.packetHash, answers: { [questions[0].id]: essay } };
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let requests = 0;
      await page.route("**/api/actions", async route => {
        const { action, payload } = route.request().postDataJSON();
        assert.equal(action, "answerBrowserQuestions");
        assert.deepEqual(payload, { applicationId: app.id, formHash: app.form!.hash, answers: [
          { questionId: questions[0].id, confirmEssay: true, answerHash: essay.aiDraft!.contentHash },
          { questionId: questions[1].id, value: "https://www.linkedin.com/in/synthetic-applicant" },
          { questionId: questions[2].id, value: "No" },
        ] });
        requests++;
        await route.fulfill({ json: { ok: true } });
      });
      const enterApplications = async () => {
        const navigation = page.getByRole("button", { name: "Applications", exact: true });
        await navigation.waitFor();
        if (await navigation.getAttribute("aria-current") !== "page") await navigation.click();
      };
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3000");
      await enterApplications();
      const dialog = page.getByRole("dialog", { name: "Help the agent keep going" });
      await dialog.waitFor();
      assert.equal(await dialog.getByLabel(question, { exact: true }).inputValue(), fact.text);
      const linkedin = dialog.getByLabel("LinkedIn", { exact: true });
      assert.equal(await linkedin.inputValue(), "");
      const send = dialog.getByRole("button", { name: "Save answers and continue" });
      assert.equal(await send.isDisabled(), true);
      await linkedin.fill("https://www.linkedin.com/in/synthetic-applicant");
      await dialog.getByLabel("I reviewed and confirm this exact answer").check();
      assert.equal(await send.isDisabled(), true, "The location answer must be explicit");
      await dialog.getByLabel("Are you based in US or Canada?", { exact: true }).selectOption("No");
      assert.equal(await send.isEnabled(), true);
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await dialog.screenshot({ path: `.data/ashby-questions/${name}.png` });
      await send.click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(requests, 1);
      app.status = "uncertain";
      app.submissionAttemptedAt = new Date(Date.now() - 1000).toISOString();
      app.submissionReceipt = { version: 1, url: app.form!.url, capturedAt: new Date().toISOString(), text: "Your form needs corrections",
        validationErrors: ["Missing entry for required field: Are you based in US or Canada?"] };
      await page.reload();
      await enterApplications();
      await page.getByText("Employer form needs corrections", { exact: true }).waitFor();
      await page.getByText(app.submissionReceipt.validationErrors![0], { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Submit application once", exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `.data/ashby-questions/corrections-${name}.png`, fullPage: true });
      console.log(`PASS ${name}: full essay prompt, blank LinkedIn, explicit location choice, separate answer bindings, precise correction notice; intercepted synthetic state only`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
