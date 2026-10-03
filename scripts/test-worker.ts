import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_AI_MODEL } from "../src/lib/ai-model";
import { initialDemoState } from "../src/lib/demo-data";
import { loadState, mutateState } from "../src/lib/repository";
import { selectApplication } from "../src/lib/workflow";
import { queueApplicationRun } from "../src/lib/application-queue";

async function main() {
  process.env.DEMO_MODE = "false";
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const testId = randomUUID();
  const { data, error } = await client.auth.admin.createUser({ email: `worker-${testId}@example.com`, email_confirm: true });
  assert.equal(error, null);
  const userId = data.user!.id;
  const fixture = { ...initialDemoState().jobs[0], id: `worker:${testId}`, source: "imported" as const, sourceId: testId, company: "Synthetic worker fixture", applyUrl: "https://example.org/apply", url: "https://example.org/apply" };
  try {
    assert.equal((await client.from("jobs").insert({ id: fixture.id, source: fixture.source, source_id: fixture.sourceId, active: true, data: fixture })).error, null);
    const applicationId = await mutateState(userId, (state) => {
      state.profile = { ...initialDemoState().profile, id: userId, name: "Synthetic Worker Test", email: data.user!.email!, demo: false };
      state.jobs = [fixture];
      state.applications = [];
      return selectApplication(state, fixture.id, userId).id;
    });
    await queueApplicationRun(userId, applicationId, "draft");
    const timeout = Date.now() + 150_000;
    let app;
    do {
      app = (await loadState(userId)).applications.find((item) => item.id === applicationId)!;
      if (app.status !== "drafting") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < timeout);
    assert.equal(app!.status, "draft_review", app!.error || "Draft worker did not finish");
    assert.ok(app!.runWorkerClaimedAt, "Worker must claim the persisted run");
    assert.equal(app!.packet?.model, DEFAULT_AI_MODEL, "Must exercise the actual structured Responses draft");
    assert.ok(app!.packet?.profileHash);
    assert.ok(app!.packet!.answers.some((answer) => answer.requiresUserInput));
    console.log("PASS production-mode queue → Trigger.dev worker → OpenAI structured draft → owner-scoped Supabase review packet");
    console.log(JSON.stringify({ workerIntegrationCases: 1, passed: 1 }));
  } finally {
    await client.auth.admin.deleteUser(userId);
    await client.from("jobs").delete().eq("id", fixture.id);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
