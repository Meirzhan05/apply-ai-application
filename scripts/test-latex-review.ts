import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { latexFixture } from "../src/lib/fixtures/latex-resume";
import { bytesHash } from "../src/lib/resume-artifacts";
import { resumeFields, resumeFactIds, resumeInputHash } from "../src/lib/resume-document";
import { packetProfileHash } from "../src/lib/drafting";
import { publicState } from "../src/lib/public-state";
import { selectApplication, setPacket } from "../src/lib/workflow";

async function main() {
  const state = initialDemoState(); const { profile, document } = latexFixture(); state.profile = profile;
  const pdf = await readFile(".data/latex-check/fixture-resume.pdf"); const source = await readFile(".data/latex-check/fixture-resume.tex");
  const inputHash = resumeInputHash(profile, document); const pdfHash = bytesHash(pdf); const texHash = bytesHash(source);
  const app = selectApplication(state, state.jobs[0].id, profile.id);
  setPacket(state, app, { schemaVersion: 2, version: 1, model: document.model, summary: "Synthetic LaTeX review", createdAt: new Date().toISOString(), profileHash: packetProfileHash(profile), answers: [], resumeDocument: document,
    resumeLines: resumeFields(document).map(({ text, factIds }) => ({ text, factIds })), resumeArtifact: { inputHash, pageCount: 1, compiler: "tectonic-0.17.0", source: { storageKey: `${profile.id}/${inputHash}/${texHash}.tex`, sha256: texHash, size: source.length } },
    files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: pdfHash, size: pdf.length, factIds: resumeFactIds(document), storageKey: `${profile.id}/${inputHash}/${pdfHash}.pdf` }] });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } }); const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const fixture = publicState(state);
      await page.route("**/api/state", (route) => route.fulfill({ json: fixture }));
      await page.route("**/api/status", (route) => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(fixture)}\n\n` }));
      await page.route("**/api/applications/*/files/resume*", (route) => route.fulfill({ contentType: route.request().url().includes("resume-source") ? "text/plain" : "application/pdf", body: route.request().url().includes("resume-source") ? source : pdf }));
      await page.goto(process.env.TEST_DASHBOARD_URL || "http://localhost:3100");
      await page.getByRole("button", { name: "Applications", exact: true }).click();
      await page.getByRole("button", { name: "Rebuild resume", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Write essays with AI", exact: true }).isVisible(), true);
      assert.equal(await page.locator('iframe[title="Compiled one-page resume PDF"]').count(), 1);
      assert.ok((await page.getByRole("link", { name: "Download LaTeX source" }).getAttribute("href"))?.endsWith("/resume-source"));
      await page.locator(".resume-sources summary").first().click();
      assert.ok((await page.locator(".resume-sources[open]").innerText()).includes("Professional profile:"));
      await page.locator(".resume-omissions > summary").click();
      assert.ok((await page.locator(".resume-omissions").innerText()).includes("community garden"));
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= window.innerWidth), true);
      let queued: Record<string, unknown> | undefined;
      await page.route("**/api/actions", async (route) => { queued = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); });
      await page.getByRole("button", { name: "Rebuild resume", exact: true }).click();
      assert.deepEqual(queued, { action: "draft", payload: { applicationId: app.id, draftMode: "resume" } });
      await mkdir(".data/latex-check", { recursive: true });
      await page.screenshot({ path: `.data/latex-check/review-${label}.png`, fullPage: true });
      assert.deepEqual(errors, []);
      console.log(`PASS ${label}: compiled PDF, source download, source/omission review, explicit rebuild and no overflow`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
