import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { draftPacket } from "../src/lib/drafting";
import { approveFill, selectApplication, setFormSnapshot, setPacket } from "../src/lib/workflow";
import { browserQuestions } from "../src/lib/browser-questions";
import type { FormSnapshot } from "../src/lib/types";

// First run TEST_BROWSER_CASE='label extraction' npm run test:browser. The
// fixture here is the snapshot from the actual browser inspection path.
async function main() {
  const inspected: FormSnapshot = JSON.parse(await readFile(".data/label-debug/inspected-form.json", "utf8"));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
      const packet = await draftPacket(state.profile, state.jobs[0]); packet.answers = [];
      setPacket(state, app, packet); approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
      app.browserSessionId = "label-regression-session";
      setFormSnapshot(app, { ...inspected, fields: inspected.fields.map(field => ({ ...field, label: field.kind === "radio" ? field.value : field.kind === "select" ? field.identifier! : "Current location No location found. Try entering a different locationLoading" })) });
      const page = await browser.newPage({ viewport: { width, height } }); const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let refreshed = false;
      await page.route("**/api/actions", route => {
        const { action, payload } = route.request().postDataJSON();
        assert.equal(action, "resumeBrowser"); assert.equal(payload.applicationId, app.id);
        setFormSnapshot(app, inspected); refreshed = true;
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3101");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByRole("heading", { name: "Update the form questions" }).waitFor();
      await page.getByRole("heading", { name: "Update the form questions" }).locator("..").screenshot({ path: `.data/label-debug/refresh-${name}.png` });
      assert.equal(await page.getByRole("dialog").count(), 0, "Malformed saved headings cannot be answered");
      await page.getByRole("button", { name: "Refresh questions", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Help the agent keep going" }); await dialog.waitFor();
      assert.equal(refreshed, true);
      assert.deepEqual(await dialog.locator(".question-label").allTextContents(), browserQuestions(inspected).map(question => question.label));
      assert.equal(await dialog.locator(".question-label").filter({ hasText: /^Yes$|cards\[|No location found|Loading/ }).count(), 0);
      assert.deepEqual(await dialog.getByLabel("Are you legally authorized to work in the country for which you are applying?", { exact: true }).locator("option").allTextContents(), ["Choose an option", "Yes", "No"]);
      await dialog.evaluate(element => { element.scrollTop = 0; });
      await dialog.screenshot({ path: `.data/label-debug/${name}.png` });
      await dialog.getByLabel("Do you consent to the employer retaining your application?", { exact: true }).scrollIntoViewIfNeeded();
      await dialog.screenshot({ path: `.data/label-debug/bottom-${name}.png` });
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}: malformed snapshots require refresh; actual inspected headings, employer options and readable labels render without overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
