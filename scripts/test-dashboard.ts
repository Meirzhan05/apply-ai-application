import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { matchKey } from "../src/lib/match-cache";
import { assessMatchLocally } from "../src/lib/matching";

async function main() {
  const origin = process.env.TEST_DASHBOARD_URL || "http://localhost:3000";
  const state = initialDemoState();
  const statusOnly = "F-1 international student; employment authorization and sponsorship details unconfirmed.";
  state.profile.workAuthorization = statusOnly;
  state.profile.remoteOnly = true;
  state.jobs = [{ ...state.jobs[0], remote: null }];
  const job = state.jobs[0];
  const gap = "No confirmed evidence yet for SQL.";
  const unknown = "The posting does not confirm whether this role meets your remote-only rule.";
  state.matchCache = { [matchKey(state.profile, job)]: { ...assessMatchLocally(state.profile, job), category: "uncertain", evidence: ["Your confirmed project uses a skill listed in this posting."], gaps: [gap], uncertainty: [unknown] } };
  const fixture = publicState(state);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    // Exercise the actual app component with synthetic data, without changing
    // saved profiles, contacting providers or submitting an application.
    await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
    await page.route("**/api/status", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(fixture)}\n\n` }));
    await mkdir(".data", { recursive: true });
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(origin);
      await page.locator(".fit-evidence summary").click();
      const reasons = page.locator(".match-reasons");
      await reasons.getByText(gap, { exact: true }).waitFor();
      assert.equal(await reasons.getByText(unknown, { exact: true }).isVisible(), true, "Uncertainty must remain visible alongside a gap");
      assert.equal(await page.getByText("Gaps and unknowns", { exact: true }).isVisible(), true);
      assert.ok((await page.locator(".match-badge").innerText()).includes("Uncertain"));
      await page.screenshot({ path: `.data/dashboard-uncertainty-${label}.png`, fullPage: true });
      console.log(`PASS ${label}: uncertain badge, gap and required-rule unknown all displayed`);
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      const authorization = page.locator("select").filter({ has: page.locator(`option[value="${statusOnly}"]`) });
      assert.equal(await authorization.inputValue(), statusOnly, "An explicit student status must remain visible in the selector");
      let saved: Record<string, unknown> | undefined;
      await page.route("**/api/actions", async (route) => {
        const body = route.request().postDataJSON();
        assert.equal(body.action, "profile");
        saved = body.payload;
        await route.fulfill({ json: { ok: true } });
      });
      await page.getByRole("button", { name: "Save profile and preferences", exact: true }).click();
      await page.getByRole("button", { name: "Save profile and preferences", exact: true }).waitFor({ state: "visible" });
      assert.ok(saved, "The actual form must send its profile payload");
      assert.equal(saved.workAuthorization, statusOnly);
      assert.deepEqual(saved.sensitiveAnswers, {}, "Saving F-1 status must not invent legal authorization or sponsorship answers");
      await page.screenshot({ path: `.data/profile-status-only-${label}.png`, fullPage: true });
      await page.unroute("**/api/actions");
      console.log(`PASS ${label}: F-1 status displays and round-trips without creating authorization answers`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
