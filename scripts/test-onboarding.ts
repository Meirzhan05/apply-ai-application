import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { initialDemoState } from "../src/lib/demo-data";
import type { AppState } from "../src/lib/types";

const productionOrigin = "https://apply-ai-chi.vercel.app";
const origin = process.env.TEST_ONBOARDING_ORIGIN || "http://localhost:3011";
const production = origin === productionOrigin;
assert.ok(new URL(origin).hostname === "localhost" || production, "Use a localhost origin or the configured production origin.");
if (production) assert.equal(process.env.ALLOW_PRODUCTION_ONBOARDING, "true", "Set ALLOW_PRODUCTION_ONBOARDING=true for the disposable production journey.");

type User = { id: string; email: string; cookie: string; storageKey?: string };
type DatabaseClient = ReturnType<typeof createClient<any, "public">>;

async function resumeBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  ["SYNTHETIC APPLICANT", "Orbit Labs", "Built an explainable recommender.", "EDUCATION", "State University"].forEach((line, index) => page.drawText(line, { x: 45, y: 745 - index * 24, size: 12, font }));
  return pdf.save();
}

async function createUser(db: DatabaseClient, nonce: string, index: number, bytes: Uint8Array, seedResume: boolean): Promise<User> {
  const email = `onboarding-${nonce}-${index}@example.com`;
  const created = await db.auth.admin.createUser({ email, email_confirm: true });
  assert.equal(created.error, null);
  const owner = created.data.user!;
  const state = initialDemoState();
  const pausedAt = new Date().toISOString();
  state.profile = { ...state.profile, id: owner.id, email, name: "", phone: "", demo: false, facts: [], preferredLocations: [], currentLocation: undefined, workArrangements: undefined, onboarding: { questionnaire: {} }, automationAuthorization: { version: 1, status: "paused", reason: "onboarding browser verification fixture", authorizedAt: pausedAt, pausedAt } };
  const { jobs: _jobs, ...stateWithoutJobs } = state;
  void _jobs;
  const stored: Partial<AppState> = { ...stateWithoutJobs };
  let storageKey: string | undefined;
  if (seedResume) {
    storageKey = `${owner.id}/${randomUUID()}.pdf`;
    const uploaded = await db.storage.from("resumes").upload(storageKey, bytes, { contentType: "application/pdf", upsert: true });
    assert.equal(uploaded.error, null);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    stored.profile = { ...state.profile, resumeFileName: "seed.pdf", resumeText: "Synthetic saved resume", resumeSource: { storageKey, sha256, size: bytes.byteLength, mimeType: "application/pdf" } };
  }
  const inserted = await db.from("app_states").insert({ user_id: owner.id, data: stored, revision: 1 });
  assert.equal(inserted.error, null);
  const link = await db.auth.admin.generateLink({ type: "magiclink", email });
  assert.equal(link.error, null);
  const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
  assert.equal(callback.status, 307);
  return { id: owner.id, email, cookie: callback.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; "), ...(seedResume ? { storageKey } : {}) };
}

async function runJourney(browser: Browser, user: User, bytes: Uint8Array, label: "desktop" | "mobile") {
  const page = await browser.newPage({ viewport: label === "desktop" ? { width: 1440, height: 1000 } : { width: 390, height: 844 } });
  await page.context().addCookies(user.cookie.split("; ").map((value) => { const [name, ...rest] = value.split("="); return { name, value: rest.join("="), url: origin }; }));
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/onboarding/);
    assert.match(page.url(), /onboarding/, "Incomplete users must be routed to onboarding before the dashboard.");
    if (user.storageKey) {
      await page.getByRole("button", { name: "Use saved resume" }).click();
    } else {
      const chooser = page.waitForEvent("filechooser");
      await page.getByLabel("Upload resume", { exact: false }).click();
      await (await chooser).setFiles({ name: "synthetic-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from(bytes) });
    }
    try {
      await page.waitForFunction(() => { const input = document.querySelector('input[autocomplete="name"]') as HTMLInputElement | null; return Boolean(input && !input.disabled); }, undefined, { timeout: 30000 });
    } catch (error) {
      console.error(`Resume reuse did not reach editable profile (${label}): ${await page.locator("body").innerText()}`);
      throw error;
    }
    await page.getByLabel("Full name", { exact: true }).fill("Synthetic Applicant");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Phone", { exact: true }).fill("+1 212 555 0100");
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Current Location" }).waitFor({ timeout: 30000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("heading", { name: "Current Location" }).waitFor({ timeout: 15000 });
    } catch (error) {
      console.error(`Saved-progress recovery did not resume the answers stage (${label}): ${await page.locator("body").innerText()}`);
      throw error;
    }
    await page.getByLabel("Current city", { exact: true }).fill("New York");
    await page.getByLabel("State or region", { exact: true }).fill("NY");
    await page.getByLabel("Country", { exact: true }).fill("United States");
    await page.getByLabel("Anywhere in the United States", { exact: true }).check();
    await page.getByLabel("Remote", { exact: true }).check();
    await page.locator("#setup-immigrationStatus").selectOption("us-citizen");
    await page.locator("#setup-workAuthorization").selectOption("yes");
    await page.locator("#setup-sponsorshipNow").selectOption("no");
    await page.locator("#setup-sponsorshipFuture").selectOption("no");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const finish = page.getByRole("button", { name: "Finish onboarding", exact: true });
    await finish.waitFor({ state: "visible" });
    await page.waitForTimeout(1200);
    if (await finish.isDisabled()) {
      console.error(`Finish remained disabled (${label}): ${await page.locator("body").innerText()}`);
      throw new Error("Finish onboarding remained disabled in the browser journey.");
    }
    await finish.click();
    await page.waitForURL((url) => url.pathname === "/");
    const state = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    assert.equal(state.onboarding.complete, true, "Finish must persist v2 completion before dashboard arrival.");
    assert.equal(state.automation.enabled, false, "Onboarding must not authorize automation.");
    assert.equal(state.automation.paused, true, "The disposable journey must keep automation paused.");
    assert.equal(state.applications.length, 0, "Onboarding must not create employer applications.");
    assert.equal(state.jobs.length, 0, "The disposable journey must not expose job listings.");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/");
    await mkdir(".data", { recursive: true });
    await page.screenshot({ path: `.data/onboarding-${label}.png`, fullPage: true });
    console.log(`PASS ${label}: mandatory route, ${user.storageKey ? "saved-resume reuse" : "resume upload"}, reload recovery, finish, dashboard reload`);
  } finally {
    await page.close();
  }
}

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const bytes = await resumeBytes();
  const nonce = randomUUID();
  const users = [await createUser(db, nonce, 0, bytes, false), await createUser(db, nonce, 1, bytes, true)];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    await runJourney(browser, users[0], bytes, "desktop");
    await runJourney(browser, users[1], bytes, "mobile");
    console.log(JSON.stringify({ passed: true, mandatoryEntry: true, savedProgress: true, resumeUpload: true, resumeReuse: true, completion: true, dashboardReload: true, employerSubmissions: 0 }));
  } finally {
    await browser.close();
    for (const user of users) {
      if (user.storageKey) await db.storage.from("resumes").remove([user.storageKey]);
      await db.auth.admin.deleteUser(user.id);
    }
    console.log("CLEANUP disposable onboarding accounts and resume objects removed");
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Onboarding verification failed"); process.exitCode = 1; });
