import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { initialDemoState } from "../src/lib/demo-data";
import { loadState, mutateState } from "../src/lib/repository";
import { selectApplication, setPacket, approveFill } from "../src/lib/workflow";
import { packetProfileHash } from "../src/lib/drafting";
import { withPacketFiles } from "../src/lib/packet-files";
import { issueControlledTestGrant } from "../src/lib/controlled-tests";
import { queueApplicationRun } from "../src/lib/application-queue";
import { cancelBrowser } from "../src/lib/browser-runner";
import { browserQuestions } from "../src/lib/browser-questions";
import { remoteBrowserStatus } from "../src/lib/browser-provider";
import { writeBrowserQuestionEssays } from "../src/lib/browser-question-runs";

async function main() {
  process.env.DEMO_MODE = "false";
  const origin = process.env.APP_ORIGIN!;
  assert.ok(origin.startsWith("https://"));
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const users: Array<{ id: string; email: string; cookie: string }> = [];
  let applicationId = ""; let sessionId = "";
  try {
    for (let index = 0; index < 2; index++) {
      const email = `cloud-submit-${randomUUID()}@example.com`;
      const created = await db.auth.admin.createUser({ email, email_confirm: true }); assert.equal(created.error, null);
      users.push({ id: created.data.user!.id, email, cookie: "" });
      const link = await db.auth.admin.generateLink({ type: "magiclink", email }); assert.equal(link.error, null);
      const response = await fetch(`${origin}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
      assert.equal(response.status, 307);
      users[index].cookie = response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    }
    const owner = users[0];
    applicationId = await mutateState(owner.id, async state => {
      const profile = { ...initialDemoState().profile, id: owner.id, name: "Synthetic Question Test", email: owner.email, sensitiveAnswers: {}, demo: false };
      state.profile = profile;
      const job = { ...initialDemoState().jobs[1], id: `controlled-questions:${randomUUID()}`, company: "Controlled Test", title: "Synthetic software engineer", description: "A synthetic role building reliable software and useful tools.", requirements: ["Software engineering"], source: "imported" as const, url: `${origin}/api/internal/controlled-form`, applyUrl: `${origin}/api/internal/controlled-form` };
      state.importedJobs = [job]; state.jobs = [job];
      const app = selectApplication(state, job.id, owner.id);
      const issued = issueControlledTestGrant(owner.id, app.id);
      job.url = job.applyUrl = `${origin}/api/internal/controlled-form?token=${issued.token}`;
      app.jobSnapshot = { ...job }; app.controlledTest = { expiresAt: issued.grant.expiresAt, submissions: 0, questions: true };
      const fact = profile.facts.find(item => item.verified)!;
      setPacket(state, app, await withPacketFiles(profile, { schemaVersion: 1, version: 1, summary: "Synthetic browser question test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], createdAt: new Date().toISOString(), model: "controlled-fixture", profileHash: packetProfileHash(profile) }));
      approveFill(app, owner.id, app.packetHash!, job.applyUrl);
      return app.id;
    });
    await queueApplicationRun(owner.id, applicationId, "fill");
    const deadline = Date.now() + 280_000;
    let state; let app;
    do {
      state = await loadState(owner.id); app = state.applications.find(item => item.id === applicationId)!;
      if (app.status === "needs_user_action" && !app.browserQuestionRun && app.browserQuestionDrafts) break;
      if (app.error && !app.browserQuestionRun && app.status !== "filling") throw new Error(app.error);
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    assert.equal(app!.status, "needs_user_action", app!.error); assert.ok(app!.browserQuestionDrafts);
    if (Object.values(app!.browserQuestionDrafts!.answers).some(answer => !answer.aiDraft)) {
      await writeBrowserQuestionEssays(owner.id, applicationId, app!.form!.hash);
      app = (await loadState(owner.id)).applications.find(item => item.id === applicationId)!;
    }
    assert.ok(Object.values(app!.browserQuestionDrafts!.answers).every(answer => answer.aiDraft), app!.error || "AI draft was not grounded");
    const questions = browserQuestions(app!.form); assert.equal(questions.length, 3);
    sessionId = app!.browserSessionId!;
    const answers = questions.map(question => question.owner === "ai" ? { questionId: question.id, confirmEssay: true, answerHash: app!.browserQuestionDrafts!.answers[question.id].aiDraft!.contentHash } : { questionId: question.id, value: question.identifier === "sponsorship" ? "No" : "Chips" });
    const action = async (index: number, formHash: string) => {
      const response = await fetch(`${origin}/api/actions`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: users[index].cookie }, body: JSON.stringify({ action: "answerBrowserQuestions", payload: { applicationId, formHash, answers } }) });
      return { status: response.status, body: await response.json() };
    };
    const foreign = await action(1, app!.form!.hash);
    assert.equal(foreign.status, 400); assert.equal(foreign.body.error, "Application not found.");
    const stale = await action(0, "stale-form"); assert.equal(stale.status, 400); assert.match(stale.body.error, /changed/);
    const result = await action(0, app!.form!.hash); assert.equal(result.status, 200, result.body.error);
    app = (await loadState(owner.id)).applications.find(item => item.id === applicationId)!;
    assert.equal(app.status, "final_review", app.error); assert.equal(app.browserSessionId, sessionId);
    assert.equal(app.controlledTest!.submissions, 0); assert.equal(app.submissionAttemptedAt, undefined);
    assert.equal(app.approvals.some(approval => approval.kind === "submit"), false);
    assert.equal(app.form!.fields.find(field => field.identifier === "sponsorship" && field.checked)?.value, "No");
    assert.equal(app.form!.fields.find(field => field.identifier === "snack")?.value, "Chips");
    assert.ok(app.form!.fields.find(field => field.identifier === "why")?.value);
    assert.equal(app.browserAnswerApprovals?.length, 3);
    await assert.rejects(() => answerBrowserQuestions(owner.id, applicationId, app!.form!.hash, answers), /changed/);
    console.log("PASS production question flow: deployed fill worker, real cloud form, grounded AI draft, exact human options, same session, final review, zero submissions, stale/replay/cross-user service requests rejected");
    await cancelBrowser(app);
    let status = await remoteBrowserStatus(app);
    const stopDeadline = Date.now() + 15_000;
    while (status === "active" && Date.now() < stopDeadline) { await new Promise(resolve => setTimeout(resolve, 1000)); status = await remoteBrowserStatus(app); }
    assert.equal(status, "stopped");
  } finally {
    if (applicationId && users[0]) {
      const app = (await loadState(users[0].id)).applications.find(item => item.id === applicationId);
      if (app) await cancelBrowser({ ...app, browserSessionId: app.browserSessionId || sessionId }).catch(() => undefined);
      await db.storage.from("form-shots").remove([`${users[0].id}/${applicationId}.png`]);
    }
    for (const user of users) await db.auth.admin.deleteUser(user.id);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
