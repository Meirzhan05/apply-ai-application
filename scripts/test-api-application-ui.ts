import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { draftPacket } from "../src/lib/drafting";
import { publicState } from "../src/lib/public-state";
import { approveFill, formDigest, selectApplication, setPacket } from "../src/lib/workflow";

async function main() {
  process.env.DEMO_MODE = "true"; delete process.env.OPENAI_API_KEY;
  const state = initialDemoState();
  const job = state.jobs[0];
  const app = selectApplication(state, job.id, state.profile.id);
  const packet = await draftPacket(state.profile, job); packet.answers = [];
  setPacket(state, app, packet);
  approveFill(app, app.userId, app.packetHash!, job.applyUrl);
  state.applications = [app];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    await mkdir(".data/api-application", { recursive: true });
    for (const [device, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/state", (route) => route.fulfill({ json: publicState(state) }));
      await page.route("**/api/status", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      const actions: string[] = [];
      await page.route("**/api/actions", async (route) => {
        actions.push(route.request().postDataJSON().action);
        await route.fulfill({ json: { ok: true } });
      });
      app.status = "authorized_to_fill"; app.form = undefined;
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3041");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByRole("button", { name: "Prepare application", exact: true }).click();
      assert.deepEqual(actions, ["startBrowser"]);
      app.status = "final_review";
      const form = { version: 1 as const, url: job.applyUrl, capturedAt: new Date().toISOString(), readyToSubmit: true,
        fields: [{ identifier: "email", label: "Email", kind: "email", value: state.profile.email, required: true, valid: true },
          ...packet.files!.map((file) => ({ identifier: file.kind, label: file.kind === "resume" ? "Resume" : "Cover letter", kind: "file", value: file.filename, required: true, valid: true }))],
        attachments: packet.files!.map((file) => `${file.filename}:${file.size}:${file.sha256}`),
        apiSubmission: { version: 1 as const, provider: "greenhouse" as const, board: "example", postingId: "12345",
          endpoint: "https://boards-api.greenhouse.io/v1/boards/example/jobs/12345", definitionHash: "fixture", integrationHash: "fixture",
          packetHash: app.packetHash!, values: { email: state.profile.email }, files: { resume: "resume" as const, cover_letter: "cover-letter" as const } },
        submitControl: { label: "Submit application", identifier: "ats-api", action: job.applyUrl, method: "POST", encoding: "multipart/form-data" } };
      app.form = { ...form, hash: formDigest(form) };
      await page.reload(); await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByText("This application can be sent without opening a browser.", { exact: false }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve for submission", exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole("button", { name: /Open live browser|Start browser run/ }).count(), 0);
      await page.getByRole("button", { name: "Refresh application details", exact: true }).click();
      assert.deepEqual(actions, ["startBrowser", "resumeBrowser"]);
      await page.screenshot({ path: `.data/api-application/${device}-full.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.deepEqual(errors, []);
      await page.locator(".step-card").filter({ has: page.getByRole("heading", { name: "Final form review", exact: true }) }).screenshot({ path: `.data/api-application/${device}.png` });
      console.log(`PASS ${device}: preparation, API review and refresh controls, no browser panel or overflow; synthetic intercepted state only`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
