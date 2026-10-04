import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { selectApplication } from "../src/lib/workflow";

async function main() {
const state = initialDemoState();
const application = selectApplication(state, state.jobs[0].id, state.profile.id);
state.applications = [application];
application.error = "Resume drafting stopped after 1 repair attempt. Use evidence from the same employer.";
application.resumeDraftDiagnostics = { version: 1, outcome: "technical_failure", technicalFailure: "malformed_response", writerAttempts: 2, checkerAttempts: 0, repairAttempts: 1, findings: [], requiredInformation: [],
  attempts: [{ stage: "structure", writerAttempt: 1, checkerAttempt: 0, outcome: "failed", issues: [{ stage: "structure", code: "different_entry", message: "Use evidence from the same employer." }] },
    { stage: "structure", writerAttempt: 2, checkerAttempt: 0, outcome: "failed", issues: [{ stage: "structure", code: "different_entry", message: "Use evidence from the same employer." }] }] };
const fixture = publicState(state);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
try {
  await mkdir(".data/resume-feedback", { recursive: true });
  for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
    await page.route("**/api/status", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(fixture)}\n\n` }));
    await page.route("**/api/actions", () => { throw new Error("This UI check must not write application state."); });
    await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3000");
    await page.getByRole("button", { name: "Applications", exact: true }).click();
    await page.getByText("Preparation history", { exact: true }).click();
    assert.equal(await page.getByText("Use evidence from the same employer.", { exact: true }).count(), 2);
    assert.equal(await page.getByText("Needs correction", { exact: false }).count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `.data/resume-feedback/${label}.png`, fullPage: true });
    console.log(`PASS ${label}: deployed preparation history, precise feedback, no horizontal overflow; synthetic intercepted state only`);
    await page.close();
  }
} finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
