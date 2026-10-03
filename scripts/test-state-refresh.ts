import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import type { AppState } from "../src/lib/types";

async function main() {
  const origin = process.env.TEST_APP_URL || "http://localhost:3001";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: Array<{ id: string; cookie: string }> = [];
  try {
    for (const suffix of ["a", "b"]) {
      const email = `apply-bandwidth-${randomUUID()}-${suffix}@example.com`;
      const created = await admin.auth.admin.createUser({ email, email_confirm: true });
      assert.equal(created.error, null);
      const user = { id: created.data.user!.id, cookie: "" };
      users.push(user);
      const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
      assert.equal(link.error, null);
      const signedIn = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
      assert.equal(signedIn.status, 307);
      user.cookie = signedIn.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
      assert.ok(user.cookie);
    }
    const first = await fetch(`${origin}/api/state`, { headers: { Cookie: users[0].cookie } });
    assert.equal(first.status, 200, first.status === 200 ? undefined : await first.text());
    const initial = await first.json() as AppState;
    assert.equal(initial.profile.id, users[0].id);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.equal(first.headers.get("cache-control"), "private, no-store");
    let idleBytes = 0;
    for (let i = 0; i < 5; i++) {
      const idle: Response = await fetch(`${origin}/api/state`, { headers: { Cookie: users[0].cookie, "If-None-Match": etag } });
      assert.equal(idle.status, 304);
      idleBytes += (await idle.arrayBuffer()).byteLength;
    }
    assert.equal(idleBytes, 0);
    console.log("PASS five unchanged authenticated refreshes return 304 and transfer zero response-body bytes");

    const other = await fetch(`${origin}/api/state`, { headers: { Cookie: users[1].cookie, "If-None-Match": etag } });
    assert.equal(other.status, 200);
    assert.notEqual(other.headers.get("etag"), etag);
    assert.equal((await other.json()).profile.id, users[1].id);
    const unauthenticated = await fetch(`${origin}/api/state`, { headers: { "If-None-Match": etag }, redirect: "manual" });
    assert.equal(unauthenticated.status, 401);
    console.log("PASS validators are owner-scoped and never bypass authentication");

    const saved = await fetch(`${origin}/api/actions`, { method: "POST", headers: { Cookie: users[0].cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action: "profile", payload: { headline: "Bandwidth verification fixture" } }) });
    assert.equal(saved.status, 200, (await saved.json()).error);
    const changed = await fetch(`${origin}/api/state`, { headers: { Cookie: users[0].cookie, "If-None-Match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    assert.equal((await changed.json()).profile.headline, "Bandwidth verification fixture");
    console.log("PASS a real profile action invalidates the validator and returns updated state");

    const abort = new AbortController();
    try {
      const resumed = await fetch(`${origin}/api/status`, { headers: { Cookie: users[0].cookie, "Last-Event-ID": changed.headers.get("etag")! }, signal: abort.signal });
      assert.equal(resumed.status, 200);
      const reader = resumed.body!.getReader();
      const message = new TextDecoder().decode((await reader.read()).value);
      assert.equal(message, ": keepalive\n\n");
      await reader.cancel();
      console.log("PASS a resumed legacy live-update connection sends only a keepalive when unchanged");
    } finally { abort.abort(); }
  } finally {
    const cleanupErrors: unknown[] = [];
    await Promise.all(users.map(async (user) => {
      try {
        if (user.cookie) {
          const cookies = user.cookie.split("; ").map((cookie) => { const at = cookie.indexOf("="); return { name: cookie.slice(0, at), value: decodeURIComponent(cookie.slice(at + 1)) }; });
          const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => cookies, setAll: () => undefined } });
          assert.equal((await auth.auth.signOut()).error, null);
        }
      } catch (error) { cleanupErrors.push(error); }
      // Always attempt deletion for every test account, even when another
      // account's sign-out or cleanup encountered a transient provider error.
      try { assert.equal((await admin.auth.admin.deleteUser(user.id)).error, null); }
      catch (error) { cleanupErrors.push(error); }
    }));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Temporary verification account cleanup failed.");
    console.log("PASS temporary verification accounts and their sessions were cleaned up");
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "State refresh verification failed"); process.exitCode = 1; });
