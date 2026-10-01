import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { selectApplication } from "../src/lib/workflow";
import { publicState } from "../src/lib/public-state";

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  await mkdir(".data/submission-debug", { recursive: true });
  try {
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
      app.status = "awaiting_verification"; app.browserSessionId = "synthetic-session";
      app.browserLiveUrl = "https://viewer.example/synthetic";
      app.browserSessionExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      app.submissionAttemptedAt = new Date().toISOString();
      app.form = { version: 1, url: state.jobs[0].applyUrl, hash: "reviewed", capturedAt: app.submissionAttemptedAt, fields: [], attachments: [], readyToSubmit: true };
      app.submissionVerification = { version: 1, kind: "captcha", sessionId: app.browserSessionId, targetUrl: state.jobs[0].applyUrl, attemptedAt: app.submissionAttemptedAt, beforeHash: "synthetic", beforeHadConfirmation: false };
      const actions: string[] = []; const errors: string[] = [];
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", error => errors.push(error.message));
      await page.route("https://viewer.example/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Synthetic verification browser</h1>" }));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      await page.route("**/api/actions", async route => {
        const input = route.request().postDataJSON(); actions.push(input.action);
        assert.equal(input.action, "checkSubmissionResult");
        app.status = "submitted"; app.submittedAt = new Date().toISOString(); app.confirmation = "Application received";
        app.browserLiveUrl = undefined; app.submissionVerification = undefined;
        await route.fulfill({ json: { state: publicState(state) } });
      });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3101");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByText("Finish employer verification", { exact: true }).waitFor();
      assert.equal(await page.getByText("Submission result uncertain", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("heading", { name: "Final form review", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Cancel this application", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: /Approve.*submit|Submit application/ }).count(), 0);
      await page.getByRole("button", { name: "Take control", exact: true }).click();
      assert.equal(await page.locator(".live-browser-screen").getAttribute("inert"), null);
      assert.match(await page.locator(".live-browser-toolbar").innerText(), /Do not click Submit again/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator(".verification-note").evaluate(element => element.scrollIntoView({ block: "start" }));
      assert.equal(await page.getByRole("button", { name: "I’m done · check result", exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }), true, "The result action must be fully visible and unobscured by navigation");
      await page.screenshot({ path: `.data/submission-debug/verification-${label}.png` });
      await page.getByRole("button", { name: "I’m done · check result", exact: true }).click();
      await page.getByText("Submission confirmed", { exact: true }).waitFor();
      assert.deepEqual(actions, ["checkSubmissionResult"]);
      assert.deepEqual(errors, []);
      console.log(`PASS ${label}: verification guidance, live control, no submit/restart/cancel, read-only check, confirmed outcome, no overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
