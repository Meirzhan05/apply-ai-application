import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { selectApplication, setPacket } from "../src/lib/workflow";
import { publicState } from "../src/lib/public-state";
import { packetProfileHash } from "../src/lib/drafting";
import { applyHumanAnswerEdits } from "../src/lib/answer-policy";

async function main() {
  const state = initialDemoState();
  const base = state.jobs[0];
  state.jobs = Array.from({ length: 6 }, (_, index) => ({ ...base, id: `navigation-${index}`, company: `Employer ${index + 1}`, title: `Application role ${index + 1}`, url: `https://example.com/${index}`, applyUrl: `https://example.com/${index}` }));
  for (const job of state.jobs) selectApplication(state, job.id, state.profile.id);
  state.applications.reverse();
  const first = state.applications[0];
  const completed = state.applications[5]; completed.status = "submitted"; completed.confirmation = "Synthetic employer confirmation."; completed.submittedAt = new Date().toISOString();
  const fact = state.profile.facts[0];
  setPacket(state, first, { schemaVersion: 1, files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), size: 1, factIds: [fact.id] }], version: 1, createdAt: new Date().toISOString(), model: "fixture", summary: "Navigation verification", profileHash: packetProfileHash(state.profile), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [{ question: "Are you legally authorized to work in the United States?", answer: "", author: "human", factIds: [], requiresUserInput: true }] });
  const other = state.applications[1];
  setPacket(state, other, { ...structuredClone(first.packet!), answers: [{ ...first.packet!.answers[0], answer: "Other employer answer", userProvided: true, requiresUserInput: false }] });
  assert.equal(applyHumanAnswerEdits(other.packet!.answers, [{ ...first.packet!.answers[0], answer: "Misplaced answer" }])[0].answer, "Misplaced answer", "Matching questions alone cannot establish application ownership");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const width of [320, 390, 820, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let saves = 0; let failSave = true;
      await page.route("**/api/actions", async route => {
        const { action, payload } = route.request().postDataJSON();
        assert.equal(action, "editPacket"); assert.equal(payload.applicationId, first.id);
        assert.equal(payload.answers[0].answer, "Unsaved applicant answer");
        if (failSave) return route.fulfill({ status: 503, json: { error: "Temporary save failure" } });
        first.packet!.answers = applyHumanAnswerEdits(first.packet!.answers, payload.answers); saves++;
        await route.fulfill({ json: { ok: true } });
      });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3126");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByText("Find or filter applications", { exact: true }).click();
      const appSearch = page.getByRole("searchbox", { name: "Search applications", exact: true });
      await appSearch.fill("Employer 2");
      await page.getByRole("heading", { name: "Application role 2", exact: true }).waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Your applications", exact: true }).waitFor();
      await page.getByRole("heading", { name: "Application role 2", exact: true }).waitFor();
      assert.equal(await page.locator(".application-active-view").isVisible(), true, "Restored constraints must remain visible outside the closed tools");
      assert.match(await page.locator(".application-active-view").innerText(), /Search: “Employer 2” · 1 of 6 applications/);
      await page.getByRole("button", { name: "Clear application filters", exact: true }).click();
      assert.equal(await page.locator(".application-collection option").count(), 6);
      await page.getByText("Find or filter applications", { exact: true }).click();
      assert.equal(await appSearch.inputValue(), "", "The visible reset must clear the restored search");
      await appSearch.fill("Employer 2");
      await page.getByRole("heading", { name: "Application role 2", exact: true }).waitFor();
      await appSearch.fill("");
      assert.equal(await page.getByRole("heading", { name: "Application role 2", exact: true }).isVisible(), true, "Clearing search should preserve a still-matching selection");
      await page.getByRole("button", { name: "Needs your review (2)", exact: true }).click();
      assert.equal(await page.getByRole("heading", { name: "Application role 2", exact: true }).isVisible(), true, "A filter should preserve the current application when it still matches");
      await page.getByRole("button", { name: "All applications (6)", exact: true }).click();
      await appSearch.fill("No such employer");
      await page.getByRole("heading", { name: "No applications match this view", exact: true }).waitFor();
      await page.getByRole("button", { name: "Show all applications", exact: true }).click();
      await page.getByRole("button", { name: "Needs your review (2)", exact: true }).click();
      assert.equal(await page.locator(".application-collection option").count(), 2);
      await page.getByRole("button", { name: "All applications (6)", exact: true }).click();
      if (width <= 900) await page.getByRole("combobox", { name: "Choose application", exact: true }).selectOption(first.id);
      else await page.locator(".app-list-item").first().click();
      await appSearch.blur();
      await page.keyboard.press("j");
      await page.getByRole("heading", { name: "Application role 2", exact: true }).waitFor();
      await page.keyboard.press("k");
      await page.getByRole("heading", { name: "Application role 1", exact: true }).waitFor();
      await page.keyboard.press("/");
      await page.waitForFunction(() => document.activeElement?.id === "application-search");
      assert.equal(await appSearch.evaluate(element => element === document.activeElement), true);
      await appSearch.fill("j");
      assert.equal(await appSearch.inputValue(), "j", "Shortcuts must pause while typing");
      await appSearch.fill(""); await appSearch.blur();
      await page.keyboard.press("?");
      const help = page.locator("#applications-help");
      const helpSearch = help.getByRole("searchbox", { name: "Find help for a task", exact: true });
      assert.equal(await help.locator(".help-task-group").count(), 3);
      for (const query of ["sources", "source facts", "submission"]) {
        await helpSearch.fill(query);
        assert.equal(await help.getByText("No matching topic.", { exact: false }).count(), 0, `Suggested query ${query} must find guidance`);
        assert.ok(await help.locator(".help-task-group details").count() > 0);
        assert.equal(await help.locator(".help-task-group details:not([open])").count(), 0, "Matching instructions should be visible immediately");
      }
      await helpSearch.fill("consent");
      assert.equal(await help.getByText("1 topic", { exact: true }).isVisible(), true);
      await help.getByText(/The agent does not infer work authorization/).waitFor();
      await helpSearch.fill("no-matching-help");
      await help.getByRole("button", { name: "Show all help", exact: true }).click();
      await help.locator(":scope > summary").click();
      const picker = page.getByRole("combobox", { name: "Choose application", exact: true });
      assert.match((await page.locator("#application-choice option").first().textContent()) ?? "", /Application role 1 · Employer 1 · Review materials/);
      if (width <= 900) {
        assert.equal(await page.getByText("Application 1 of 6", { exact: true }).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Previous application", exact: true }).isDisabled(), true);
        await picker.selectOption(state.applications[5].id);
        await page.getByRole("heading", { name: "Application role 6", exact: true }).waitFor();
        assert.equal(await page.getByText("Application 6 of 6", { exact: true }).isVisible(), true);
        if (width <= 650) assert.equal(await page.getByText("Application complete · Submission confirmed", { exact: true }).isVisible(), true);
        else assert.equal(await page.locator('.progress-desktop .done').count(), 5);
        assert.equal(await page.locator('.progress [aria-current="step"]').count(), 0);

        assert.equal(await page.getByRole("button", { name: "Next application", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Previous application", exact: true }).click();
        await page.getByRole("heading", { name: "Application role 5", exact: true }).waitFor();
        await picker.selectOption(first.id);
      } else {
        await page.locator(".application-stage-group > summary").filter({ hasText: "Completed attempts" }).click();
        await page.locator(".app-list-item").nth(5).click();
        await page.getByRole("heading", { name: "Application role 6", exact: true }).waitFor();
        assert.equal(await page.locator('.app-list-item[aria-pressed="true"]').count(), 1);
        assert.equal(await page.locator('.progress-desktop .done').count(), 5);
        assert.equal(await page.locator('.progress [aria-current="step"]').count(), 0);
        assert.equal(await page.locator('.progress-desktop').getByText("Submission confirmed", { exact: true }).isVisible(), true);

        await page.locator(".application-stage-group > summary").filter({ hasText: "Materials" }).click();
        await page.locator(".app-list-item").first().click();
      }
      await page.getByLabel(first.packet!.answers[0].question, { exact: true }).fill("Unsaved applicant answer");
      if (width <= 900) assert.equal(await picker.isDisabled(), true);
      else assert.equal(await page.locator(".app-list-item").nth(5).isDisabled(), true);
      await page.getByRole("button", { name: "Matches", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Keep your changes?" });
      await dialog.getByRole("button", { name: "Stay here", exact: true }).click();
      assert.equal(await page.getByLabel(first.packet!.answers[0].question, { exact: true }).inputValue(), "Unsaved applicant answer");
      await page.getByRole("button", { name: "Matches", exact: true }).click();
      await dialog.getByRole("button", { name: "Save and continue", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(await dialog.isVisible(), true, "A failed save must preserve the active draft");
      failSave = false;
      await dialog.getByRole("button", { name: "Save and continue", exact: true }).click();
      await page.getByRole("button", { name: /^View application for .*Employer 2/ }).click();
      await page.getByRole("heading", { name: "Application role 2", exact: true }).waitFor();
      assert.equal(await page.getByLabel(other.packet!.answers[0].question, { exact: true }).inputValue(), "Other employer answer", "Matches entry must not transfer answers");
      if (width <= 900) await picker.selectOption(first.id);
      else await page.locator(".app-list-item").first().click();
      assert.equal(await page.getByLabel(first.packet!.answers[0].question, { exact: true }).inputValue(), "Unsaved applicant answer");
      await page.getByLabel(first.packet!.answers[0].question, { exact: true }).fill("Discard this edit");
      await page.getByRole("button", { name: "Matches", exact: true }).click();
      await dialog.getByRole("button", { name: "Discard and continue", exact: true }).click();
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      assert.equal(await page.getByLabel(first.packet!.answers[0].question, { exact: true }).inputValue(), "Unsaved applicant answer");
      assert.equal(saves, 1);
      if (width <= 900) assert.equal(await picker.isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: explicit collection, direct selection, correct detail, preserved unsaved changes, cancellation, no overflow`);
      await page.close();
      first.packet!.answers[0] = { ...first.packet!.answers[0], answer: "", userProvided: false, requiresUserInput: true };
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
