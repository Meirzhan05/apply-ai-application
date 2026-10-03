import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { selectApplication, setPacket } from "../src/lib/workflow";
import { packetProfileHash } from "../src/lib/packet-profile";
import { publicState } from "../src/lib/public-state";
import { returnToMaterials, returnToFinalReview } from "../src/lib/material-review-recovery";

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const width of [320, 1440]) {
      for (const [status, action] of [["authorized_to_fill", "Start browser run"], ["final_review", "Approve for submission"], ["approved_to_submit", "Submit application once"]] as const) {
        const state = initialDemoState();
        const app = selectApplication(state, state.jobs[0].id, state.profile.id);
        setPacket(state, app, { schemaVersion: 1, version: 1, createdAt: new Date().toISOString(), model: "synthetic", summary: "Saved review", profileHash: packetProfileHash(state.profile), resumeLines: [{ text: state.profile.facts[0].text, factIds: [state.profile.facts[0].id] }], answers: [], files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), size: 1, factIds: [state.profile.facts[0].id] }] });
        app.status = status;
        app.form = { version: 1, url: "https://example.com/apply", capturedAt: new Date().toISOString(), hash: "fixture", readyToSubmit: true, fields: [], attachments: [] };
        state.profile.facts[0].text += " corrected";
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
        await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
        let returns = 0;
        await page.route("**/api/actions", route => {
          const input = route.request().postDataJSON();
          assert.equal(input.action, "restartBrowser"); assert.equal(input.payload.applicationId, app.id);
          returnToMaterials(app); returns++;
          return route.fulfill({ json: { ok: true } });
        });
        await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3126");
        await page.getByRole("button", { name: "Applications", exact: true }).click();
        await page.getByRole("heading", { name: "Your profile changed", exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: action, exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Return to materials review", exact: true }).click();
        await page.getByRole("button", { name: "Rebuild materials from updated facts", exact: true }).waitFor();
        assert.equal(returns, 1); assert.equal(app.status, "draft_review"); assert.equal(app.approvals.length, 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        console.log(`PASS ${width}px ${status}: stale permission blocked, saved materials retained, review restored without external work`);
        await page.close();
      }
      for (const status of ["authorized_to_fill", "approved_to_submit"] as const) {
        const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
        setPacket(state, app, { schemaVersion: 1, version: 1, createdAt: new Date().toISOString(), model: "synthetic", summary: "Saved review", profileHash: packetProfileHash(state.profile), resumeLines: [{ text: state.profile.facts[0].text, factIds: [state.profile.facts[0].id] }], answers: [], files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), size: 1, factIds: [state.profile.facts[0].id] }] });
        app.status = status;
        app.form = { version: 1, url: "https://example.com/apply", capturedAt: new Date().toISOString(), hash: "fixture", readyToSubmit: true, fields: [], attachments: [] };
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        await page.route("**/api/state", route => route.fulfill({ json: publicState(state) }));
        await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
        let requests = 0;
        await page.route("**/api/actions", route => {
          const input = route.request().postDataJSON(); requests++;
          assert.equal(input.payload.applicationId, app.id);
          if (status === "authorized_to_fill") { assert.equal(input.action, "restartBrowser"); returnToMaterials(app); }
          else { assert.equal(input.action, "reviewForm"); returnToFinalReview(app, input.payload.formHash); }
          return route.fulfill({ json: { ok: true } });
        });
        await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3126");
        await page.getByRole("button", { name: "Applications", exact: true }).click();
        await page.getByRole("button", { name: status === "authorized_to_fill" ? "Review materials again" : "Review final form again", exact: true }).click();
        const outcome = page.locator(".application-outcome"); await outcome.waitFor();
        assert.match(await outcome.innerText(), status === "authorized_to_fill" ? /permissions are cleared/ : /Submission permission withdrawn/);
        assert.equal(app.status, status === "authorized_to_fill" ? "draft_review" : "final_review");
        assert.equal(requests, 1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        console.log(`PASS ${width}px ${status}: visible permission withdrawal, saved review preserved, no external action`);
        await page.close();
      }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
