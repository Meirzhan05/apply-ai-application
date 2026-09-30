import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { runs } from "@trigger.dev/sdk";
import { initialDemoState } from "../src/lib/demo-data";
import { mutateState } from "../src/lib/repository";
import { queueMatchAssessment } from "../src/lib/match-queue";

async function main() {
  process.env.DEMO_MODE = "false";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const created = await db.auth.admin.createUser({ email: `removed-match-${randomUUID()}@example.com`, email_confirm: true });
  assert.equal(created.error, null);
  const userId = created.data.user!.id;
  let handle: { id: string } | undefined;
  try {
    await mutateState(userId, (state) => {
      state.profile = { ...initialDemoState().profile, id: userId, name: "Synthetic Removed Account", email: created.data.user!.email!, demo: false };
    });
    const deleted = await db.auth.admin.deleteUser(userId);
    assert.equal(deleted.error, null);
    // A scheduler may already have selected this owner before deletion.
    // Deliver that stale task explicitly, without paying for a model call.
    handle = await queueMatchAssessment(userId);
    const deadline = Date.now() + 120_000;
    let result = await runs.retrieve(handle.id);
    while (!result.isCompleted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      result = await runs.retrieve(handle.id);
    }
    assert.equal(result.status, "COMPLETED");
    assert.deepEqual(result.output, { assessed: 0 });
    const remaining = await db.from("app_states").select("user_id").eq("user_id", userId);
    assert.equal(remaining.error, null);
    assert.equal(remaining.data!.length, 0, "Queued task must not recreate deleted-owner state");
    console.log(JSON.stringify({ passed: true, status: result.status, output: result.output, deletedOwnerRows: remaining.data!.length }));
  } finally {
    if (handle) {
      const result = await runs.retrieve(handle.id).catch(() => undefined);
      if (result && !result.isCompleted) await runs.cancel(handle.id).catch(() => undefined);
    }
    await db.auth.admin.deleteUser(userId);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
