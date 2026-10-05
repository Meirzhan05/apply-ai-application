import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { initialDemoState } from "../src/lib/demo-data";
import type { AppState } from "../src/lib/types";

const productionOrigin = "https://apply-ai-chi.vercel.app";
const origin = process.env.TEST_ONBOARDING_ORIGIN || "http://localhost:3011";
const production = origin === productionOrigin;
assert.ok(new URL(origin).hostname === "localhost" || production, "Use a localhost origin or the configured production origin.");
if (production) assert.equal(process.env.ALLOW_PRODUCTION_ONBOARDING, "true", "Set ALLOW_PRODUCTION_ONBOARDING=true for the disposable production journey.");

type User = { id: string; email: string; cookie: string; storageKey?: string };
type DatabaseClient = SupabaseClient;
type DisposableResources = { users: User[]; browser?: Browser };
const viewports = { desktop: { width: 1440, height: 1000 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 }, narrow: { width: 320, height: 740 } };
type Viewport = keyof typeof viewports;

async function captureStage(page: Page, label: Viewport, stage: string) {
  const layout = await page.evaluate(() => ({ width: window.innerWidth, contentWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.contentWidth <= layout.width, `${label}/${stage} must not overflow horizontally.`);
  await page.screenshot({ path: `/tmp/onboarding26-${label}-${stage}.png`, fullPage: true });
}

async function resumeBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  ["SYNTHETIC APPLICANT", "Almaty, Almaty Region, Kazakhstan", "EXPERIENCE", "Orbit Labs", "ML Intern | February 2026 - June 2026", "- Built an explainable recommender.", "- Evaluated ranking quality across synthetic cohorts.", "EDUCATION", "State University"].forEach((line, index) => page.drawText(line, { x: 45, y: 745 - index * 24, size: 12, font }));
  return pdf.save();
}

async function createUser(db: DatabaseClient, resources: DisposableResources, nonce: string, index: number, bytes: Uint8Array, seedResume: boolean): Promise<User> {
  const email = `onboarding-${nonce}-${index}@example.com`;
  const created = await db.auth.admin.createUser({ email, email_confirm: true });
  assert.equal(created.error, null);
  const owner = created.data.user!;
  const user: User = { id: owner.id, email, cookie: "" };
  // Register immediately so a storage, state, or magic-link failure still gets
  // an attempted account cleanup in the outer finally block.
  resources.users.push(user);
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
    user.storageKey = storageKey;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    stored.profile = { ...state.profile, resumeFileName: "seed.pdf", resumeText: "Synthetic saved resume", resumeSource: { storageKey, sha256, size: bytes.byteLength, mimeType: "application/pdf" } };
  }
  const inserted = await db.from("app_states").insert({ user_id: owner.id, data: stored, revision: 1 });
  assert.equal(inserted.error, null);
  const link = await db.auth.admin.generateLink({ type: "magiclink", email });
  assert.equal(link.error, null);
  const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
  assert.equal(callback.status, 307);
  user.cookie = callback.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  return user;
}

