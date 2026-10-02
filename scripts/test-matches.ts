import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { updateJobFeedback } from "../src/lib/job-feedback";

async function main() {
  const origin = process.env.TEST_MATCHES_URL || "http://localhost:3008";
  const demoState = initialDemoState();
  demoState.jobs.forEach((job, index) => { job.postedAt = new Date(Date.now() - index * 86400000).toISOString(); });
  let fixture = publicState(demoState);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    // Drive the shipped component with invented applicant/jobs. No account,
    // provider calls, application approvals or submissions are involved.
    await page.route("**/api/state", route => route.fulfill({ json: fixture }));
    await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(fixture)}\n\n` }));
    await page.route("**/api/actions", route => {
      const body = route.request().postDataJSON();
      assert.equal(body.action, "feedback", "Only synthetic feedback actions are allowed in this test");
      assert.ok(["saved", "dismissed", "clear"].includes(body.payload.kind));
      updateJobFeedback(fixture, body.payload);
      return route.fulfill({ json: { ok: true } });
    });
    await mkdir(".data", { recursive: true });
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      fixture = publicState(structuredClone(demoState));
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
      await page.locator(".fit-guide summary").click();
      assert.equal(await strongRole.locator(".match-reasons").isVisible(), false, "Full reasoning is disclosed on request");
      await strongRole.locator(".fit-evidence summary").click();
      assert.equal(await strongRole.locator(".match-reasons").getByText("No confirmed evidence yet for TypeScript.", { exact: true }).isVisible(), true, "Disclosure must preserve every missing requirement");
      await strongRole.locator(".fit-evidence summary").click();
      const query = page.getByRole("searchbox", { name: "Search roles or companies" });
      await query.fill("cedar engineering");
      assert.equal(await page.getByRole("article").count(), 1, "Search matches company and title case-insensitively");
      assert.equal(await page.getByRole("button", { name: "All matches 1", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("button", { name: "Strong 1", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("button", { name: "Possible 0", exact: true }).isVisible(), true);
      assert.equal(await page.locator(".result-summary").innerText(), '1 role in this view for “cedar engineering”');
      await query.fill("no-company-has-this-name");
      await page.getByRole("heading", { name: "No roles match your search", exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear search", exact: true }).last().click();
      assert.equal(await page.getByRole("article").count(), 3);
      await page.getByRole("combobox", { name: "Sort roles" }).selectOption("newest");
      assert.equal(await page.getByRole("article").first().getByRole("heading").innerText(), "Junior Product Analyst");
      await page.getByRole("combobox", { name: "Sort roles" }).selectOption("relevant");
      const savedBox = await page.getByRole("button", { name: "Saved 0", exact: true }).boundingBox();
      assert.ok(savedBox && savedBox.x >= 0 && savedBox.x + savedBox.width <= width, "Saved must be visible without horizontal filter scrolling");
      const launcher = page.getByRole("button", { name: "+ Import a job link", exact: true });
      await launcher.click();
      const dialog = page.getByRole("dialog", { name: "Import a job link" });
      await dialog.waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Job URL", exact: true }).evaluate(element => element === document.activeElement), true, "Opening import moves focus into its input");
      for (let step = 0; step < 9; step++) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, "Tab must stay inside the modal");
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await launcher.evaluate(element => element === document.activeElement), true, "Closing import restores launcher focus");
      const dismissLauncher = strongRole.getByRole("button", { name: "Dismiss", exact: true });
      await dismissLauncher.click();
      const dismissDialog = page.getByRole("dialog", { name: "Why dismiss this role?" });
      await dismissDialog.waitFor();
      assert.equal(await dismissDialog.getByRole("combobox", { name: "Reason" }).evaluate(element => element === document.activeElement), true);
      await page.keyboard.press("Escape");
      await dismissDialog.waitFor({ state: "hidden" });
      assert.equal(await dismissLauncher.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.getByRole("button", { name: "Matches", exact: true }).getAttribute("aria-current"), "page");
      assert.equal(await page.getByRole("button", { name: "All matches 3", exact: true }).getAttribute("aria-pressed"), "true");
      for (const control of await strongRole.locator(".small-actions button, .dark-button, .job-link").all()) {
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, "Job actions need at least 44px targets");
      }
      await page.getByRole("button", { name: "Saved 0", exact: true }).click();
      await page.getByRole("heading", { name: "Your shortlist starts here", exact: true }).waitFor();
      await page.getByRole("button", { name: "Browse matches", exact: true }).click();
      await strongRole.getByRole("button", { name: "Save", exact: true }).click();
      await strongRole.getByRole("button", { name: "Unsave", exact: true }).waitFor();
      await page.getByRole("button", { name: "Saved 1", exact: true }).click();
      assert.equal(await page.getByRole("article").count(), 1);
      await strongRole.getByRole("button", { name: "Unsave", exact: true }).click();
      await page.getByRole("heading", { name: "Your shortlist starts here", exact: true }).waitFor();
      await page.getByRole("button", { name: "Browse matches", exact: true }).click();
      await strongRole.getByRole("button", { name: "Save", exact: true }).click();
      await strongRole.getByRole("button", { name: "Unsave", exact: true }).waitFor();
      await strongRole.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.getByRole("dialog", { name: "Why dismiss this role?" }).getByRole("button", { name: "Dismiss role", exact: true }).click();
      await page.getByRole("button", { name: "Dismissed 1", exact: true }).waitFor();
      assert.equal(await page.getByRole("article").count(), 2);
      await page.getByRole("button", { name: "Undo dismissal", exact: true }).click();
      await strongRole.getByRole("button", { name: "Unsave", exact: true }).waitFor();
      assert.equal(await page.getByRole("article").count(), 3, "Undo restores both the role and its previous saved state");
      await strongRole.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.getByRole("dialog", { name: "Why dismiss this role?" }).getByRole("button", { name: "Dismiss role", exact: true }).click();
      await page.getByRole("button", { name: "Dismissed 1", exact: true }).click();
      assert.equal(await page.getByRole("article").count(), 1);
      await strongRole.getByRole("button", { name: "Restore role", exact: true }).click();
      await page.getByRole("heading", { name: "No dismissed roles", exact: true }).waitFor();
      await page.getByRole("button", { name: "Browse matches", exact: true }).click();
      assert.equal(await page.getByRole("article").count(), 3);
      await page.getByRole("button", { name: "Close feedback message", exact: true }).click();
      await page.screenshot({ path: `.data/matches-${label}.png`, fullPage: true });
      console.log(`PASS ${label}: fit/search/counts/sort/disclosure, dialog keyboard behavior, touch targets, save/unsave, dismissal undo and restore`);
    }
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
