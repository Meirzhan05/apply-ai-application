import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { draftPacket } from "@/lib/drafting";
import { hashJson } from "@/lib/crypto";
import {
  approveFill,
  approveSubmit,
  canSubmit,
  formDigest,
  hasFillApproval,
  selectApplication,
  setFormSnapshot,
  setPacket,
} from "@/lib/workflow";

describe("application approval gates", () => {
  it("refuses a second application through a tracking alias of the same posting", () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    selectApplication(state, job.id, state.profile.id);
    const alias = { ...job, id: "imported:alias", url: `${job.url}?utm_source=email` };
    state.jobs.push(alias);
    expect(() => selectApplication(state, alias.id, state.profile.id)).toThrow("already exists");
    expect(state.applications).toHaveLength(1);
  });

  it("binds both approvals to the reviewed packet and form", async () => {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    const packet = await draftPacket(state.profile, state.jobs[0]);
    packet.answers = [{ question: "Preferred office?", answer: state.profile.facts[0].text, factIds: [state.profile.facts[0].id], requiresUserInput: false, userProvided: true }];
    setPacket(state, app, packet);
    expect(() =>
      approveFill(app, state.profile.id, "stale", state.jobs[0].applyUrl),
    ).toThrow(/current application packet/);
    approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
    const form = {
      version: 1 as const,
      url: state.jobs[0].applyUrl,
      fields: [{ label: "Email", value: "taylor@example.com", kind: "email" }],
      attachments: ["resume.pdf"],
      capturedAt: new Date().toISOString(),
    };
    setFormSnapshot(app, form);
    expect(() => approveSubmit(app, state.profile.id, "stale")).toThrow(
      /form changed/i,
    );
    approveSubmit(app, state.profile.id, app.form!.hash);
    expect(app.approvals.map((approval) => approval.version)).toEqual([1, 1]);
    expect(canSubmit(app)).toBe(true);
    expect(
      formDigest({
        ...form,
        fields: [{ ...form.fields[0], value: "changed@example.com" }],
      }),
    ).not.toBe(app.form!.hash);
  });

  it("accepts legacy v1 approval semantics and rejects unsupported explicit versions", async () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    const app = selectApplication(state, job.id, state.profile.id);
    const packet = await draftPacket(state.profile, job);
    packet.answers = [];
    packet.version = 2;
    setPacket(state, app, packet);
    // Persisted packets had a revision, but no schema marker. Leave their
    // bytes intact so a deployment cannot silently change approved content.
    Reflect.deleteProperty(app.packet!, "schemaVersion");
    Reflect.deleteProperty(app.packet!, "files");
    app.packetHash = hashJson(app.packet);
    approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
    setFormSnapshot(app, { version: 1, url: job.applyUrl, fields: [], attachments: [], capturedAt: new Date().toISOString() });
    approveSubmit(app, state.profile.id, app.form!.hash);
    // The legacy wire format had the same owner, target, hash, and timestamp.
    app.approvals = JSON.parse(JSON.stringify(app.approvals).replace(/"version":1,/g, ""));
    expect(hasFillApproval(app, state.profile.id, job.applyUrl)).toBe(true);
    expect(canSubmit(app)).toBe(true);
    Object.assign(app.packet!, { schemaVersion: 2 });
    app.packetHash = hashJson(app.packet);
    app.approvals[0].reviewHash = app.packetHash;
    expect(hasFillApproval(app, state.profile.id, job.applyUrl)).toBe(false);
    expect(canSubmit(app)).toBe(false);
    Reflect.deleteProperty(app.packet!, "schemaVersion");
    app.packetHash = hashJson(app.packet);
    app.approvals[0].reviewHash = app.packetHash;
    Object.assign(app.approvals[0], { version: 2 });
    expect(hasFillApproval(app, state.profile.id, job.applyUrl)).toBe(false);
    expect(canSubmit(app)).toBe(false);
    Object.assign(app.approvals[0], { version: 1 });
    Object.assign(app.approvals[1], { version: 2 });
    expect(canSubmit(app)).toBe(false);
    Object.assign(app.approvals[1], { version: null });
    expect(canSubmit(app)).toBe(false);
  });

  it("refuses unanswered questions even if the client bypasses its disabled button", async () => {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    setPacket(state, app, await draftPacket(state.profile, state.jobs[0]));
    expect(() => approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl)).toThrow(/confirm every AI essay/);
  });

  it("can refresh a reviewed form and removes its previous final approval", () => {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "filling";
    const form = { version: 1 as const, url: state.jobs[0].applyUrl, fields: [], attachments: [], capturedAt: new Date().toISOString() };
    setFormSnapshot(app, form);
    const firstHash = app.form!.hash;
    setFormSnapshot(app, { ...form, fields: [{ label: "New question", value: "", kind: "text", required: true }] });
    expect(app.form!.hash).not.toBe(firstHash);
    expect(app.transitionHistory?.at(-1)?.to).toBe("final_review");
  });

  it("detects checkbox, option, file content, and required-field changes", () => {
    const form = { url: "https://employer.example/apply", fields: [{ label: "Resume", value: "resume.pdf", kind: "file", fileHashes: ["original"] }], attachments: ["resume.pdf"] };
    const initial = formDigest(form);
    expect(formDigest({ ...form, fields: [{ ...form.fields[0], fileHashes: ["replaced"] }] })).not.toBe(initial);
    expect(formDigest({ ...form, fields: [{ ...form.fields[0], required: true }] })).not.toBe(initial);
    expect(formDigest({ ...form, fields: [{ ...form.fields[0], checked: true }] })).not.toBe(initial);
    expect(formDigest({ ...form, fields: [{ ...form.fields[0], options: ["new"] }] })).not.toBe(initial);
  });

  it("stops duplicate and excess initiated applications", () => {
    const state = initialDemoState();
    for (const job of state.jobs)
      selectApplication(state, job.id, state.profile.id);
    expect(() =>
      selectApplication(state, state.jobs[0].id, state.profile.id),
    ).toThrow(/already exists/);
    state.jobs.push({ ...state.jobs[0], id: "extra-job", sourceId: "extra", url: `${state.jobs[0].url}/extra`, applyUrl: `${state.jobs[0].applyUrl}/extra` });
    expect(() =>
      selectApplication(state, "extra-job", state.profile.id),
    ).toThrow(/limit of three/);
  });
});
