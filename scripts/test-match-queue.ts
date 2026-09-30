import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { queues, runs } from "@trigger.dev/sdk";
import { initialDemoState } from "../src/lib/demo-data";
import { loadState, mutateState } from "../src/lib/repository";
import { assessMatchLocally } from "../src/lib/matching";
import { matchKey } from "../src/lib/match-cache";
import { queueMatchAssessment } from "../src/lib/match-queue";

async function main() {
  process.env.DEMO_MODE = "false";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const queue = await queues.retrieve({ type: "task", name: "assess-user-matches" });
  assert.equal(queue.concurrencyLimit, 1, "Deployed matching queue must serialize each owner's runs");
  const created = await db.auth.admin.createUser({ email: `match-queue-${randomUUID()}@example.com`, email_confirm: true });
  assert.equal(created.error, null);
  const userId = created.data.user!.id;
  const handles: Array<{ id: string }> = [];
  try {
    await mutateState(userId, (state) => {
      state.profile = { ...initialDemoState().profile, id: userId, name: "Synthetic Queue Test", email: created.data.user!.email!, demo: false };
      // All current postings are cached so this checks scheduling without
      // spending on model calls or treating fixture labels as evaluation data.
      state.matchCache = Object.fromEntries(state.jobs.map((job) => [matchKey(state.profile, job), assessMatchLocally(state.profile, job)]));
    });
    const pending = await Promise.allSettled([queueMatchAssessment(userId), queueMatchAssessment(userId)]);
    for (const result of pending) if (result.status === "fulfilled") handles.push(result.value);
    for (const result of pending) if (result.status === "rejected") throw result.reason;
    const deadline = Date.now() + 120_000;
    let completed: Array<Awaited<ReturnType<typeof runs.retrieve>>> = [];
    while (Date.now() < deadline) {
      completed = await Promise.all(handles.map((handle) => runs.retrieve(handle.id)));
      if (completed.every((run) => run.isCompleted)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    for (const run of completed) {
      assert.equal(run.status, "COMPLETED");
      assert.deepEqual(run.output, { assessed: 0 }, "Cached fixture must not call a model");
      assert.ok(run.startedAt && run.finishedAt);
    }
    completed.sort((a, b) => a.startedAt!.getTime() - b.startedAt!.getTime());
    assert.ok(completed[1].startedAt!.getTime() >= completed[0].finishedAt!.getTime(), "Same-owner cloud matching runs must not overlap");
    assert.equal(Object.keys((await loadState(userId)).matchCache ?? {}).length > 0, true);
    console.log(JSON.stringify({ passed: true, concurrencyLimit: queue.concurrencyLimit, runs: completed.map((run) => ({ status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, output: run.output })) }));
  } finally {
    for (const handle of handles) {
      const run = await runs.retrieve(handle.id).catch(() => undefined);
      if (run && !run.isCompleted) await runs.cancel(handle.id).catch(() => undefined);
    }
    await db.auth.admin.deleteUser(userId);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
