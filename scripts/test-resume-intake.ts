import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { initialDemoState } from "../src/lib/demo-data";
import { createResumeProfileFixture } from "../src/lib/fixtures/resume-profile";
import { createDocxSourceFixture } from "../src/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "../src/lib/fixtures/pdf-source";
import { isUsableFact } from "../src/lib/fact-evidence";
import type { AppState } from "../src/lib/types";

async function main() {
  const origin = process.env.TEST_APP_URL || "http://localhost:3001";
  assert.ok(["localhost", "apply-ai-chi.vercel.app"].includes(new URL(origin).hostname), "Use the configured production app or a local test app; only disposable applicants are created.");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const users: Array<{ id: string; cookie: string }> = [];
  const nonce = randomUUID();
  const read = async (index: number) => {
    const response = await fetch(`${origin}/api/state`, { headers: { Cookie: users[index].cookie } });
    assert.equal(response.status, 200); return await response.json() as AppState;
  };
  const waitForFacts = async (index: number, requestId: string) => {
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      const state = await read(index);
      const job = state.profile.resumeExtraction;
      assert.equal(job?.id, requestId);
      if (job.status === "ready") return state;
      if (job.status === "budget_limited" || (job.status === "failed" && job.attempts >= 2)) throw new Error(job.error || "Extraction failed.");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error("The extraction worker did not complete within its retry window.");
  };
  const upload = async (index: number, extension: "pdf" | "docx", bytes: Buffer) => {
    const form = new FormData();
    form.append("file", new File([Uint8Array.from(bytes).buffer], `synthetic-resume.${extension}`, { type: extension === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const response = await fetch(`${origin}/api/resume`, { method: "POST", headers: { Origin: origin, Cookie: users[index].cookie }, body: form });
    assert.equal(response.status, 202, await response.clone().text());
    const queued = await response.json();
    const state = await waitForFacts(index, queued.requestId);
    const extracted = state.profile.facts.filter(f => f.source === "resume");
    assert.ok(extracted.length > 0); assert.ok(extracted.every(f => !f.verified && f.status === "accepted" && isUsableFact(f)));
    assert.ok(extracted.every(f => f.grounding?.sourceHash === state.profile.resumeSource?.sha256));
    assert.ok(state.profile.facts.some(f => f.id === "manual"));
    assert.equal(state.profile.sensitiveAnswers.requiresSponsorship, "Synthetic preserved answer");
    assert.equal(state.applications.length, 0);
    assert.equal(state.profile.resumeSource!.sha256, createHash("sha256").update(bytes).digest("hex"));
    const stored = await db.storage.from("resumes").download(state.profile.resumeSource!.storageKey!);
    assert.equal(stored.error, null); assert.deepEqual(Buffer.from(await stored.data!.arrayBuffer()), bytes);
    console.log(JSON.stringify({ format: extension, facts: extracted.length, groundedBeforeOnboardingReview: true, sourceBytesVerified: true }));
    return state;
  };
  try {
    for (let index = 0; index < 2; index++) {
      const email = `resume-intake-${nonce}-${index}@example.com`;
      const created = await db.auth.admin.createUser({ email, email_confirm: true }); assert.equal(created.error, null);
      const owner = created.data.user!; users.push({ id: owner.id, cookie: "" });
      const state = initialDemoState(); state.applications = []; state.activity = []; state.feedback = []; state.importedJobs = []; state.matchCache = {};
      state.profile = { ...state.profile, id: owner.id, email, name: index === 0 ? "Riley Example" : "Avery Chen", demo: false,
        school: "", phone: "", skills: [], graduationYear: "", headline: "",
        preferredTitles: [], preferredLocations: [], remoteOnly: false, searchPreferencesConfirmedAt: undefined,
        resumeFileName: undefined, resumeText: undefined, resumeSource: undefined, resumeSourceDocument: undefined,
        resumeExtraction: undefined, resumeUploadSequence: undefined,
        resumeImport: undefined, currentLocation: undefined, contactEmail: undefined, detailSources: undefined,
        onboarding: { questionnaire: {} }, automationAuthorization: undefined,
        facts: [{ id: "manual", text: "Built a previously entered synthetic project.", verified: true, source: "user" }],
        sensitiveAnswers: { requiresSponsorship: "Synthetic preserved answer" } };
      const stored: Partial<AppState> = { ...state }; delete stored.jobs;
      assert.equal((await db.from("app_states").insert({ user_id: owner.id, data: stored, revision: 1 })).error, null);
      const link = await db.auth.admin.generateLink({ type: "magiclink", email }); assert.equal(link.error, null);
      const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
      assert.equal(callback.status, 307);
      users.at(-1)!.cookie = callback.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
      assert.ok(users.at(-1)!.cookie);
    }
    const beforeOther = await read(1);
    const first = await upload(0, "docx", await createResumeProfileFixture());
    assert.equal(first.profile.contactEmail, "riley@example.com");
    assert.match(first.profile.email, /^resume-intake-/);
    assert.deepEqual(first.profile.currentLocation, { city: "Seattle", region: "WA", country: "United States" });
    assert.equal(first.profile.githubUrl, "https://github.com/riley-example");
    assert.equal(first.profile.linkedinUrl, "https://www.linkedin.com/in/riley-example");
    assert.equal(first.profile.portfolioUrl, "https://riley.example.com");
    assert.equal(first.profile.school, "State University");
    assert.equal(first.profile.phone, "+1 (206) 555-0123");
    assert.deepEqual(first.profile.skills.sort(), ["PostgreSQL", "Python"]);
    const edited = await fetch(`${origin}/api/actions`, { method: "POST", headers: { Origin: origin, Cookie: users[0].cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "profile", payload: { githubUrl: "https://github.com/manual-example", expectedDetails: { githubUrl: first.profile.githubUrl } } }) });
    assert.equal(edited.status, 200, await edited.text());
    assert.ok(first.profile.facts.some(f => f.text.includes("92%")));
    assert.deepEqual((await read(1)).profile, beforeOther.profile);
    const firstHash = first.profile.resumeSource!.sha256;
    const replacement = await upload(0, "docx", await createDocxSourceFixture({ secondExperience: true }));
    assert.equal(replacement.profile.githubUrl, "");
    assert.equal(replacement.profile.linkedinUrl, "");
    assert.equal(replacement.profile.portfolioUrl, "");
    assert.notEqual(replacement.profile.resumeSource!.sha256, firstHash);
    assert.ok(replacement.profile.facts.filter(f => f.source === "resume").every(f => f.grounding?.sourceHash !== firstHash));
    assert.deepEqual(replacement.profile.currentLocation, first.profile.currentLocation);
    assert.deepEqual(replacement.profile.links, []);
    const correctedLink = await fetch(`${origin}/api/actions`, { method: "POST", headers: { Origin: origin, Cookie: users[0].cookie, "Content-Type": "application/json" }, body: JSON.stringify({ action: "profile", payload: { githubUrl: "https://github.com/manual-example", expectedDetails: { githubUrl: "" } } }) });
    assert.equal(correctedLink.status, 200, await correctedLink.text());
    const reuse = new FormData(); reuse.set("reuse", "true");
    const reused = await fetch(`${origin}/api/resume`, { method: "POST", headers: { Origin: origin, Cookie: users[0].cookie }, body: reuse });
    assert.equal(reused.status, 202, await reused.clone().text());
    assert.equal((await reused.json()).status, "ready");
    assert.deepEqual((await read(0)).profile.facts, replacement.profile.facts);
    assert.equal((await read(0)).profile.githubUrl, "https://github.com/manual-example");
    assert.ok((await read(0)).profile.links?.includes("https://github.com/manual-example"));
    const beforeFirst = await read(0);
    const pdf = await upload(1, "pdf", await createPdfSourceFixture({ qualificationText: "Python, scikit-learn, and PostgreSQL", wrappedBullet: true }));
    assert.equal(pdf.profile.contactEmail, "avery@example.com");
    assert.equal(pdf.profile.linkedinUrl, "https://linkedin.com/in/averychen");
    assert.ok(pdf.profile.facts.some(f => f.text.includes("1,200")));
    assert.deepEqual((await read(0)).profile, beforeFirst.profile);
    const bucket = await db.storage.getBucket("resumes"); assert.equal(bucket.error, null); assert.equal(bucket.data!.public, false);
    console.log(JSON.stringify({ passed: true, ownerIsolation: true, snapshotReplacement: true, manualFactsPreserved: true, privateSourceStorage: true, userConfirmationActions: 0, realOwnerWorkspaceWrites: 0, employerSubmissions: 0 }));
  } finally {
    const cleanupErrors: string[] = [];
    for (const owner of users) {
      try {
      // Wait for successful workers to release their account leases before deleting fixtures.
      for (let attempt = 0; attempt < 15; attempt++) {
        const leases = await db.from("account_operation_leases").select("lease_id").eq("owner_id", owner.id);
        assert.equal(leases.error, null);
        if (!leases.data?.length) break;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const listed = await db.storage.from("resumes").list(owner.id); assert.equal(listed.error, null);
      const objects = (listed.data ?? []).map(file => `${owner.id}/${file.name}`);
      if (objects.length) assert.equal((await db.storage.from("resumes").remove(objects)).error, null);
      } catch (error) {
        cleanupErrors.push(`${owner.id} storage: ${error instanceof Error ? error.message : "cleanup failed"}`);
      }
      try {
        assert.equal((await db.auth.admin.deleteUser(owner.id)).error, null);
      } catch (error) {
        cleanupErrors.push(`${owner.id} account: ${error instanceof Error ? error.message : "cleanup failed"}`);
      }
    }
    if (cleanupErrors.length) throw new Error(`Disposable resume-intake cleanup failed: ${cleanupErrors.join("; ")}`);
    console.log("CLEANUP disposable resume-intake accounts and files removed");
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message.replace(/sk-\S+/g, "[redacted]") : "Resume intake verification failed"); process.exitCode = 1; });
