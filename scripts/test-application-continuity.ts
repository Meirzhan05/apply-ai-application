import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { selectApplication, setPacket, approveFill } from "../src/lib/workflow";
import { packetProfileHash } from "../src/lib/packet-profile";
import { publicState } from "../src/lib/public-state";

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const width of [320, 390, 1440]) {
      const state = initialDemoState(); const fact = state.profile.facts[0];
      state.jobs = ["First employer", "Next employer"].map((company, index) => ({ ...state.jobs[0], id: `continuity-${index}`, company, title: `Review role ${index + 1}`, url: `https://example.com/${index}`, applyUrl: `https://example.com/${index}` }));
      state.applications = [];
      for (const job of state.jobs) {
        const app = selectApplication(state, job.id, state.profile.id);
        setPacket(state, app, { schemaVersion: 1, version: 1, createdAt: new Date().toISOString(), model: "synthetic", summary: "Review", profileHash: packetProfileHash(state.profile), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), size: 1, factIds: [fact.id] }] });
      }
      state.applications.reverse(); const first = state.applications[0];
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      let approvals = 0;
      await page.route("**/api/actions", route => {
        const input = route.request().postDataJSON(); assert.equal(input.action, "approveFill"); assert.equal(input.payload.applicationId, first.id);
        approveFill(first, state.profile.id, input.payload.packetHash, input.payload.targetUrl); approvals++;
        return route.fulfill({ json: { ok: true } });
      });
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3126");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByText("Find applications", { exact: true }).click();
      await page.getByRole("button", { name: "Needs your review (2)", exact: true }).click();
      const approve = page.getByRole("button", { name: "Approve materials for form filling", exact: true });
      await approve.focus(); await approve.press("Enter");
      const outcome = page.locator(".application-outcome");
      await outcome.getByText("First employer: Materials approved for form filling. Nothing has been submitted.", { exact: true }).waitFor();
      await page.waitForFunction(id => document.activeElement?.id === id, `application-outcome-${first.id}`);
      assert.equal(await outcome.evaluate(element => element === document.activeElement), true);
      const box = await outcome.boundingBox(); assert.ok(box && box.y >= 0 && box.y < 844);
      await page.getByRole("heading", { name: "Review role 1", exact: true }).waitFor();
      await page.getByRole("button", { name: "Start browser run", exact: true }).waitFor();
      assert.equal(approvals, 1); assert.equal(state.applications[1].status, "draft_review");
      await page.reload(); await page.getByRole("heading", { name: "Review role 1", exact: true }).waitFor();
      assert.match(await page.locator(".application-active-view").innerText(), /Current application kept in view/);
      await page.getByRole("button", { name: "Next application needing review", exact: true }).click();
      const heading = page.getByRole("heading", { name: "Review role 2", exact: true }); await heading.waitFor();
      await page.waitForFunction(id => document.activeElement?.id === id, `application-heading-${state.applications[1].id}`);
      assert.equal(await heading.evaluate(element => element === document.activeElement), true);
      assert.equal(await page.locator(".application-collection option").count(), 1);
      console.log(`PASS ${width}px: filtered permission outcome stays on the same employer, refresh preserves context, next selection is explicit and focused`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
