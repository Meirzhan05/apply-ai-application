import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { selectApplication, setPacket } from "../src/lib/workflow";
import { publicState } from "../src/lib/public-state";
import { packetProfileHash } from "../src/lib/drafting";

async function main() {
  const state = initialDemoState();
  const base = state.jobs[0];
  state.jobs = Array.from({ length: 6 }, (_, index) => ({ ...base, id: `navigation-${index}`, company: `Employer ${index + 1}`, title: `Application role ${index + 1}`, url: `https://example.com/${index}`, applyUrl: `https://example.com/${index}` }));
  for (const job of state.jobs) selectApplication(state, job.id, state.profile.id);
  state.applications.reverse();
  const first = state.applications[0];
  const fact = state.profile.facts[0];
  setPacket(state, first, { schemaVersion: 1, files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), size: 1, factIds: [fact.id] }], version: 1, createdAt: new Date().toISOString(), model: "fixture", summary: "Navigation verification", profileHash: packetProfileHash(state.profile), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [{ question: "Are you legally authorized to work in the United States?", answer: "", author: "human", factIds: [], requiresUserInput: true }] });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const width of [320, 390, 820, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      await page.route("**/api/actions", () => { throw new Error("Navigation must not perform application actions"); });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3126");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      const picker = page.getByRole("combobox", { name: "Choose application", exact: true });
      if (width <= 650) {
        assert.equal(await page.getByText("Application 1 of 6", { exact: true }).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Previous application", exact: true }).isDisabled(), true);
        await picker.selectOption(state.applications[5].id);
        await page.getByRole("heading", { name: "Application role 6", exact: true }).waitFor();
        assert.equal(await page.getByText("Application 6 of 6", { exact: true }).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Next application", exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Previous application", exact: true }).click();
        await page.getByRole("heading", { name: "Application role 5", exact: true }).waitFor();
        await picker.selectOption(first.id);
      } else {
        await page.locator(".app-list-item").nth(5).click();
        await page.getByRole("heading", { name: "Application role 6", exact: true }).waitFor();
        assert.equal(await page.locator('.app-list-item[aria-pressed="true"]').count(), 1);
        await page.locator(".app-list-item").first().click();
      }
      await page.getByLabel(first.packet!.answers[0].question, { exact: true }).fill("Unsaved applicant answer");
      if (width <= 650) assert.equal(await picker.isDisabled(), true);
      else assert.equal(await page.locator(".app-list-item").nth(5).isDisabled(), true);
      await page.getByRole("button", { name: "Cancel answer changes", exact: true }).click();
      assert.equal(await page.getByLabel(first.packet!.answers[0].question, { exact: true }).inputValue(), "");
      if (width <= 650) assert.equal(await picker.isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: explicit collection, direct selection, correct detail, preserved unsaved changes, cancellation, no overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
