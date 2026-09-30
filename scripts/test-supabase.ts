import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { initialDemoState } from "../src/lib/demo-data";
import { packetProfileHash } from "../src/lib/drafting";
import { withPacketFiles } from "../src/lib/packet-files";
import { setFormSnapshot, setPacket } from "../src/lib/workflow";
import { matchKey } from "../src/lib/match-cache";
import { assessMatchLocally } from "../src/lib/matching";
import { feedbackAdjustment } from "../src/lib/ranking";
import { essayContentHash, essayEvidenceHash } from "../src/lib/answer-policy";
import type { AppState, ScreeningAnswer } from "../src/lib/types";

async function main() {
  const appUrl = process.env.TEST_APP_URL || "http://localhost:3001";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const testId = randomUUID();
  const users: Array<{ id: string; cookie: string; client: typeof admin }> = [];
  const fixtureJob = { ...initialDemoState().jobs[0], id: `integration:${testId}`, source: "imported" as const, sourceId: testId, company: "Integration fixture", location: "New York, NY", remote: false, applyUrl: "https://example.org/apply", url: "https://example.org/apply" };
  let appId: string | undefined;
  async function action(index: number, action: string, payload: Record<string, unknown>) {
    const response = await fetch(`${appUrl}/api/actions`, { method: "POST", headers: { Cookie: users[index].cookie, Origin: appUrl, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    const data = await response.json();
    assert.equal(response.status, 200, `${action}: ${data.error ?? response.status}`);
    return data;
  }
  try {
    assert.equal((await fetch(`${appUrl}/api/state`)).status, 401, "Production app must reject anonymous state reads");
    for (const suffix of ["a", "b"]) {
      const email = `apply-integration-${testId}-${suffix}@example.com`;
      const password = `${randomUUID()}Aa1!`;
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      assert.equal(error, null);
      const id = data.user!.id;
      const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      users.push({ id, cookie: "", client });
      assert.equal((await client.auth.signInWithPassword({ email, password })).error, null);
      const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
      assert.equal(link.error, null);
      const callback = await fetch(`${appUrl}/auth/callback?type=magiclink&token_hash=${encodeURIComponent(link.data.properties.hashed_token)}`, { redirect: "manual" });
      assert.equal(callback.status, 307);
      assert.equal(new URL(callback.headers.get("location")!).pathname, "/");
      users.at(-1)!.cookie = callback.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
      assert.ok(users.at(-1)!.cookie);
      const response = await fetch(`${appUrl}/api/state`, { headers: { Cookie: users.at(-1)!.cookie } });
      const state = await response.json();
      assert.equal(response.status, 200);
      assert.equal(state.profile.id, id);
      assert.equal(state.profile.demo, false);
    }
    console.log("PASS two independent signed-in accounts and callback cookies");
    const seed = await admin.from("jobs").insert({ id: fixtureJob.id, source: fixtureJob.source, source_id: fixtureJob.sourceId, active: true, data: fixtureJob });
    assert.equal(seed.error, null);
    const fact = { id: randomUUID(), text: "Built a Python analytics dashboard for a confirmed class project.", verified: true, source: "user" };
    await action(0, "profile", { name: "Synthetic Account A", facts: [fact], skills: ["Python"], preferredTitles: ["Analyst"], preferredLocations: [], email: "forged@example.com" });
    await action(1, "profile", { name: "Synthetic Account B", facts: [], skills: [], preferredTitles: [], preferredLocations: [] });
    const stateA = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const stateB = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[1].cookie } })).json();
    assert.equal(stateA.profile.name, "Synthetic Account A");
    assert.equal(stateB.profile.name, "Synthetic Account B");
    assert.notEqual(stateA.profile.email, "forged@example.com");
    assert.equal(stateB.profile.facts.length, 0);
    console.log("PASS API profile ownership and verified sign-in email");
    for (const user of users) {
      const stream = await fetch(`${appUrl}/api/status`, { headers: { Cookie: user.cookie }, signal: AbortSignal.timeout(15000) });
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let event = "";
      while (!event.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        event += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      const data = event.match(/data: (.+)/)?.[1];
      assert.ok(data, "Status stream must send an initial state");
      assert.equal(JSON.parse(data).profile.id, user.id, "Status stream must be scoped to its signed-in owner");
    }
    console.log("PASS owner-scoped live status streams");
    await action(0, "select", { jobId: fixtureJob.id });
    const selected = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    appId = selected.applications[0].id;
    const stolen = await fetch(`${appUrl}/api/actions`, { method: "POST", headers: { Cookie: users[1].cookie, Origin: appUrl, "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", payload: { applicationId: appId } }) });
    assert.equal(stolen.status, 400);
    assert.equal((await stolen.json()).error, "Application not found.");
    const forgedOrigin = await fetch(`${appUrl}/api/actions`, { method: "POST", headers: { Cookie: users[0].cookie, Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", payload: { applicationId: appId } }) });
    assert.equal(forgedOrigin.status, 403);
    console.log("PASS cross-user mutation and cross-origin protection");
    await action(0, "feedback", { jobId: fixtureJob.id, kind: "dismissed", reason: "Wrong role", jobSnapshot: { title: "Forged context", requirements: [], location: "Forged location" } });
    const feedbackState = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const recordedFeedback = feedbackState.feedback.find((item: { jobId: string }) => item.jobId === fixtureJob.id);
    assert.deepEqual(recordedFeedback.jobSnapshot, { title: fixtureJob.title, requirements: fixtureJob.requirements, location: fixtureJob.location });
    const futureRole = { ...fixtureJob, id: "future-context-fixture" };
    assert.equal(feedbackAdjustment(futureRole, [recordedFeedback], [futureRole]), -8, "Feedback must still adjust ranking without the original active listing");
    const otherFeedback = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[1].cookie } })).json();
    assert.equal(otherFeedback.feedback.length, 0);
    console.log("PASS feedback context is server-owned, isolated and retained for future ranking");
    // Seed only this synthetic owner's draft; exercise actual HTTP review and
    // revision actions without calling an employer or consuming an AI run.
    const persisted = await admin.from("app_states").select("data,revision").eq("user_id", users[0].id).single();
    assert.equal(persisted.error, null);
    const fixtureState = persisted.data!.data as AppState;
    fixtureState.profile.strictLocations = true;
    fixtureState.profile.preferredLocations = ["NYC"];
    fixtureState.profile.updatedAt = new Date().toISOString();
    const fixtureApp = fixtureState.applications.find((app) => app.id === appId)!;
    const essay: ScreeningAnswer = { question: "Why are you interested in this role?", answer: `${fact.text} I want to bring this experience to the team.`, factIds: [fact.id], author: "ai", requiresUserInput: true,
      aiDraft: { version: 1, model: "controlled-fixture", contentHash: "", evidenceHash: essayEvidenceHash(fixtureState.profile, [fact.id]), sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }, { text: "I want to bring this experience to the team.", kind: "perspective", factIds: [] }] } };
    essay.aiDraft!.contentHash = essayContentHash(essay);
    const human: ScreeningAnswer = { question: "Which office would you prefer?", answer: "", factIds: [], author: "human", requiresUserInput: true };
    const packet = await withPacketFiles(fixtureState.profile, { schemaVersion: 1, version: 1, summary: "Synthetic file contract test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [essay, human], model: "controlled-fixture", createdAt: new Date().toISOString(), profileHash: packetProfileHash(fixtureState.profile) });
    setPacket(fixtureState, fixtureApp, packet);
    assert.equal((await admin.from("app_states").update({ data: fixtureState, revision: persisted.data!.revision + 1 }).eq("user_id", users[0].id)).error, null);
    const aliasState = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    assert.notEqual(aliasState.matches.find((match: { jobId: string }) => match.jobId === fixtureJob.id).assessment.category, "excluded", "NYC must keep a New York, NY posting eligible");
    const expiredJob = { ...fixtureJob, deadline: new Date(Date.now() - 60_000).toISOString() };
    fixtureState.matchCache ??= {};
    fixtureState.matchCache[matchKey(fixtureState.profile, expiredJob)] = { ...assessMatchLocally(fixtureState.profile, fixtureJob), category: "strong", score: 95, model: "cached-fixture" };
    assert.equal((await admin.from("jobs").update({ data: expiredJob }).eq("id", fixtureJob.id)).error, null);
    const latestFixture = await admin.from("app_states").select("revision").eq("user_id", users[0].id).single();
    assert.equal(latestFixture.error, null);
    assert.equal((await admin.from("app_states").update({ data: fixtureState, revision: latestFixture.data!.revision + 1 }).eq("user_id", users[0].id)).error, null);
    const expiredState = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const expiredAssessment = expiredState.matches.find((match: { jobId: string }) => match.jobId === fixtureJob.id).assessment;
    assert.equal(expiredAssessment.category, "excluded", "Elapsed hard deadline must override a cached strong assessment");
    assert.ok(expiredAssessment.gaps.includes("The application deadline has passed."));
    assert.equal((await admin.from("jobs").update({ data: fixtureJob }).eq("id", fixtureJob.id)).error, null);
    console.log("PASS authenticated matching keeps location aliases eligible and overrides stale AI evidence at a deadline");
    const reviewedProfile = structuredClone(fixtureState.profile);
    fixtureState.profile.workAuthorization = "Requires sponsorship";
    fixtureState.profile.updatedAt = new Date().toISOString();
    const sponsorshipRevision = await admin.from("app_states").select("revision").eq("user_id", users[0].id).single();
    assert.equal(sponsorshipRevision.error, null);
    assert.equal((await admin.from("app_states").update({ data: fixtureState, revision: sponsorshipRevision.data!.revision + 1 }).eq("user_id", users[0].id)).error, null);
    for (const [description, expected] of [
      ["We do not sponsor sports teams. Visa sponsorship is available for this role.", "eligible"],
      ["We do not sponsor sports teams.", "uncertain"],
      ["We do not provide visa sponsorship.", "excluded"],
      ["We do not offer visa sponsorship unless an exception applies.", "uncertain"],
    ] as const) {
      assert.equal((await admin.from("jobs").update({ data: { ...fixtureJob, description, requirements: ["Python"] } }).eq("id", fixtureJob.id)).error, null);
      const response = await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } });
      assert.equal(response.status, 200);
      const state = await response.json();
      const assessment = state.matches.find((match: { jobId: string }) => match.jobId === fixtureJob.id).assessment;
      if (expected === "eligible") {
        assert.notEqual(assessment.category, "excluded");
        assert.equal(assessment.uncertainty.some((note: string) => note.includes("employment sponsorship")), false);
      } else {
        assert.equal(assessment.category, expected);
        if (expected === "uncertain") assert.ok(assessment.uncertainty.some((note: string) => note.includes("employment sponsorship")));
      }
    }
    fixtureState.profile = reviewedProfile;
    const restoredRevision = await admin.from("app_states").select("revision").eq("user_id", users[0].id).single();
    assert.equal(restoredRevision.error, null);
    assert.equal((await admin.from("app_states").update({ data: fixtureState, revision: restoredRevision.data!.revision + 1 }).eq("user_id", users[0].id)).error, null);
    assert.equal((await admin.from("jobs").update({ data: fixtureJob }).eq("id", fixtureJob.id)).error, null);
    console.log("PASS authenticated matching distinguishes employment sponsorship, unrelated policies and conditional uncertainty");
    async function assertPreview(kind: string, sha256: string) {
      const preview = await fetch(`${appUrl}/api/applications/${appId}/files/${kind}`, { headers: { Cookie: users[0].cookie } });
      assert.equal(preview.status, 200);
      const bytes = Buffer.from(await preview.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
    }
    await assertPreview("resume", packet.files![0].sha256);
    await assertPreview("resume", packet.files![0].sha256);
    async function reject(index: number, requestedAction: string, payload: Record<string, unknown>, expected: RegExp) {
      const response = await fetch(`${appUrl}/api/actions`, { method: "POST", headers: { Cookie: users[index].cookie, Origin: appUrl, "Content-Type": "application/json" }, body: JSON.stringify({ action: requestedAction, payload }) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, expected);
    }
    await reject(0, "editPacket", { applicationId: appId, answers: [{ ...essay, answer: "A human-written essay" }, human] }, /AI writes essays/);
    await reject(0, "editPacket", { applicationId: appId, answers: [{ ...essay, question: "Preferred name?" }, human] }, /labels/);
    await reject(0, "confirmEssay", { applicationId: appId, packetHash: "stale", answerIndex: 0, answerHash: essay.aiDraft!.contentHash }, /packet changed/i);
    await reject(0, "confirmEssay", { applicationId: appId, packetHash: fixtureApp.packetHash, answerIndex: 0, answerHash: "forged" }, /essay changed/i);
    await reject(1, "confirmEssay", { applicationId: appId, packetHash: fixtureApp.packetHash, answerIndex: 0, answerHash: essay.aiDraft!.contentHash }, /Application not found/);
    await reject(0, "approveFill", { applicationId: appId, packetHash: fixtureApp.packetHash }, /confirm every AI essay/);
    await action(0, "confirmEssay", { applicationId: appId, packetHash: fixtureApp.packetHash, answerIndex: 0, answerHash: essay.aiDraft!.contentHash });
    const confirmed = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const confirmedApp = confirmed.applications.find((app: { id: string }) => app.id === appId);
    assert.ok(confirmedApp.packet.answers[0].confirmedAt);
    assert.equal(confirmedApp.packet.answers[0].requiresUserInput, false);
    assert.deepEqual(confirmed.profile.facts, fixtureState.profile.facts, "Confirming an essay must not verify proposed prose as profile facts");
    assert.equal(confirmedApp.approvals.length, 0, "Essay confirmation must not authorize filling or submitting");
    await reject(0, "confirmEssay", { applicationId: appId, packetHash: fixtureApp.packetHash, answerIndex: 0, answerHash: essay.aiDraft!.contentHash }, /packet changed/i);
    await action(0, "editPacket", { applicationId: appId, answers: [confirmedApp.packet.answers[0], { ...human, answer: "New York", requiresUserInput: false, userProvided: true }] });
    console.log("PASS actual API: immutable AI essays, exact confirmation, human-only answer edits, cross-user and stale-state rejection");
    const revised = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const revisedApp = revised.applications.find((app: { id: string }) => app.id === appId);
    assert.equal(revisedApp.packet.version, 3);
    assert.deepEqual(revised.profile, confirmed.profile, "Human answers must not change professional facts, sensitive profile fields, or matching inputs");
    assert.deepEqual(revisedApp.packet.answers[1].factIds, []);
    assert.equal(revisedApp.packet.answers[1].author, "human");
    assert.equal(revisedApp.packet.answers[1].answer, "New York");
    assert.equal(revisedApp.packet.answers[0].confirmedAt, confirmedApp.packet.answers[0].confirmedAt);
    assert.equal(revisedApp.packet.schemaVersion, 1);
    assert.deepEqual(revisedApp.packet.files, packet.files);
    await action(0, "approveFill", { applicationId: appId, packetHash: revisedApp.packetHash });
    let approved = await admin.from("app_states").select("data,revision").eq("user_id", users[0].id).single();
    assert.equal(approved.error, null);
    const approvalState = approved.data!.data as AppState;
    const approvalApp = approvalState.applications.find((app) => app.id === appId)!;
    setFormSnapshot(approvalApp, { version: 1, url: fixtureJob.applyUrl, fields: [], attachments: [], capturedAt: new Date().toISOString(), readyToSubmit: true });
    assert.equal((await admin.from("app_states").update({ data: approvalState, revision: approved.data!.revision + 1 }).eq("user_id", users[0].id)).error, null);
    await action(0, "approveSubmit", { applicationId: appId, formHash: approvalApp.form!.hash });
    assert.equal((await admin.from("jobs").update({ active: false, data: { ...fixtureJob, active: false } }).eq("id", fixtureJob.id)).error, null);
    for (const requestedAction of ["approveSubmit", "submit"]) {
      const rejected = await fetch(`${appUrl}/api/actions`, { method: "POST", headers: { Cookie: users[0].cookie, Origin: appUrl, "Content-Type": "application/json" }, body: JSON.stringify({ action: requestedAction, payload: { applicationId: appId, formHash: approvalApp.form!.hash } }) });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /listing is closed/);
    }
    const paused = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const pausedApp = paused.applications.find((app: { id: string }) => app.id === appId);
    assert.equal(pausedApp.status, "approved_to_submit");
    assert.equal(pausedApp.submissionStartedAt, undefined);
    assert.equal(pausedApp.submissionAttemptedAt, undefined);
    assert.equal((await admin.from("jobs").update({ active: true, data: fixtureJob }).eq("id", fixtureJob.id)).error, null);
    console.log("PASS authenticated final approval and submit actions reject a listing closed after review without starting a worker");
    approved = await admin.from("app_states").select("data,revision").eq("user_id", users[0].id).single();
    assert.equal(approved.error, null);
    const coverState = approved.data!.data as AppState;
    const coverApp = coverState.applications.find((app) => app.id === appId)!;
    assert.equal(coverApp.approvals[0].version, 1);
    coverApp.status = "needs_user_action";
    coverApp.needsCoverLetter = true;
    assert.equal((await admin.from("app_states").update({ data: coverState, revision: approved.data!.revision + 1 }).eq("user_id", users[0].id)).error, null);
    await action(0, "addCoverLetter", { applicationId: appId });
    const letterState = await (await fetch(`${appUrl}/api/state`, { headers: { Cookie: users[0].cookie } })).json();
    const letterApp = letterState.applications.find((app: { id: string }) => app.id === appId);
    assert.equal(letterApp.packet.version, 4);
    assert.deepEqual(letterApp.approvals, []);
    assert.equal(letterApp.packet.files.length, 2);
    await assertPreview("cover-letter", letterApp.packet.files[1].sha256);
    await assertPreview("resume", packet.files![0].sha256);
    console.log("PASS owner PDF bytes match manifests; answer and required-letter revisions preserve schema and renew consent");
    for (const bucket of ["resumes", "form-shots"]) {
      const path = `${users[0].id}/${testId}.${bucket === "resumes" ? "pdf" : "png"}`;
      const uploaded = await admin.storage.from(bucket).upload(path, Buffer.from("Synthetic private file"), { contentType: bucket === "resumes" ? "application/pdf" : "image/png" });
      assert.equal(uploaded.error, null);
      const stolenFile = await users[1].client.storage.from(bucket).download(path);
      assert.ok(stolenFile.error, "Account B must not download A's file");
      const publicFile = await fetch(`${url}/storage/v1/object/public/${bucket}/${path}`);
      assert.notEqual(publicFile.status, 200);
      if (bucket === "resumes") assert.equal((await users[0].client.storage.from(bucket).download(path)).error, null);
      await admin.storage.from(bucket).remove([path]);
    }
    for (const table of ["app_states", "service_budget", "service_budget_reservations"]) {
      const denied = await users[1].client.from(table).select("*");
      assert.ok(denied.error, `${table} must reject direct client access`);
    }
    console.log("PASS private file ownership, public URL denial, and direct table access denial");
    assert.equal((await fetch(`${appUrl}/api/applications/${appId}/files/resume`, { headers: { Cookie: users[1].cookie } })).status, 404);
    assert.equal((await fetch(`${appUrl}/api/screenshots/${appId}`, { headers: { Cookie: users[1].cookie } })).status, 404);
    console.log("PASS owner-scoped generated-file and screenshot routes");
    console.log(JSON.stringify({ supabaseIntegrationGroups: 12, passed: 12 }));
  } finally {
    for (const user of users) {
      await user.client.auth.signOut({ scope: "global" }).catch(() => undefined);
      await admin.auth.admin.deleteUser(user.id);
    }
    await admin.from("jobs").delete().eq("id", fixtureJob.id);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
