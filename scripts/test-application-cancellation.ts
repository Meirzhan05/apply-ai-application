import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { selectApplication, setPacket } from "../src/lib/workflow";
import { publicState } from "../src/lib/public-state";
import { packetProfileHash } from "../src/lib/packet-profile";

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const width of [390, 1440]) {
      const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id); const fact = state.profile.facts[0];
      setPacket(state, app, { schemaVersion: 1, version: 1, model: "fixture", createdAt: new Date().toISOString(), summary: "Cancellation test", profileHash: packetProfileHash(state.profile), files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", size: 1, sha256: "a".repeat(64), factIds: [fact.id] }], resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [] });
      const page = await browser.newPage({ viewport: { width, height: 900 } }); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let cancellations = 0;
      await page.route("**/api/actions", async route => {
        const { action, payload } = route.request().postDataJSON(); assert.equal(action, "cancel"); assert.equal(payload.applicationId, app.id);
        cancellations++; app.status = "cancelled"; await route.fulfill({ json: { ok: true } });
      });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3127");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      const cancel = page.getByRole("button", { name: "Cancel this application", exact: true });
      await cancel.click(); const dialog = page.getByRole("dialog", { name: "Cancel this application?", exact: true });
      await dialog.getByText(/closes its browser session/).waitFor(); assert.equal(cancellations, 0);
      await page.keyboard.press("Escape"); assert.equal(cancellations, 0); assert.equal(await cancel.evaluate(element => element === document.activeElement), true);
      await cancel.click(); await dialog.getByRole("button", { name: "Keep application", exact: true }).click(); assert.equal(cancellations, 0);
      await cancel.click(); await dialog.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
      await page.locator(".status-pill").getByText("Cancelled", { exact: true }).waitFor(); assert.equal(cancellations, 1);
      assert.equal(await cancel.count(), 0);
      await page.locator(".packet-reference > summary").click();
      await page.getByRole("link", { name: "Open tailored resume PDF ↗", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: /Approve materials/ }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: cancellation choice, Escape/focus return, one bound action, retained materials, no overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
