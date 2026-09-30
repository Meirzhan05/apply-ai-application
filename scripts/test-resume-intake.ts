import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { initialDemoState } from "../src/lib/demo-data";
import type { AppState } from "../src/lib/types";

async function main() {
  const origin = process.env.TEST_APP_URL || "http://localhost:3001";
  assert.ok(new URL(origin).hostname === "localhost", "This test creates disposable applicants on the local non-demo app only");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } });
  const users: Array<{ id: string; cookie: string }> = [];
  const nonce = randomUUID();
  const pdf = await PDFDocument.create(); const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = ["EDUCATION", "Example University", "Computer Science Expected May 2027", "PUBLICATIONS",
    'Example, Student, et al. "A Study of AI Agents." Manuscript in preparation.', "WORK EXPERIENCE",
    "Orbit Labs Remote", "ML Intern February 2026 - June 2026",
    "- Built a recommender with explainable", "feature-level predictions and evaluated its behavior.",
    "- Integrated scheduled, location-based, and travel-aware", "tasks, with quiet hours and follow-up suggestions."];
  lines.forEach((line, index) => page.drawText(line, { x: 45, y: 745 - index * 18, size: 11, font }));
  const bytes = await pdf.save();
  const form = () => { const data = new FormData(); data.append("file", new File([new Uint8Array(bytes)], "synthetic-resume.pdf", { type: "application/pdf" })); return data; };
  const read = async (index: number) => {
    const response = await fetch(`${origin}/api/state`, { headers: { Cookie: users[index].cookie } });
    assert.equal(response.status, 200); return await response.json() as AppState;
  };
  try {
    for (let i = 0; i < 2; i++) {
      const email = `resume-intake-${nonce}-${i}@example.com`;
      const created = await db.auth.admin.createUser({ email, email_confirm: true }); assert.equal(created.error, null);
      const owner = created.data.user!; users.push({ id: owner.id, cookie: "" });
      const state = initialDemoState(); state.applications = []; state.activity = [];
      state.profile = { ...state.profile, id: owner.id, email, name: "Synthetic Applicant", demo: false,
        facts: [{ id: "existing", text: "Built a previously confirmed synthetic project.", verified: true, source: "user" }],
        sensitiveAnswers: { requiresSponsorship: "Synthetic preserved answer" } };
      const stored: Partial<AppState> = { ...state }; delete stored.jobs;
      assert.equal((await db.from("app_states").insert({ user_id: owner.id, data: stored, revision: 1 })).error, null);
      const link = await db.auth.admin.generateLink({ type: "magiclink", email }); assert.equal(link.error, null);
      const callback = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
      assert.equal(callback.status, 307);
      users.at(-1)!.cookie = callback.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    }
    const before = await read(0); const otherBefore = await read(1);
    const denied = await fetch(`${origin}/api/resume`, { method: "POST", headers: { Origin: origin }, body: form() });
    assert.equal(denied.status, 400);
    const wrongOrigin = await fetch(`${origin}/api/resume`, { method: "POST", headers: { Origin: "https://untrusted.example", Cookie: users[0].cookie }, body: form() });
    assert.equal(wrongOrigin.status, 403);
    const accepted = await fetch(`${origin}/api/resume`, { method: "POST", headers: { Origin: origin, Cookie: users[0].cookie }, body: form() });
    assert.equal(accepted.status, 200);
    const after = await read(0); const otherAfter = await read(1);
    assert.deepEqual(after.profile.facts[0], before.profile.facts[0]);
    const proposals = after.profile.facts.filter((fact) => fact.source === "resume");
    assert.equal(proposals.length, 4); assert.ok(proposals.every((fact) => !fact.verified));
    assert.ok(proposals.some((f) => f.text.includes("Orbit Labs") && f.text.includes("explainable feature-level predictions")));
    assert.ok(proposals.some((f) => f.text.includes("travel-aware tasks, with quiet hours")));
    assert.ok(proposals.some((f) => f.text.includes("Expected May 2027")));
    assert.ok(proposals.some((f) => f.text.includes("Manuscript in preparation")));
    assert.deepEqual(after.applications, before.applications);
    assert.deepEqual(after.profile.sensitiveAnswers, before.profile.sensitiveAnswers);
    assert.deepEqual(otherAfter.profile, otherBefore.profile);
    const bucket = await db.storage.getBucket("resumes"); assert.equal(bucket.error, null); assert.equal(bucket.data!.public, false);
    const listed = await db.storage.from("resumes").list(users[0].id); assert.equal(listed.error, null); assert.equal(listed.data!.length, 1);
    const downloaded = await db.storage.from("resumes").download(`${users[0].id}/${listed.data![0].name}`); assert.equal(downloaded.error, null);
    assert.equal(createHash("sha256").update(Buffer.from(await downloaded.data!.arrayBuffer())).digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    console.log(JSON.stringify({ passed: true, authenticatedUpload: true, proposals: proposals.length,
      automaticallyConfirmed: 0, wrappedClaimsAndStatusesPreserved: true, originalPrivateBytesPreserved: true,
      ownerIsolation: true, existingConfirmationsRetained: true, applicationsUnchanged: true, sensitiveAnswersUnchanged: true,
      realOwnerWorkspaceWrites: 0, employerSubmissions: 0 }));
  } finally {
    for (const owner of users) {
      const listed = await db.storage.from("resumes").list(owner.id); assert.equal(listed.error, null);
      const objects = (listed.data ?? []).map((file) => `${owner.id}/${file.name}`);
      if (objects.length) assert.equal((await db.storage.from("resumes").remove(objects)).error, null);
      assert.equal((await db.auth.admin.deleteUser(owner.id)).error, null);
    }
    console.log("CLEANUP disposable resume-intake accounts and files removed");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Resume intake verification failed"); process.exitCode = 1; });
