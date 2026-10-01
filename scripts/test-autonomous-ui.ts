import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { selectApplication } from "../src/lib/workflow";
import { saveOnboarding, activateAutomation } from "../src/lib/onboarding";
import { authorizeKnownAnswerApplication } from "../src/lib/autonomous-policy";
import type { ApplicationStatus } from "../src/lib/types";

async function main() {
  const state = initialDemoState(); state.applications = [];
  saveOnboarding(state.profile, { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" } }); activateAutomation(state.profile, "UI fixture");
  const app = selectApplication(state, state.jobs[0].id, state.profile.id); authorizeKnownAnswerApplication(app, state.profile, state.jobs[0]);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined }); await mkdir(".data", { recursive: true });
  try {
    for (const [device, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } }); const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/state", (route) => route.fulfill({ json: publicState(state) })); await page.route("**/api/status", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      for (const [status, outcome] of [["selected", "Queued"], ["drafting", "Processing"], ["needs_user_action", "Blocked"], ["submitted", "Submitted"], ["uncertain", "Uncertain"], ["cancelled", "Cancelled"]] as Array<[ApplicationStatus, string]>) {
        app.status = status; app.queuedRun = status === "selected" ? { id: "saved", kind: "draft", reason: "waiting", requestedAt: new Date().toISOString() } : undefined;
        app.error = status === "needs_user_action" ? "This form requires a cover letter. Automatic letters are not available yet." : undefined;
        app.confirmation = status === "submitted" ? "Confirmation visible at the controlled receiver" : undefined;
        app.submissionReceipt = status === "submitted" ? { version: 1, url: state.jobs[0].applyUrl, text: "Application received", capturedAt: new Date().toISOString() } : undefined;
        await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3000"); await page.getByRole("button", { name: "Applications", exact: true }).click();
        await page.getByLabel("Automatic application outcome").waitFor(); assert.equal(await page.locator(".status-pill").innerText(), outcome);
        assert.equal(await page.getByRole("button", { name: /Approve|Submit application|Generate cover letter/ }).count(), 0, "Automatic outcomes must not require review approvals");
        if (status === "needs_user_action") assert.equal(await page.getByText(app.error!, { exact: true }).isVisible(), true);
        if (status === "submitted") { await page.getByText("View employer response", { exact: true }).click(); assert.equal(await page.getByText("Application received", { exact: true }).isVisible(), true); }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
        if (status === "needs_user_action") await page.screenshot({ path: `.data/autonomous-blocked-${device}.png`, fullPage: true });
      }
      console.log(`PASS ${device}: queued, processing, blocked, submitted with response, uncertain, cancelled; no review controls or overflow`); await page.close();
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
