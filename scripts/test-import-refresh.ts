import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { tasks, runs } from "@trigger.dev/sdk";
import { initialDemoState } from "../src/lib/demo-data";
import { newImportedJob } from "../src/lib/import-jobs";
import { fetchBoard } from "../src/lib/sources";
import { selectApplication } from "../src/lib/workflow";
import type { AppState } from "../src/lib/types";
import type { refreshUserImports } from "../trigger/imports";

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const users: string[] = []; let handle: { id: string } | undefined;
  try {
    const [role] = await fetchBoard({ source: "greenhouse", slug: "cloudflare" }); assert.ok(role);
    const original = newImportedJob({ url: `https://job-boards.greenhouse.io/cloudflare/jobs/${role.sourceId}`, title: "Stale title" });
    const closed = newImportedJob({ url: "https://job-boards.greenhouse.io/cloudflare/jobs/9999999999999999", title: "Synthetic missing role" });
    const fixture = initialDemoState();
    fixture.profile = { ...fixture.profile, demo: false, facts: [], remoteOnly: false, strictLocations: false, preferredLocations: [], workAuthorization: "Unspecified" };
    fixture.jobs = [original, closed]; fixture.importedJobs = [...fixture.jobs]; fixture.applications = []; fixture.matchCache = {};
    fixture.activity = []; fixture.feedback = []; fixture.matchLabels = [];
    for (const suffix of ["a", "b"]) {
      const created = await db.auth.admin.createUser({ email: `import-worker-${randomUUID()}-${suffix}@example.com`, email_confirm: true });
      assert.equal(created.error, null); const owner = created.data.user!.id; users.push(owner);
      const state = structuredClone(fixture); state.profile.id = owner; state.profile.email = created.data.user!.email!;
      selectApplication(state, original.id, owner);
      const saved: Partial<AppState> = { ...state }; delete saved.jobs;
      assert.equal((await db.from("app_states").insert({ user_id: owner, data: saved, revision: 1 })).error, null);
    }
    handle = await tasks.trigger<typeof refreshUserImports>("refresh-user-imported-jobs", { userId: users[0] }, { concurrencyKey: users[0] });
    const deadline = Date.now() + 180_000;
    let run = await runs.retrieve(handle.id);
    while (!run.isCompleted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); run = await runs.retrieve(handle.id);
    }
    assert.equal(run.status, "COMPLETED");
    assert.deepEqual(run.output, { checked: 2, verified: 1, closed: 1, unavailable: 0 });
    const read = async (owner: string) => {
      const result = await db.from("app_states").select("data").eq("user_id", owner).single(); assert.equal(result.error, null);
      return result.data!.data as AppState;
    };
    const a = await read(users[0]); const b = await read(users[1]);
    const refreshed = a.importedJobs!.find((job) => job.id === original.id)!;
    assert.equal(refreshed.title, role.title); assert.equal(refreshed.discoveredAt, original.discoveredAt);
    assert.equal(refreshed.importCheck?.status, "verified");
    assert.equal(a.importedJobs!.find((job) => job.id === closed.id)!.active, false);
    assert.equal(a.applications[0].jobId, original.id); assert.equal(a.applications[0].jobSnapshot!.title, "Stale title");
    assert.equal(a.applications[0].approvals.length, 0);
    assert.deepEqual(b.importedJobs, fixture.importedJobs, "Another owner's identical imports must remain unchanged");
    const shared = await db.from("jobs").select("id").in("id", [original.id, closed.id]); assert.equal(shared.error, null); assert.equal(shared.data!.length, 0);
    console.log(JSON.stringify({ passed: true, runId: handle.id, status: run.status, output: run.output,
      ownerIsolation: true, privateCatalog: true, stableIdentity: true, originalSnapshotRetained: true,
      ownerApprovalsCreated: 0, employerSubmissions: 0 }));
  } finally {
    if (handle) {
      const run = await runs.retrieve(handle.id).catch(() => undefined);
      if (run && !run.isCompleted) await runs.cancel(handle.id);
    }
    for (const owner of users) assert.equal((await db.auth.admin.deleteUser(owner)).error, null);
    console.log("CLEANUP synthetic import-refresh accounts removed");
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Cloud import test failed"); process.exitCode = 1; });
