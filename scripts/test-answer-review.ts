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
    for (const [label, width, height] of ([["desktop", 1440, 1000], ["mobile", 390, 844]] as const).filter(([label]) => !process.env.TEST_VIEWPORT || label === process.env.TEST_VIEWPORT)) {
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
      let confirmations = 0;
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
          state.profile = { ...state.profile, ...payload };
        } else if (action === "editPacket") {
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
      assert.equal(await essayInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), true);
      assert.equal(await humanInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), false);
      assert.equal(await humanInput.inputValue(), "");
      assert.equal(await page.getByRole("button", { name: "Approve packet for form fill", exact: true }).isDisabled(), true);
      await page.getByText("Before approving", { exact: true }).waitFor();
      assert.equal(await page.locator(".packet-readiness").getByRole("link", { name: "Answer 1 personal question" }).count(), 1);
      assert.equal(await page.locator(".packet-readiness").getByRole("link", { name: "Review and confirm 1 essay" }).count(), 1);
      await page.getByText("Facts used in this essay", { exact: true }).click();
      await page.locator(".screening-answer details li").first().waitFor();
      assert.equal(await page.locator(".screening-answer details li").first().innerText(), fact.text);
      await page.screenshot({ path: `.data/answer-review-${label}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "No horizontal overflow");
      await humanInput.fill("My own verified answer");
      await page.getByRole("link", { name: "Save your changed answers" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Confirm essay", exact: true }).isDisabled(), true, "Unsaved answers must be saved first");
      await page.getByRole("button", { name: "Save my answers", exact: true }).click();
      await page.getByRole("button", { name: "Confirm essay", exact: true }).waitFor();
      await page.waitForFunction(() => !(document.querySelector(".screening-answer button") as HTMLButtonElement)?.disabled);
      assert.equal(edits, 1);
      await page.getByText("Your answers are saved.", { exact: true }).waitFor();
      assert.equal(await essayInput.inputValue(), essay.answer);
      await page.getByRole("button", { name: "Confirm essay", exact: true }).click();
      await page.getByText("AI essay · confirmed by you", { exact: true }).waitFor();
      assert.equal(confirmations, 1);
      assert.equal(await page.getByRole("button", { name: "Approve packet for form fill", exact: true }).isDisabled(), false);
      assert.equal(app.approvals.length, 0);
      await page.getByRole("button", { name: "Edit wording", exact: true }).click();
      assert.equal(await essayInput.evaluate((el) => (el as HTMLTextAreaElement).readOnly), false);
      assert.equal(await page.getByRole("button", { name: "Approve packet for form fill", exact: true }).isDisabled(), true);
      await essayInput.fill("I would like to apply my survey analysis project experience to this role.");
      await page.getByRole("button", { name: "Save essay revision", exact: true }).click();
      await page.getByText("Edited by you · your confirmation needed", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve packet for form fill", exact: true }).isDisabled(), true);
      assert.equal(app.packet!.answers[0].userRevision?.originalAnswer, essay.answer);
      assert.deepEqual(app.packet!.answers[0].factIds, []);
      await page.getByRole("button", { name: "Confirm essay", exact: true }).click();
      await page.getByText("Edited by you · confirmed by you", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve packet for form fill", exact: true }).isEnabled(), true);
      assert.equal(app.approvals.length, 0);

      await page.locator(".material-tools > summary").click();
      await page.getByRole("button", { name: "Write essays with AI", exact: true }).click();
      await page.getByText("AI essay · your confirmation needed", { exact: true }).waitFor();
      assert.equal(await humanInput.inputValue(), "My own verified answer");
      assert.equal(await page.getByRole("button", { name: "Approve packet for form fill", exact: true }).isDisabled(), true);

      await page.getByRole("button", { name: "Correct or unconfirm source facts", exact: true }).first().click();
      const factInput = page.getByLabel(`Correct source fact ${fact.id}`, { exact: true });
      await factInput.fill("Analyzed survey data in my Python coursework project");
      assert.equal(await page.locator(".fact-row").filter({ has: factInput }).getByRole("checkbox").isChecked(), false);
      await page.getByRole("button", { name: "Save facts and return to application", exact: true }).click();
      await page.getByText("Source facts saved. Rebuild the resume and review it before approving.", { exact: true }).waitFor();
      assert.equal(state.profile.facts.find(item => item.id === fact.id)?.verified, false);
      assert.equal(app.approvals.length, 0);
      assert.deepEqual(failures, []);
      console.log(`PASS ${label}: editable essay with preserved original, fresh confirmation, contextual fact correction, separate approval, prerequisite guidance`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
