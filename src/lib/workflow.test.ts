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
  hasSubmissionApproval,
  selectApplication,
  setFormSnapshot,
  setPacket,
  authorizeAutonomous,
  hasAutonomousAuthorization,
} from "@/lib/workflow";
import type { ApplicationPacket, DocxResumeArtifact, PdfResumeArtifact, ResumeSourcePlan } from "@/lib/types";

function sourcePlan(format: "docx" | "pdf"): ResumeSourcePlan {
  return {
    version: 1, format, sourceHash: "a".repeat(64), representationVersion: 1,
    profileHash: "b".repeat(64), factsHash: "c".repeat(64), settingsHash: "d".repeat(64), jobHash: "e".repeat(64),
    claims: [], edits: [], grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: [] }, model: "fixture",
  };
}

function sourceArtifact(format: "docx" | "pdf"): DocxResumeArtifact | PdfResumeArtifact {
  const common = {
    inputHash: "f".repeat(64), pageCount: 1 as const, sourceHash: "a".repeat(64), representationVersion: 1 as const,
    profileHash: "b".repeat(64), factsHash: "c".repeat(64), settingsHash: "d".repeat(64), jobHash: "e".repeat(64),
    baseline: { storageKey: "owner/baseline.pdf", sha256: "1".repeat(64), size: 100, mimeType: "application/pdf" as const },
  };
  if (format === "docx") return {
    ...common, format, renderer: "libreoffice-26.8", rendererVersion: "26.8", layoutPolicy: "docx-single-column-one-page-v1",
    layoutValidation: { outcome: "passed", pageWidthPt: 612, pageHeightPt: 792, unchangedAnchorTolerancePt: 1, pageSizeTolerancePt: 0.5, visualOutsideEditTolerance: 0.001, visualOutsideEditDifference: 0, baselinePdfHash: "1".repeat(64) },
    source: { storageKey: "owner/source.docx", sha256: "2".repeat(64), size: 200, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  };
  return {
    ...common, format, renderer: "apache-pdfbox", rendererVersion: "3.0.8", javaVersion: "21.0.12", runtimeArchitecture: "linux-x64",
    layoutPolicy: "pdf-single-column-one-page-v1",
    layoutValidation: { outcome: "passed", pageWidthPt: 612, pageHeightPt: 792, unchangedAnchorTolerancePt: 0.5, pageSizeTolerancePt: 0.5, visualMaskPaddingPt: 1.5, visualOutsideEditTolerance: 0, visualOutsideEditDifferenceAt144Dpi: 0, visualOutsideEditDifferenceAt300Dpi: 0, baselinePdfHash: "1".repeat(64) },
    source: { storageKey: "owner/source.pdf", sha256: "2".repeat(64), size: 200, mimeType: "application/pdf" },
  };
}

function attachSourceMetadata(packet: ApplicationPacket, format: "docx" | "pdf"): void {
  packet.schemaVersion = 3;
  packet.resumeMode = "tailored";
  packet.resumeSourcePlan = sourcePlan(format);
  packet.resumeArtifact = sourceArtifact(format);
}

describe("application approval gates", () => {
  it("records autonomous authorization without changing legacy reviewed approvals", () => {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);

    authorizeAutonomous(app, state.profile.id, 7, state.jobs[0].applyUrl);

    expect(app.approvals).toEqual([]);
    expect(hasAutonomousAuthorization(app, state.profile.id, 7, state.jobs[0].applyUrl)).toBe(true);
    expect(hasAutonomousAuthorization(app, "another-owner", 7, state.jobs[0].applyUrl)).toBe(false);
    expect(hasAutonomousAuthorization(app, state.profile.id, 6, state.jobs[0].applyUrl)).toBe(false);
  });

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

  it.each(["docx", "pdf"] as const)("preserves fill and final-submission approval for source-aware %s packets", async (format) => {
    const state = initialDemoState();
    const job = state.jobs[0];
    const app = selectApplication(state, job.id, state.profile.id);
    const packet = await draftPacket(state.profile, job);
    packet.answers = [];
    setPacket(state, app, packet);
    attachSourceMetadata(app.packet!, format);
    app.packetHash = hashJson(app.packet);

    approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
    setFormSnapshot(app, { version: 1, url: job.applyUrl, fields: [], attachments: ["tailored-resume.pdf"], capturedAt: new Date().toISOString() });
    approveSubmit(app, state.profile.id, app.form!.hash);

    expect(hasFillApproval(app, state.profile.id, job.applyUrl)).toBe(true);
    expect(hasSubmissionApproval(app)).toBe(true);
    expect(canSubmit(app)).toBe(true);

    app.approvals[0].targetUrl = `${job.applyUrl}/other`;
    expect(hasFillApproval(app, state.profile.id, job.applyUrl)).toBe(false);
    expect(hasSubmissionApproval(app)).toBe(false);
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

  it("allows more than three applications per day while stopping duplicates", () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    for (let index = 0; index < 10; index++) {
      state.jobs.push({ ...job, id: `extra-job-${index}`, sourceId: `extra-${index}`, url: `${job.url}/extra-${index}`, applyUrl: `${job.applyUrl}/extra-${index}` });
    }
    for (const job of state.jobs)
      selectApplication(state, job.id, state.profile.id);
    expect(state.applications).toHaveLength(state.jobs.length);
    expect(() =>
      selectApplication(state, state.jobs[0].id, state.profile.id),
    ).toThrow(/already exists/);
  });
});
