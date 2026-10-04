import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { matchKey } from "../src/lib/match-cache";

async function main() {
  const origin = process.env.TEST_UI_URL || "http://localhost:3013";
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  await mkdir(".data/jev-search-ui", { recursive: true });
  try {
    for (const [device, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const state = initialDemoState(); state.profile.demo = false; state.profile.workAuthorization = "Authorized to work in the US";
      const job = state.jobs[0]; state.jobs = []; state.applications = [];
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      let requests = 0, fail = false;
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      await page.route("**/api/actions", async route => {
        assert.equal(route.request().postDataJSON().action, "searchJobs"); requests++;
        if (fail) { await route.fulfill({ status: 400, json: { error: "Your search could not start. Try again later." } }); return; }
        state.personalSearch = { status: "queued", requestId: `request-${requests}`, requestedAt: new Date().toISOString(), profileKey: "key", jobs: [] };
        await route.fulfill({ json: { ok: true } });
      });
      await page.goto(origin);
      const search = page.getByRole("button", { name: "Search jobs (test)", exact: true }); await search.waitFor();
      assert.equal(await search.isEnabled(), true);
      await page.screenshot({ path: `.data/jev-search-ui/${device}-ready.png`, fullPage: true });
      await search.click();
      const active = page.getByRole("button", { name: "Searching…", exact: true }); await active.waitFor();
      assert.equal(await active.isDisabled(), true); assert.equal(requests, 1);
      state.personalSearch!.status = "complete"; state.personalSearch!.completedAt = new Date().toISOString(); state.jobs = [job];
      state.matchCache = { [matchKey(state.profile, job)]: { version: 1, category: "possible", score: 70, confidence: .88, model: "jev-1.13.0", evidence: [`Posting: “Python” · Confirmed: ${state.profile.facts[0].text}`], gaps: [], uncertainty: [], evaluatedAt: new Date().toISOString() } };
      await page.reload();
      await page.locator("details.search-status > summary").click();
      await search.waitFor(); assert.equal(await search.isEnabled(), true);
      await page.locator(".fit-evidence summary").click(); await page.getByText("JEV assessment · Confidence 88%", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `.data/jev-search-ui/${device}-results.png`, fullPage: true });
      fail = true; await search.click(); await page.getByRole("alert").filter({ hasText: "Your search could not start. Try again later." }).waitFor();
      assert.equal(requests, 2); assert.deepEqual(errors, []);
      console.log(`PASS ${device}: manual search, active-run guard, JEV evidence/confidence, retry error, no overflow or runtime errors (intercepted synthetic state)`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
