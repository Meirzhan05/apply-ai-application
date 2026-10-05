import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page, type Response as BrowserResponse } from "playwright-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { initialDemoState } from "../src/lib/demo-data";
import { createPdfSourceFixture } from "../src/lib/fixtures/pdf-source";
import { parsePdfSource } from "../src/lib/pdf-source";
import { confirmedFactIdsForAnchor, sourceEvidenceAnchors } from "../src/lib/source-plan-evidence";
import { isUsableFact } from "../src/lib/fact-evidence";
import { resumeOnboardingStatus } from "../src/lib/onboarding-completion";
import type { AppState, Profile } from "../src/lib/types";

function missingEvidence(profile: Profile) {
  const source = profile.resumeSourceDocument!;
  return sourceEvidenceAnchors(source, 3, profile.name).filter(anchor => !confirmedFactIdsForAnchor(profile, anchor, source).length);
}

async function retryStorage<T extends { error: unknown }>(operation: () => Promise<T>): Promise<T> {
  let result = await operation();
  for (let attempt = 0; result.error && attempt < 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = await operation();
  }
  return result;
}

async function main() {
  const origin = process.env.TEST_APP_URL || "http://localhost:3012";
  assert.ok(["localhost", "apply-ai-chi.vercel.app"].includes(new URL(origin).hostname), "Use localhost or the configured production app.");
  if (origin === "https://apply-ai-chi.vercel.app") assert.equal(process.env.ALLOW_PRODUCTION_RESUME_RECOVERY, "true");
  const db: SupabaseClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  let ownerId: string | undefined;
  let storageKey: string | undefined;
  let browser: Browser | undefined;
  try {
    const email = `source-recovery-${randomUUID()}@example.com`;
    const created = await db.auth.admin.createUser({ email, email_confirm: true });
    assert.equal(created.error, null);
    ownerId = created.data.user!.id;
    const bytes = await createPdfSourceFixture({ qualificationText: "Python, scikit-learn, and PostgreSQL", wrappedBullet: true });
    const source = await parsePdfSource(bytes, "Avery Chen");
    storageKey = `${ownerId}/${randomUUID()}.pdf`;
    const uploaded = await retryStorage(() => db.storage.from("resumes").upload(storageKey!, bytes, { contentType: "application/pdf", upsert: true }));
    assert.equal(uploaded.error, null);
    const state = initialDemoState();
    state.applications = []; state.activity = []; state.feedback = []; state.importedJobs = []; state.matchCache = {};
    const now = new Date().toISOString();
    state.profile = { ...state.profile, id: ownerId, email, name: "Avery Chen", contactEmail: email, phone: "+1 212 555 0100", demo: false,
      currentLocation: { city: "New York", region: "NY", country: "United States" }, preferredLocations: ["United States"], workArrangements: ["remote"],
      resumeFileName: "synthetic-legacy.pdf", resumeText: source.text, resumeSourceDocument: source, resumeDetailsVersion: 1,
      resumeSource: { storageKey, sha256: source.sourceHash, size: bytes.byteLength, mimeType: "application/pdf" },
      resumeExtraction: { id: randomUUID(), status: "ready", requestedAt: now, updatedAt: now, attempts: 1, filename: "synthetic-legacy.pdf", profileSourceHash: source.sourceHash },
      facts: [{ id: "legacy", text: "Built a Python recommender.", verified: true, source: "resume", sourceAnchorId: source.anchors.find(anchor => anchor.kind === "bullet")!.id },
        { id: "manual", text: "Completed a manually entered synthetic project.", verified: true, source: "user" }],
      sensitiveAnswers: { requiresSponsorship: "Synthetic preserved answer" },
      onboarding: { questionnaire: { immigrationStatus: "us-citizen", workAuthorization: "yes", sponsorshipNow: "no", sponsorshipFuture: "no" }, completedVersion: 2, completedAt: now, completedResumeHash: source.sourceHash },
      automationAuthorization: { version: 1, status: "paused", reason: "Disposable source recovery verification", authorizedAt: now, pausedAt: now },
    };
    assert.ok(missingEvidence(state.profile).length > 0, "The legacy fixture must reproduce the source evidence gap.");
    assert.equal(resumeOnboardingStatus(state.profile).complete, true, "The recovery fixture must have already completed onboarding.");
    const { jobs: _jobs, ...stored } = state; void _jobs;
    assert.equal((await db.from("app_states").insert({ user_id: ownerId, data: stored, revision: 1 })).error, null);
    const link = await db.auth.admin.generateLink({ type: "magiclink", email }); assert.equal(link.error, null);
    const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
    assert.equal(callback.status, 307);
    const cookie = callback.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const read = async () => {
      const response = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie }, cache: "no-store" });
      assert.equal(response.status, 200); return await response.json() as AppState & { onboarding: ReturnType<typeof resumeOnboardingStatus> };
    };
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    await mkdir(".data", { recursive: true });
    const before = (await read()).profile;
    let queued: { status: string; requestId: string } | undefined;
    for (const [label, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
      const page: Page = await browser.newPage({ viewport });
      page.setDefaultTimeout(30000);
      try {
        await page.context().addCookies(cookie.split("; ").map(value => { const [name, ...rest] = value.split("="); return { name, value: rest.join("="), url: origin }; }));
        await page.goto(origin, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Profile", exact: true }).click();
        const repair = page.getByRole("button", { name: "Re-extract saved resume", exact: true });
        await repair.waitFor();
        await page.getByText("This replaces resume-derived facts, including edits. Manually added facts and saved personal answers are kept.", { exact: true }).waitFor();
        await repair.scrollIntoViewIfNeeded();
        const layout = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
        assert.ok(layout.content <= layout.width, `${label} must not overflow horizontally.`);
        await page.screenshot({ path: `.data/source-recovery-${label}.png` });
        console.log(JSON.stringify({ viewport: label, repairVisible: true, consequencesVisible: true, overflow: false }));
        if (label === "mobile") {
          const responsePending: Promise<BrowserResponse> = page.waitForResponse(response => response.url().endsWith("/api/resume") && response.request().method() === "POST");
          await repair.click();
          const response: BrowserResponse = await responsePending;
          assert.equal(response.status(), 202, await response.text());
          queued = await response.json();
          await page.waitForTimeout(1500);
          assert.equal(new URL(page.url()).pathname, "/", "Same-resume recovery must stay in the workspace, not redirect to onboarding.");
          await page.getByRole("heading", { name: "Resume and experience", exact: true }).waitFor();
          await page.screenshot({ path: ".data/source-recovery-mobile-refresh.png" });
        }
      } finally { await page.close(); }
    }
    assert.ok(queued); assert.equal(queued.status, "queued"); assert.notEqual(queued.requestId, before.resumeExtraction!.id);
    let current = await read();
    assert.equal(current.onboarding.complete, true, "Previously completed onboarding must remain complete while re-extraction runs.");
    let profile = current.profile;
    if (profile.resumeExtraction!.status !== "ready") assert.deepEqual(profile.facts, before.facts, "The existing snapshot must remain active while extraction runs.");
    const deadline = Date.now() + 10 * 60_000;
    while (profile.resumeExtraction!.status !== "ready" && Date.now() < deadline) {
      const extraction = profile.resumeExtraction!;
      if (extraction.status === "budget_limited" || (extraction.status === "failed" && extraction.attempts !== 1)) throw new Error(extraction.error || "Extraction failed.");
      await new Promise(resolve => setTimeout(resolve, 2000)); current = await read();
      assert.equal(current.onboarding.complete, true, "Recovery progress must not revoke completed setup.");
      profile = current.profile;
    }
    assert.equal(profile.resumeExtraction!.status, "ready");
    assert.equal(profile.resumeExtraction!.id, queued.requestId);
    assert.equal(profile.onboarding!.completedAt, before.onboarding!.completedAt, "Extraction must preserve the completed setup timestamp.");
    assert.equal(resumeOnboardingStatus(profile).complete, true);
    assert.equal(missingEvidence(profile).length, 0, "All source context must become usable, not only the narrative bullets.");
    assert.ok(profile.facts.filter(fact => fact.source === "resume").every(fact => fact.grounding && isUsableFact(fact)));
    assert.deepEqual(profile.facts.find(fact => fact.id === "manual"), before.facts.find(fact => fact.id === "manual"));
    assert.deepEqual(profile.sensitiveAnswers, before.sensitiveAnswers);
    assert.deepEqual(profile.onboarding!.questionnaire, before.onboarding!.questionnaire);
    assert.deepEqual(profile.currentLocation, before.currentLocation);
    assert.equal(profile.contactEmail, before.contactEmail);
    assert.equal(profile.resumeSource!.sha256, before.resumeSource!.sha256);
    assert.equal(profile.resumeSource!.storageKey, before.resumeSource!.storageKey);
    assert.equal((await read()).applications.length, 0);
    console.log(JSON.stringify({ passed: true, readyResumeReextracted: true, onboardingRedirects: 0, completedSetupPreserved: true, missingEvidence: 0, manualFactsPreserved: true, personalAnswersPreserved: true, realOwnerWorkspaceWrites: 0, employerSubmissions: 0 }));
  } finally {
    await browser?.close();
    if (ownerId) {
      for (let attempt = 0; attempt < 15; attempt++) {
        const leases: { data: { lease_id: string }[] | null; error: unknown } = await db.from("account_operation_leases").select("lease_id").eq("owner_id", ownerId); assert.equal(leases.error, null);
        if (!leases.data?.length) break;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const errors: unknown[] = [];
      if (storageKey) { const removed = await retryStorage(() => db.storage.from("resumes").remove([storageKey!])); if (removed.error) errors.push(removed.error); }
      const stateRemoved = await db.from("app_states").delete().eq("user_id", ownerId); if (stateRemoved.error) errors.push(stateRemoved.error);
      const userRemoved = await db.auth.admin.deleteUser(ownerId); if (userRemoved.error) errors.push(userRemoved.error);
      assert.equal(errors.length, 0, "Disposable recovery resources must be cleaned up.");
      const absent = await db.from("app_states").select("user_id").eq("user_id", ownerId); assert.equal(absent.error, null); assert.equal(absent.data!.length, 0);
      const objects = await retryStorage(() => db.storage.from("resumes").list(ownerId!)); assert.equal(objects.error, null); assert.equal(objects.data!.length, 0);
      const auth = await db.auth.admin.getUserById(ownerId); assert.equal(auth.data.user, null);
      console.log("CLEANUP disposable recovery account, state and source verified absent");
    }
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Source recovery verification failed."); process.exitCode = 1; });
