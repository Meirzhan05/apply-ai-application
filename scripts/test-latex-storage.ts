import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { adminSupabase } from "../src/lib/supabase-admin";
import { saveArtifact } from "../src/lib/resume-artifacts";

async function main() {
  assert.equal(process.env.DEMO_MODE, "false");
  const admin = adminSupabase(); const ids: string[] = []; const keys: string[] = [];
  try {
    const clients = [];
    for (let index = 0; index < 2; index++) {
      const email = `latex-fixture-${randomUUID()}@example.com`; const password = `Fixture-${randomUUID()}!`;
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw error ?? new Error("Unable to create fixture user");
      ids.push(data.user.id);
      const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
      const signedIn = await client.auth.signInWithPassword({ email, password }); if (signedIn.error) throw signedIn.error;
      clients.push(client);
    }
    const artifact = await saveArtifact(ids[0], "b".repeat(64), Buffer.from("Synthetic LaTeX storage verification; no real applicant data."), "tex"); keys.push(artifact.storageKey);
    assert.equal((await clients[0].storage.from("application-files").download(artifact.storageKey)).error, null);
    assert.ok((await clients[1].storage.from("application-files").download(artifact.storageKey)).error, "Other owners cannot read source files");
    assert.ok((await clients[0].storage.from("application-files").upload(`${ids[0]}/${"c".repeat(64)}/${"d".repeat(64)}.tex`, "client-authored", { contentType: "text/plain" })).error, "Owners cannot create reviewed artifacts directly");
    assert.ok((await clients[0].storage.from("application-files").update(artifact.storageKey, "changed", { contentType: "text/plain" })).error, "Owners cannot overwrite reviewed artifacts");
    const deleted = await clients[0].storage.from("application-files").remove([artifact.storageKey]);
    assert.equal(deleted.data?.length ?? 0, 0, "Owner clients cannot delete immutable reviewed artifacts");
    assert.equal((await clients[0].storage.from("application-files").download(artifact.storageKey)).error, null);
    console.log("PASS live private storage: owner read, cross-owner denial, server-only writes and immutable files");
  } finally {
    if (keys.length) { const { error } = await admin.storage.from("application-files").remove(keys); if (error) throw error; }
    for (const id of ids) { const { error } = await admin.auth.admin.deleteUser(id); if (error) throw error; }
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
