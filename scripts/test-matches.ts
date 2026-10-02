import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";

async function main() {
  const origin = process.env.TEST_MATCHES_URL || "http://localhost:3008";
  const fixture = publicState(initialDemoState());
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    // Drive the shipped component with invented applicant/jobs. No account,
    // provider calls, application approvals or submissions are involved.
    await page.route("**/api/state", route => route.fulfill({ json: fixture }));
    await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(fixture)}\n\n` }));
    await mkdir(".data", { recursive: true });
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(origin);
      const strongRole = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Software Engineering Intern", exact: true }) });
      await strongRole.waitFor();
      assert.equal(await strongRole.getByText("Strong fit", { exact: true }).isVisible(), true);
      const review = strongRole.locator(".job-review-note");
      assert.equal(await review.getByText("Work authorization has not been confirmed.", { exact: true }).isVisible(), true, "Strong fit must not conceal unresolved eligibility information");
      assert.equal(await review.getByRole("button", { name: "Review profile", exact: true }).isVisible(), true);
      assert.equal(await strongRole.locator(".preparation-note").isVisible(), true, "Explain preparation and later approvals before the action");
      await page.locator(".fit-guide summary").click();
      assert.equal(await page.getByText("Fit compares the posting with your confirmed profile and search preferences. It does not confirm eligibility or guarantee an offer.", { exact: true }).isVisible(), true);
      await page.screenshot({ path: `.data/matches-${label}.png`, fullPage: true });
      console.log(`PASS ${label}: fit definitions, unresolved eligibility and preparation guidance`);
    }
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
