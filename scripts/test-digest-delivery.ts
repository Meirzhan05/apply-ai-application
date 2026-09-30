// Sends one clearly labeled test digest to EMAIL_TEST_RECIPIENT. Run only
// with that inbox owner's authorization. Calls the application's real sender
// with production credentials, without reading/writing any user's workspace.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initialDemoState } from "../src/lib/demo-data";
import { sendDigest } from "../src/lib/email";
import type { Job } from "../src/lib/types";

async function main() {
  const recipient = process.env.EMAIL_TEST_RECIPIENT;
  assert.ok(recipient && process.env.RESEND_API_KEY && process.env.EMAIL_FROM,
    "A restricted authorized test inbox and sender are required");
  const nonce = randomUUID(); const asOf = new Date(); const now = asOf.toISOString();
  const job: Job = { id: `digest-test:${nonce}`, source: "imported", sourceId: nonce, sourceLabel: "Controlled test",
    company: `Synthetic test fixture ${nonce}`, title: "[TEST] Digest delivery check — no application",
    location: "Not a real vacancy", remote: null, employmentType: "Test only", requirements: [],
    description: "Synthetic job used to test Apply's daily digest. No application or employer interaction is involved.",
    url: "https://example.org/", applyUrl: "https://example.org/", active: true, discoveredAt: now,
    importCheck: { status: "manual", checkedAt: now, message: "This is a synthetic test; no real vacancy exists." } };
  const state = initialDemoState();
  state.profile = { ...state.profile, id: `digest-fixture:${nonce}`, name: "Synthetic digest test", email: recipient,
    demo: false, facts: [], skills: [], preferredTitles: [], preferredLocations: [],
    remoteOnly: false, strictLocations: false, workAuthorization: "Unspecified" };
  state.applications = []; state.importedJobs = [job]; state.matchCache = {}; state.matchLabels = [];
  state.activity = []; state.feedback = []; state.lastDigestAt = undefined;
  const requestIds: string[] = [];
  const nativeFetch = globalThis.fetch;
  // Inspect only this test's provider responses; both calls still reach Resend.
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.resend.com/emails"); assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)); assert.equal(body.to, recipient);
    assert.equal(body.subject, "Apply: 1 new role");
    assert.ok(body.html.includes("[TEST] Digest delivery check"));
    assert.ok(body.html.includes(nonce)); assert.ok(body.html.includes("Uncertain"));
    const response = await nativeFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
    assert.equal(response.ok, true, `Email provider status ${response.status}`);
    const result = await response.clone().json(); assert.ok(typeof result.id === "string" && result.id.length);
    requestIds.push(result.id); return response;
  };
  try {
    assert.equal(await sendDigest(state, [], asOf), true);
    assert.equal(await sendDigest(state, [], asOf), true);
    assert.equal(requestIds.length, 2);
    assert.equal(requestIds[0], requestIds[1], "Duplicate requests must return the same provider message ID");
    console.log(JSON.stringify({ passed: true, providerAccepted: true, requests: 2, distinctMessages: new Set(requestIds).size,
      providerIdempotencyVerified: true, recipientScope: "authorized test inbox only",
      fixtureLabel: "[TEST] Digest delivery check — no application", inboxConfirmed: false,
      providerDeliveryEventAvailable: false, note: "Configured Resend key is send-only; it cannot retrieve delivery events.",
      ownerWorkspaceChanged: false, employerSubmissions: 0 }));
  } finally { globalThis.fetch = nativeFetch; }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Digest delivery test failed"); process.exitCode = 1; });
