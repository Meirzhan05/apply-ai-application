import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { loadState, mutateState } from "../src/lib/repository";
import { personalSearchKey } from "../src/lib/personal-search-input";
import { matchKey } from "../src/lib/match-cache";
import { readModelUsage } from "../src/lib/model-usage";

async function main() {
  process.env.DEMO_MODE = "false";
  const origin = process.env.TEST_APP_URL || "https://apply-ai-chi.vercel.app";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const owners: Array<{ id: string; email: string }> = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (const suffix of ["a", "b"]) {
      const email = `jev-search-${randomUUID()}-${suffix}@example.com`;
      const created = await db.auth.admin.createUser({ email, email_confirm: true });
      assert.equal(created.error, null); owners.push({ id: created.data.user!.id, email });
    }
    const owner = owners[0];
    console.log("PASS temporary isolated test accounts created");
    const link = await db.auth.admin.generateLink({ type: "magiclink", email: owner.email }); assert.equal(link.error, null);
    const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
    assert.equal(callback.status, 307); assert.equal(new URL(callback.headers.get("location")!).pathname, "/");
    const cookies = callback.headers.getSetCookie().map(value => value.split(";")[0]).filter(Boolean);
    assert.ok(cookies.length, "Callback must set authenticated cookies.");
    const demo = initialDemoState();
    const job = { ...demo.jobs[0], id: `jev-fixture:${randomUUID()}`, source: "imported" as const, sourceLabel: "Synthetic JEV verification", url: "https://employer.example/jev-fixture", applyUrl: "https://employer.example/jev-fixture", title: "Entry-level Data Analyst",
      description: "An entry-level analyst role for a graduating student. Use Python and SQL to analyze datasets. No previous professional employment is required.", requirements: ["Python", "SQL"], importCheck: { status: "verified" as const, checkedAt: new Date().toISOString() } };
    await mutateState(owner.id, state => {
      state.profile = { ...demo.profile, id: owner.id, name: "Synthetic Search Applicant", email: owner.email, demo: false,
        workAuthorization: "Authorized to work in the US", preferredTitles: ["Data Analyst", "Software Engineering Intern"], preferredLocations: [], remoteOnly: false,
        facts: [...demo.profile.facts, { id: "degree", text: "Completing a bachelor's degree in computer science in 2026.", verified: true, source: "user" }],
        automationAuthorization: undefined, onboarding: undefined };
      state.importedJobs = [job]; state.matchCache = {}; state.applications = [];
      const key = personalSearchKey(state.profile);
      state.personalSearch = { status: "complete", requestId: randomUUID(), requestedAt: new Date().toISOString(), profileKey: key, resultsKey: key, jobs: [] };
    });
    // Dispatch through the deployed API, which uses its production queue credentials.
    const dispatch = await fetch(`${origin}/api/actions`, { method: "POST", headers: { Cookie: cookies.join("; "), Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action: "profile", payload: {} }) });
    assert.equal(dispatch.status, 200, "Production profile refresh must dispatch matching.");
    console.log("PASS production API dispatched the fixture fit assessment");
    const matchDeadline = Date.now() + 120_000;
    let matched = await loadState(owner.id);
    while (Date.now() < matchDeadline && !matched.matchCache[matchKey(matched.profile, job)]) {
      await new Promise(resolve => setTimeout(resolve, 1500)); matched = await loadState(owner.id);
    }
    const assessment = matched.matchCache[matchKey(matched.profile, job)];
    assert.ok(assessment?.model.startsWith("jev"), "Cloud matching must use JEV.");
    assert.equal(assessment.category, "strong"); assert.equal(matched.applications.length, 0, "Test owner has no automation permission.");
    console.log(JSON.stringify({ phase: "cloud-matching", model: assessment.model, category: assessment.category, evidenceCount: assessment.evidence.length }));
    await mutateState(owner.id, state => { state.importedJobs = []; state.matchCache = {}; });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies(cookies.map(value => ({ name: value.slice(0, value.indexOf("=")), value: value.slice(value.indexOf("=")+1), url: origin })));
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin);
    const search = page.getByRole("button", { name: "Search jobs (test)", exact: true }); await search.waitFor(); assert.equal(await search.isEnabled(), true);
    const actionResponse = page.waitForResponse(response => response.url().endsWith("/api/actions") && response.request().method() === "POST");
    await search.click(); const response = await actionResponse;
    assert.equal(response.status(), 200, `Manual search failed with HTTP ${response.status()}`);
    console.log("PASS production manual search button dispatched a real owner-scoped search");
    const searchDeadline = Date.now() + 240_000;
    let current = await loadState(owner.id);
    while (Date.now() < searchDeadline && !["complete", "failed", "budget_limited"].includes(current.personalSearch?.status || "")) {
      await new Promise(resolve => setTimeout(resolve, 2000)); current = await loadState(owner.id);
    }
    assert.equal(current.personalSearch?.status, "complete", "Live search must complete provider verification.");
    const other = await loadState(owners[1].id); assert.equal(other.jobs.length, 0); assert.equal(other.personalSearch, undefined);
    // Wait for the downstream JEV matcher without forcing another paid search.
    const assessmentDeadline = Date.now() + 120_000;
    while (Date.now() < assessmentDeadline && current.jobs.some(item => item.active && !current.matchCache[matchKey(current.profile, item)])) {
      await new Promise(resolve => setTimeout(resolve, 1500)); current = await loadState(owner.id);
    }
    const assessments = current.jobs.filter(item => item.active).map(item => current.matchCache[matchKey(current.profile, item)]);
    assert.ok(assessments.every(item => item?.model.startsWith("jev")), "Every discovered opening must receive a JEV assessment.");
    assert.equal(current.applications.length, 0);
    await page.reload(); await search.waitFor(); assert.equal(await search.isEnabled(), true);
    await mkdir(".data/jev-search-cloud", { recursive: true });
    await page.screenshot({ path: ".data/jev-search-cloud/production-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: ".data/jev-search-cloud/production-mobile.png", fullPage: true });
    assert.deepEqual(errors, []);
    const completedSearch = current.personalSearch; assert.ok(completedSearch);
    const usage = await readModelUsage(owner.id);
    console.log(JSON.stringify({ phase: "production-search", origin, searchStatus: completedSearch.status, verifiedPostings: completedSearch.jobs.length,
      jevAssessments: assessments.length, categories: assessments.map(item => item.category), isolated: true, applicationsStarted: current.applications.length,
      modelProviders: [...new Set(usage.records.map(item => item.provider))], estimatedUsd: usage.estimatedUsd, desktopAndMobile: "passed" }));
  } finally {
    await browser?.close();
    for (const owner of owners) {
      const deleted = await db.auth.admin.deleteUser(owner.id); assert.equal(deleted.error, null, "Disposable test owner cleanup must succeed.");
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
