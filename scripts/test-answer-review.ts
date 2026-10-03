import { saveOnboarding } from "../src/lib/onboarding";
import { applyFactCorrection } from "../src/lib/fact-corrections";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { applyHumanAnswerEdits, confirmReviewedEssay, reviseEssay, essayContentHash, essayEvidenceHash } from "../src/lib/answer-policy";
import { answerReviewHash } from "../src/lib/answer-responsibility";
import { packetProfileHash } from "../src/lib/drafting";
import { withPacketFiles } from "../src/lib/packet-files";
import { selectApplication, setPacket } from "../src/lib/workflow";
import type { ScreeningAnswer } from "../src/lib/types";

async function main() {
  const origin = process.env.TEST_DASHBOARD_URL || "http://localhost:3000";
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  await mkdir(".data", { recursive: true });
  try {
    for (const [label, width, height] of ([["desktop", 1440, 1000], ["mobile", 390, 844], ["narrow", 320, 740]] as const).filter(([label]) => !process.env.TEST_VIEWPORT || label === process.env.TEST_VIEWPORT)) {
      const state = initialDemoState();
      const app = selectApplication(state, state.jobs[0].id, state.profile.id);
      const fact = state.profile.facts[0];
      const essay: ScreeningAnswer = { question: "Why are you excited to join us?", answer: `${fact.text} I want to bring this experience to a team building useful tools.`, author: "ai", factIds: [fact.id], requiresUserInput: true,
        aiDraft: { version: 1, model: "controlled-fixture", contentHash: "", evidenceHash: essayEvidenceHash(state.profile, [fact.id]), sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "I want to bring this experience to a team building useful tools.", kind: "perspective", factIds: [] }] } };
      essay.aiDraft!.contentHash = essayContentHash(essay);
      const human: ScreeningAnswer = { question: "Are you legally authorized to work in the United States?", answer: "", factIds: [], requiresUserInput: true, author: "human" };
      setPacket(state, app, await withPacketFiles(state.profile, { schemaVersion: 1, version: 1, summary: "Synthetic review", model: "fixture", createdAt: new Date().toISOString(), profileHash: packetProfileHash(state.profile), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [essay, human] }));
      const page = await browser.newPage({ viewport: { width, height } });
      const failures: string[] = [];
      page.on("pageerror", (error) => failures.push(error.message));
      await page.route("**/api/state", (route) => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let confirmations = 0; let failFactSave = true; let failAnswerSave = true;
      let edits = 0;
      await page.route("**/api/actions", async (route) => {
        const { action, payload } = route.request().postDataJSON();
        if (action !== "profile") assert.equal(payload.applicationId, app.id);
        if (action === "confirmEssay") {
          assert.equal(payload.packetHash, app.packetHash);
          assert.equal(payload.answerIndex, 0);
          assert.equal(payload.answerHash, answerReviewHash(app.packet!.answers[0]));
          const answers = [...app.packet!.answers];
          answers[0] = confirmReviewedEssay(state.profile, answers[0]);
          setPacket(state, app, await withPacketFiles(state.profile, { ...app.packet!, version: app.packet!.version + 1, answers }));
          confirmations++;
        } else if (action === "reviseEssay") {
          assert.equal(payload.packetHash, app.packetHash);
          assert.equal(payload.answerHash, answerReviewHash(app.packet!.answers[0]));
          const answers = [...app.packet!.answers];
          answers[0] = reviseEssay(state.profile, answers[0], payload.text);
          setPacket(state, app, await withPacketFiles(state.profile, { ...app.packet!, version: app.packet!.version + 1, answers }));
        } else if (action === "profile") {
          if (failFactSave) { failFactSave = false; return route.fulfill({ status: 503, json: { error: "The save service is temporarily unavailable. Try again in a moment." } }); }
          saveOnboarding(state.profile, { facts: applyFactCorrection(state.profile.facts, payload.factPatch) });
        } else if (action === "editPacket") {
          if (failAnswerSave) { failAnswerSave = false; return route.fulfill({ status: 503, json: { error: "The save service is temporarily unavailable. Try again in a moment." } }); }
          const answers = applyHumanAnswerEdits(app.packet!.answers, payload.answers);
          setPacket(state, app, await withPacketFiles(state.profile, { ...app.packet!, version: app.packet!.version + 1, profileHash: packetProfileHash(state.profile), answers }));
          edits++;
        } else if (action === "draft") {
          const answers = app.packet!.answers.map((answer, index) => index === 0 ? { ...essay, confirmedAt: undefined, requiresUserInput: true } : answer);
          setPacket(state, app, await withPacketFiles(state.profile, { ...app.packet!, version: app.packet!.version + 1, answers }));
        } else throw new Error(`Unexpected UI action ${action}`);
        await route.fulfill({ json: { ok: true } });
      });
      await page.goto(origin);
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      const essayInput = page.getByLabel(essay.question, { exact: true });
      const humanInput = page.getByLabel(human.question, { exact: true });
      await essayInput.waitFor();
      const orientation = page.locator(".packet-orientation");
      await orientation.getByRole("heading", { name: "2 things before approval", exact: true }).waitFor();
      assert.equal(await orientation.getByRole("link", { name: "1 personal answer", exact: true }).count(), 1);
      assert.equal(await orientation.getByRole("link", { name: "1 essay to confirm", exact: true }).count(), 1);
      const summaryBox = await orientation.boundingBox(); const resumeBox = await page.locator(".resume-preview").boundingBox();
      assert.ok(summaryBox && resumeBox && summaryBox.y < resumeBox.y, "Remaining tasks must precede the document review");
      assert.ok(summaryBox.y < height, "The task summary must begin in the first viewport");
      if (width <= 650) assert.ok(summaryBox.y + summaryBox.height <= height - 100, "The pending tasks must fit on phone with space to begin reviewing");
      assert.equal(await essayInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), true);
      assert.equal(await humanInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), false);
      assert.equal(await humanInput.inputValue(), "");
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), true);
      await page.getByText("Before approving", { exact: true }).waitFor();
      assert.equal(await page.locator(".packet-readiness").getByRole("link", { name: "Answer 1 personal question" }).count(), 1);
      assert.equal(await page.locator(".packet-readiness").getByRole("link", { name: "Review and confirm 1 essay" }).count(), 1);
      {
        for (const control of [page.locator(".target-url a"), page.getByRole("button", { name: "Edit wording", exact: true }), page.locator(".essay-evidence > summary"), page.locator(".packet-readiness").getByRole("link", { name: "Answer 1 personal question", exact: true })]) {
          const box = await control.boundingBox(); assert.ok(box && box.height >= 44, "Essential phone review controls need a44px hit area");
        }
      }
      await page.getByText("Facts used in this essay", { exact: true }).click();
      await page.locator(".screening-answer details li").first().waitFor();
      assert.equal(await page.locator(".screening-answer details li").first().innerText(), fact.text);
      await page.screenshot({ path: `.data/answer-review-${label}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "No horizontal overflow");
      await humanInput.fill("My own verified answer");
      await orientation.getByRole("link", { name: "Save answer changes", exact: true }).waitFor();
      assert.equal(await orientation.getByRole("link", { name: "1 personal answer", exact: true }).count(), 0, "An entered answer needs saving rather than answering again");
      await page.getByRole("link", { name: "Save your changed answers" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Confirm essay", exact: true }).isDisabled(), true, "Unsaved answers must be saved first");
      const saveAnswers = page.getByRole("button", { name: "Save my answers", exact: true });
      await saveAnswers.focus(); await saveAnswers.press("Enter");
      const localError = page.locator(".packet-readiness .application-save-error"); await localError.waitFor();
      assert.equal(await page.locator(".inline-error").count(), 0, "Local save recovery must not compete with global refresh guidance");
      await page.waitForFunction(id => document.activeElement?.id === id, `save-answers-${app.id}`);
      assert.equal(await humanInput.inputValue(), "My own verified answer");
      const errorBox = await localError.boundingBox(); const viewport = page.viewportSize()!;
      assert.ok(errorBox && errorBox.y >= 0 && errorBox.y + errorBox.height <= viewport.height, "Save failure must be visible beside the initiating action");
      await saveAnswers.click();
      await page.getByRole("button", { name: "Confirm essay", exact: true }).waitFor();
      await page.waitForFunction(() => !(document.querySelector(".screening-answer button") as HTMLButtonElement)?.disabled);
      assert.equal(edits, 1);
      await page.getByText("Your answers are saved.", { exact: true }).waitFor();
      assert.equal(await essayInput.inputValue(), essay.answer);
      await page.getByRole("button", { name: "Confirm essay", exact: true }).click();
      await page.getByText("AI essay · confirmed by you", { exact: true }).waitFor();
      await page.waitForFunction(id => document.activeElement?.id === `readiness-${id}`, app.id);
      assert.equal(confirmations, 1);
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), false);
      assert.equal(app.approvals.length, 0);
      const editWording = page.getByRole("button", { name: "Edit wording", exact: true });
      await editWording.focus(); await editWording.press("Enter");
      assert.equal(await essayInput.evaluate(element => element === document.activeElement), true, "Keyboard editing must enter the textarea");
      await page.getByRole("button", { name: "Cancel editing", exact: true }).click();
      assert.equal(await editWording.evaluate(element => element === document.activeElement), true, "Cancellation must restore the editing launcher");
      await editWording.press("Enter");
      assert.equal(await essayInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), false);
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), true);
      await essayInput.fill("Discard this essay before correcting a fact.");
      await page.getByRole("button", { name: "Correct or unconfirm source facts", exact: true }).first().click();
      await page.getByRole("dialog", { name: "Keep your changes?" }).getByRole("button", { name: "Discard and continue", exact: true }).click();
      await page.getByRole("dialog", { name: "Correct the source facts", exact: true }).getByRole("button", { name: "Cancel corrections", exact: true }).click();
      assert.equal(await essayInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), true);
      assert.equal(await essayInput.inputValue(), essay.answer);
      await page.getByRole("button", { name: "Edit wording", exact: true }).click();
      await essayInput.fill("I would like to apply my survey analysis project experience to this role.");
      await page.getByRole("button", { name: "Matches", exact: true }).click();
      await page.getByRole("dialog", { name: "Keep your changes?" }).getByRole("button", { name: "Stay here", exact: true }).click();
      assert.equal(await essayInput.inputValue(), "I would like to apply my survey analysis project experience to this role.", "Navigation cancellation preserves essay wording");
      await page.getByRole("button", { name: "Save essay revision", exact: true }).click();
      await page.getByText("Edited by you · your confirmation needed", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), true);
      assert.equal(app.packet!.answers[0].userRevision?.originalAnswer, essay.answer);
      assert.deepEqual(app.packet!.answers[0].factIds, []);
      await page.getByRole("button", { name: "Confirm essay", exact: true }).click();
      await page.getByText("Edited by you · confirmed by you", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isEnabled(), true);
      assert.equal(app.approvals.length, 0);

      await page.locator(".material-tools > summary").click();
      await page.getByRole("button", { name: "Write essays with AI", exact: true }).click();
      await page.getByText("AI essay · your confirmation needed", { exact: true }).waitFor();
      assert.equal(await humanInput.inputValue(), "My own verified answer");
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), true);

      await page.getByRole("button", { name: "Correct or unconfirm source facts", exact: true }).first().click();
      const corrections = page.getByRole("dialog", { name: "Correct the source facts", exact: true });
      const factInput = corrections.getByLabel("Source fact 1", { exact: true });
      const editorBox = await factInput.boundingBox();
      const rowBox = await factInput.locator("..").boundingBox();
      assert.ok(editorBox && rowBox && editorBox.width >= rowBox.width - 2 && editorBox.height >= 96, "Source correction must provide a readable full-width editor");
      assert.equal(await corrections.locator("textarea").count(), 1, "A narrow correction must show only the selected source fact");
      assert.equal(await page.getByRole("heading", { name: "Your profile", exact: true }).count(), 0);
      const unrelatedFacts = structuredClone(state.profile.facts.filter(item => item.id !== fact.id));
      await factInput.fill("Discarded fact correction");
      await corrections.getByRole("button", { name: "Cancel corrections", exact: true }).click();
      assert.equal(state.profile.facts.find(item => item.id === fact.id)?.text, fact.text);
      await page.getByRole("button", { name: "Correct or unconfirm source facts", exact: true }).first().click();
      assert.equal(await factInput.inputValue(), fact.text);
      await factInput.fill("Analyzed survey data in my Python coursework project");
      assert.equal(await factInput.locator("..").getByRole("checkbox").isChecked(), false);
      await page.getByRole("button", { name: "Save facts and return to application", exact: true }).click();
      await corrections.getByRole("alert").waitFor();
      assert.equal(await page.locator(".inline-error").count(), 0, "Correction recovery must have one local instruction");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-describedby") === "correction-save-error");
      const correctionError = await corrections.getByRole("alert").boundingBox();
      assert.ok(correctionError && correctionError.y >= 0 && correctionError.y + correctionError.height <= height, "Correction save error must stay visible after failure");
      await page.keyboard.press("Tab");
      assert.equal(await corrections.getByRole("button", { name: "Cancel corrections", exact: true }).evaluate(element => element === document.activeElement), true);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await corrections.getByRole("button", { name: "Save facts and return to application", exact: true }).evaluate(element => element === document.activeElement), true);
      assert.equal(await factInput.inputValue(), "Analyzed survey data in my Python coursework project");
      assert.equal(state.profile.facts.find(item => item.id === fact.id)?.text, fact.text);
      const checkboxWidth = await corrections.getByRole("checkbox").evaluate(element => element.getBoundingClientRect().width);
      assert.ok(checkboxWidth >= 16 && checkboxWidth <= 24, "Source confirmation must stay beside its label");
      await page.getByRole("button", { name: "Save facts and return to application", exact: true }).click();
      await page.locator(".materials-update").getByText("Source facts saved. Rebuild the materials and review them before approving.", { exact: true }).waitFor();
      assert.equal(state.profile.facts.find(item => item.id === fact.id)?.verified, false);
      assert.deepEqual(state.profile.facts.filter(item => item.id !== fact.id), unrelatedFacts);
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), true);
      await page.getByRole("button", { name: "Rebuild materials from updated facts", exact: true }).waitFor();
      assert.equal(await page.locator(".packet-orientation a").count(), 1, "Only the available rebuild task should be linked while materials are stale");
      assert.equal(await page.locator(".packet-readiness").getByText("Ready for your approval", { exact: true }).count(), 0);
      await page.reload();
      await page.getByRole("button", { name: "Undo source fact changes", exact: true }).waitFor();
      await page.getByText("Undo is available in this browser tab, including after a reload,", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Undo source fact changes", exact: true }).click();
      await page.locator(".materials-update").getByText("Source fact correction undone. Rebuild the materials and review them before approving.", { exact: true }).waitFor();
      assert.deepEqual(state.profile.facts.find(item => item.id === fact.id), fact);
      assert.deepEqual(state.profile.facts.filter(item => item.id !== fact.id), unrelatedFacts);
      assert.equal(await page.getByRole("button", { name: "Undo source fact changes", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Rebuild materials from updated facts", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("button", { name: "Approve materials for form filling", exact: true }).isDisabled(), true, "Undo must not imply materials are ready without rebuilding");
      assert.equal(app.approvals.length, 0);
      assert.deepEqual(failures, []);
      console.log(`PASS ${label}: editable essay with preserved original, fresh confirmation, contextual fact correction, separate approval, prerequisite guidance`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
