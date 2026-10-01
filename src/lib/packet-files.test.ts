import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { initialDemoState } from "@/lib/demo-data";
import { coverLetterFromFacts, draftPacket, packetProfileHash, validatePacket } from "@/lib/drafting";
import { reviewedPacketFile, withPacketFiles } from "@/lib/packet-files";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { approveFill, selectApplication, setPacket } from "@/lib/workflow";
import { prepareBrowser } from "@/lib/browser-runner";
import { hashJson } from "@/lib/crypto";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("reviewed application files", () => {
  it("reproduces the preview and upload bytes across different clocks", async () => {
    const state = initialDemoState();
    const packet = await draftPacket(state.profile, state.jobs[0]);
    const before = await reviewedPacketFile(state.profile, packet, "resume");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    const after = await reviewedPacketFile(state.profile, packet, "resume");
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(packet.files![0].sha256).toBe(createHash("sha256").update(after.bytes).digest("hex"));
    expect(packet.files![0].factIds).toEqual([...new Set(packet.resumeLines.flatMap((line) => line.factIds))]);
  });

  it("rejects changed file bytes before opening a browser, even with a matching packet approval", async () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    const app = selectApplication(state, job.id, state.profile.id);
    const packet = await draftPacket(state.profile, job);
    packet.answers = [];
    packet.files![0].sha256 = "0".repeat(64);
    setPacket(state, app, packet);
    approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
    const opened = vi.fn();
    await expect(prepareBrowser(app, job, state.profile, opened)).rejects.toThrow("application file changed");
    expect(opened).not.toHaveBeenCalled();
    expect(app.browserSessionId).toBeUndefined();
  });

  it("adds the required cover-letter file on revision and invalidates old consent", async () => {
    const state = initialDemoState();
    const job = state.jobs[0];
    const app = selectApplication(state, job.id, state.profile.id);
    const packet = await draftPacket(state.profile, job);
    packet.answers = [];
    setPacket(state, app, packet);
    approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
    const previousHash = app.packetHash;
    const letter = coverLetterFromFacts(state.profile, job);
    const revised = await withPacketFiles(state.profile, { ...packet, version: 2, coverLetter: letter.text, coverLetterFactIds: letter.factIds,
      coverLetterContext: { title: job.title, company: job.company } });
    validatePacket(state.profile, revised);
    expect(revised.files!.map((file) => file.kind)).toEqual(["resume", "cover-letter"]);
    expect(revised.files![0]).toEqual(packet.files![0]);
    const cover = await reviewedPacketFile(state.profile, revised, "cover-letter");
    expect(cover.bytes.subarray(0, 4).toString()).toBe("%PDF");
    app.status = "draft_review";
    setPacket(state, app, revised);
    expect(app.packetHash).not.toBe(previousHash);
    expect(app.approvals).toEqual([]);
    const missing = { ...revised, files: revised.files!.slice(0, 1) };
    expect(() => validatePacket(state.profile, missing)).toThrow("manifest is incomplete");
    const wrongFacts = structuredClone(revised);
    wrongFacts.files![0].factIds = ["invented-fact"];
    expect(() => validatePacket(state.profile, wrongFacts)).toThrow("verified facts");
    expect(hashJson(revised)).toBe(app.packetHash);
  });

  it("keeps the original DOCX unchanged while revising answers and adding a cover letter", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const state = initialDemoState();
    const { profile } = state;
    const bytes = Buffer.from("PK-original-DOCX-content");
    const key = `${profile.id}/00000000-0000-4000-8000-000000000015.docx`;
    await saveDemoOriginalResume(key, bytes);
    try {
      profile.resumeFileName = "meir-original.docx";
      profile.resumeSource = { storageKey: key, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
      profile.automationSettings!.resumeTailoring = false;
      const packet = await withPacketFiles(profile, { schemaVersion: 1, resumeMode: "original", originalResume: { ...profile.resumeSource, filename: profile.resumeFileName }, version: 1, summary: "Original résumé fixture", resumeLines: [], answers: [], createdAt: new Date().toISOString(), model: "confirmed-original-upload", profileHash: packetProfileHash(profile) });
      validatePacket(profile, packet);
      const letter = coverLetterFromFacts(profile, state.jobs[0]);
      const revised = await withPacketFiles(profile, { ...packet, version: 2, answers: [{ question: "Will you require visa sponsorship?", answer: "No", factIds: [], author: "human", userProvided: true, requiresUserInput: false }], coverLetter: letter.text, coverLetterFactIds: letter.factIds, coverLetterContext: { title: state.jobs[0].title, company: state.jobs[0].company } });
      validatePacket(profile, revised);

      expect(revised.files![0]).toEqual(packet.files![0]);
      expect(revised.files![0]).toMatchObject({ filename: "meir-original.docx", mimeType: profile.resumeSource.mimeType, storageKey: key, sha256: profile.resumeSource.sha256, size: bytes.length, factIds: [] });
      expect((await reviewedPacketFile(profile, revised, "resume")).bytes.equals(bytes)).toBe(true);
      expect((await reviewedPacketFile(profile, revised, "cover-letter")).bytes.subarray(0, 4).toString()).toBe("%PDF");
    } finally {
      await rm(`.data/resumes/${key}`, { force: true });
    }
  });
});
