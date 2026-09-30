import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchBoard } from "../src/lib/sources";
import type { AppState } from "../src/lib/types";

async function main() {
  const appUrl = process.env.TEST_APP_URL || "http://localhost:3001";
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const users: Array<{ id: string; cookie: string }> = [];
  const nonce = randomUUID();
  const read = async (i: number) => {
    const response = await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[i].cookie } });
    assert.equal(response.status, 200); return await response.json() as AppState;
  };
  const action = async (i: number, name: string, payload: unknown, status = 200) => {
    const response = await fetch(`${appUrl}/api/actions`, { method: "POST", headers: { Cookie: users[i].cookie,
      Origin: appUrl, "Content-Type": "application/json" }, body: JSON.stringify({ action: name, payload }) });
    const body = await response.json(); assert.equal(response.status, status, body.error || name); return body;
  };
  try {
    for (const suffix of ["a", "b"]) {
      const email = `apply-import-${nonce}-${suffix}@example.com`;
      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
      assert.equal(error, null); users.push({ id: data.user!.id, cookie: "" });
      const link = await admin.auth.admin.generateLink({ type: "magiclink", email }); assert.equal(link.error, null);
      const response = await fetch(`${appUrl}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
      assert.equal(response.status, 307);
      users.at(-1)!.cookie = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    }
    const sourceJobs = await fetchBoard({ source: "greenhouse", slug: "cloudflare" });
    const existing = new Set((await read(0)).jobs.map((job) => job.url));
    const candidate = sourceJobs.find((job) => !existing.has(job.url));
    assert.ok(candidate, "A public role outside the configured catalog is required");
    const importedUrl = `https://job-boards.greenhouse.io/cloudflare/jobs/${candidate.sourceId}`;
    await action(0, "import", { url: importedUrl, title: "Forged title", description: "Forged description", location: "Forged location" });
    const state = await read(0); const job = state.importedJobs!.find((item) => item.sourceId === candidate.sourceId)!;
    assert.ok(job.id.startsWith("imported:")); assert.equal(job.title, candidate.title); assert.equal(job.description, candidate.description);
    assert.equal(job.location, candidate.location); assert.equal(job.importCheck?.status, "verified");
    assert.equal(job.importUrl, importedUrl);
    console.log("PASS authenticated import retrieves public ATS details instead of client-supplied claims");
    const stored = await admin.from("app_states").select("data").eq("user_id", users[0].id).single(); assert.equal(stored.error, null);
    assert.ok(stored.data!.data.importedJobs.some((item: { id: string }) => item.id === job.id));
    const shared = await admin.from("jobs").select("id").eq("id", job.id); assert.equal(shared.error, null); assert.equal(shared.data!.length, 0);
    assert.equal((await read(1)).jobs.some((item) => item.id === job.id), false);
    console.log("PASS import persists only in its owner's state and never in the shared catalog");
    await action(0, "import", { url: `${importedUrl}?utm_source=test#app` }, 400);
    assert.equal((await read(0)).importedJobs!.length, 1);
    await action(0, "select", { jobId: job.id });
    const selected = (await read(0)).applications.find((app) => app.jobId === job.id)!;
    assert.equal(selected.jobSnapshot!.title, candidate.title);
    console.log("PASS tracking alias deduplication and selection retain the private posting identity");
    await action(0, "import", { url: `https://careers.example.com/jobs/${nonce}`, title: "Manual role" });
    const manual = (await read(0)).importedJobs!.find((item) => item.title === "Manual role")!;
    assert.equal(manual.importCheck?.status, "manual");
    const visible = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    assert.equal(visible.matches.find((item: { jobId: string }) => item.jobId === manual.id).assessment.category, "uncertain");
    assert.equal((await read(1)).importedJobs?.length || 0, 0);
    console.log("PASS unsupported links remain uncertain and owner-isolated for manual verification");
  } finally {
    for (const user of users) assert.equal((await admin.auth.admin.deleteUser(user.id)).error, null);
    console.log("CLEANUP synthetic import accounts removed");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Import integration failed"); process.exitCode = 1; });