async function runJourney(browser: Browser, user: User, bytes: Uint8Array, label: Viewport) {
  const page = await browser.newPage({ viewport: viewports[label], reducedMotion: "reduce" });
  try {
    await page.context().addCookies(user.cookie.split("; ").map((value) => { const [name, ...rest] = value.split("="); return { name, value: rest.join("="), url: origin }; }));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/onboarding/);
    assert.match(page.url(), /onboarding/, "Incomplete users must be routed to onboarding before the dashboard.");
    for (const protectedPath of ["/usage", "/costs", "/pilot"]) {
      await page.goto(`${origin}${protectedPath}`, { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/onboarding\?returnTo=/);
      assert.match(page.url(), /onboarding\?returnTo=/, `${protectedPath} must return incomplete users to onboarding.`);
    }
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/onboarding/);
    const blockedSelection = await page.evaluate(async () => {
      const response = await fetch("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "select", payload: { jobId: "synthetic-known-job" } }) });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(blockedSelection.status, 400, "Selecting a known job must remain gated before onboarding completion.");
    assert.match(String(blockedSelection.body.error), /required onboarding/i);
    await captureStage(page, label, "resume");
    if (user.storageKey) {
      const deadline = Date.now() + 600000;
      let seededState: { resumeImport?: unknown; status?: string; attempts?: number; error?: string } = {};
      while (Date.now() < deadline) {
        seededState = await page.evaluate(async () => {
          const state = await (await fetch("/api/state", { cache: "no-store" })).json();
          return {
            resumeImport: state.profile.resumeImport,
            status: state.profile.resumeExtraction?.status,
            attempts: state.profile.resumeExtraction?.attempts,
            error: state.profile.resumeExtraction?.error,
          };
        });
        if (!seededState.resumeImport && seededState.status === "ready") break;
        await page.waitForTimeout(1000);
      }
      assert.equal(seededState.status, "ready", `Seeded resume extraction did not become ready: ${JSON.stringify(seededState)}`);
      assert.equal(seededState.resumeImport, undefined, `Seeded resume import remained pending: ${JSON.stringify(seededState)}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      const resumeStep = page.getByRole("button", { name: "Resume", exact: true });
      await resumeStep.waitFor();
      if (await resumeStep.getAttribute("aria-current") !== "step") await resumeStep.click();
      try {
        await page.getByRole("button", { name: "Use saved resume" }).click({ timeout: 30000 });
      } catch (error) {
        const diagnostic = await page.evaluate(async () => {
          const state = await (await fetch("/api/state", { cache: "no-store" })).json();
          return {
            resumeImport: state.profile.resumeImport,
            resumeExtraction: state.profile.resumeExtraction && {
              id: state.profile.resumeExtraction.id,
              status: state.profile.resumeExtraction.status,
              attempts: state.profile.resumeExtraction.attempts,
              error: state.profile.resumeExtraction.error,
            },
            onboardingMissing: state.onboarding.missing,
          };
        });
        console.error(`Saved-resume control did not become usable (${label}): ${JSON.stringify(diagnostic)}\n${await page.locator("body").innerText()}`);
        throw error;
      }
    } else {
      const queued = page.waitForResponse(response => response.url().endsWith("/api/resume") && response.request().method() === "POST");
      const chooser = page.waitForEvent("filechooser");
      await page.getByLabel("Upload resume", { exact: false }).click();
      await (await chooser).setFiles({ name: "synthetic-resume.pdf", mimeType: "application/pdf", buffer: Buffer.from(bytes) });
      assert.equal((await queued).status(), 202, "Resume upload must return the background extraction contract.");
      const pending = await page.evaluate(async () => (await (await fetch("/api/state", { cache: "no-store" })).json()).profile.resumeExtraction?.status);
      if (["queued", "extracting", "checking"].includes(pending)) {
        assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true, "Continue must remain gated during extraction.");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "Your resume", exact: true }).waitFor();
      }
    }
    try {
      await page.waitForFunction(() => { const input = document.querySelector('input[autocomplete="name"]') as HTMLInputElement | null; return Boolean(input && !input.disabled); }, undefined, { timeout: 600000 });
    } catch (error) {
      console.error(`Resume reuse did not reach editable profile (${label}): ${await page.locator("body").innerText()}`);
      throw error;
    }
    await page.getByLabel("Full name", { exact: true }).fill("Synthetic Applicant");
    await page.getByLabel("Email", { exact: true }).fill(user.email);
    await page.getByLabel("Phone", { exact: true }).fill("+1 212 555 0100");
    await page.waitForTimeout(800);
    await captureStage(page, label, "profile");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("heading", { name: "Current Location" }).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => document.activeElement?.id === "answers-heading", undefined, { timeout: 15000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("heading", { name: "Current Location" }).waitFor({ timeout: 15000 });
    } catch (error) {
      console.error(`Saved-progress recovery did not resume the answers stage (${label}): ${await page.locator("body").innerText()}`);
      throw error;
    }
    assert.equal(await page.getByLabel("Current city", { exact: true }).inputValue(), "Almaty", "Resume residence must be prefilled after upload/reuse and reload.");
    assert.equal(await page.getByLabel("State or region", { exact: true }).inputValue(), "Almaty Region");
    assert.equal(await page.getByLabel("Country", { exact: true }).inputValue(), "Kazakhstan");
    await page.getByLabel("Current city", { exact: true }).fill("New York");
    await page.getByLabel("State or region", { exact: true }).fill("NY");
    await page.getByLabel("Country", { exact: true }).fill("United States");
    await page.getByLabel("Anywhere in the United States", { exact: true }).check();
    await page.getByLabel("Remote", { exact: true }).check();
    await page.locator("#setup-immigrationStatus").selectOption("us-citizen");
    await page.locator("#setup-workAuthorization").selectOption("yes");
    await page.locator("#setup-sponsorshipNow").selectOption("no");
    await page.locator("#setup-sponsorshipFuture").selectOption("no");
    await captureStage(page, label, "answers");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const finish = page.getByRole("button", { name: "Finish onboarding", exact: true });
    await finish.waitFor({ state: "visible" });
    await page.waitForTimeout(1200);
    if (await finish.isDisabled()) {
      console.error(`Finish remained disabled (${label}): ${await page.locator("body").innerText()}`);
      throw new Error("Finish onboarding remained disabled in the browser journey.");
    }
    await page.getByRole("button", { name: "Edit professional information", exact: true }).click();
    await page.getByRole("heading", { name: "Contact details", exact: true }).waitFor();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await finish.waitFor({ state: "visible" });
    await captureStage(page, label, "review");
    await finish.click();
    await page.waitForURL((url) => url.pathname === "/");
    const state = await page.evaluate(async () => (await fetch("/api/state", { cache: "no-store" })).json());
    assert.equal(state.onboarding.complete, true, "Finish must persist v2 completion before dashboard arrival.");
    assert.deepEqual(state.profile.currentLocation, { city: "New York", region: "NY", country: "United States" }, "User corrections to imported residence must persist.");
    assert.equal(state.automation.enabled, false, "Onboarding must not authorize automation.");
    assert.equal(state.automation.paused, true, "The disposable journey must keep automation paused.");
    assert.equal(state.applications.length, 0, "Onboarding must not create employer applications.");
    assert.equal(state.profile.email, user.email, "The account email must stay independent of resume contact edits.");
    assert.equal(state.profile.contactEmail, user.email, "The saved application email must match the review.");
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
  const db: DatabaseClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const bytes = await resumeBytes();
  const nonce = randomUUID();
  const resources: DisposableResources = { users: [] };
  try {
    const labels: Viewport[] = process.env.TEST_ONBOARDING_RESPONSIVE === "true" ? ["desktop", "tablet", "mobile", "narrow"] : ["desktop", "mobile"];
    const users: User[] = [];
    for (const [index] of labels.entries()) users.push(await createUser(db, resources, nonce, index, bytes, index > 0));
    resources.browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    for (const [index, label] of labels.entries()) await runJourney(resources.browser, users[index], bytes, label);
    console.log(JSON.stringify({ passed: true, mandatoryEntry: true, savedProgress: true, resumeUpload: true, resumeReuse: true, completion: true, dashboardReload: true, employerSubmissions: 0 }));
  } finally {
    const cleanupErrors: string[] = [];
    if (resources.browser) {
      try { await resources.browser.close(); } catch { cleanupErrors.push("browser"); }
    }
    for (const user of resources.users) {
      try {
        const listed = await db.storage.from("resumes").list(user.id);
        if (listed.error) throw listed.error;
        const objects = (listed.data ?? []).map((file) => `${user.id}/${file.name}`);
        if (user.storageKey && !objects.includes(user.storageKey)) objects.push(user.storageKey);
        if (objects.length) {
          const removed = await db.storage.from("resumes").remove(objects);
          if (removed.error) throw removed.error;
        }
      } catch { cleanupErrors.push(`storage:${user.id}`); }
      try {
        const removedState = await db.from("app_states").delete().eq("user_id", user.id);
        if (removedState.error) throw removedState.error;
      } catch { cleanupErrors.push(`state:${user.id}`); }
      try {
        const deleted = await db.auth.admin.deleteUser(user.id);
        if (deleted.error) throw deleted.error;
      } catch { cleanupErrors.push(`auth:${user.id}`); }
    }
    if (cleanupErrors.length) {
      console.error(`CLEANUP completed with ${cleanupErrors.length} disposable resource errors`);
      process.exitCode = 1;
    } else console.log("CLEANUP disposable onboarding accounts and resume objects removed");
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Onboarding verification failed"); process.exitCode = 1; });
