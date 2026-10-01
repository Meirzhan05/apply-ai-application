import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashJson } from "@/lib/crypto";
import { latexFixture } from "./latex-fixture";
import { resumeFields, resumeInputHash, sealResume } from "@/lib/resume-document";
import { bytesHash } from "@/lib/resume-artifacts";
import { resumeLatex } from "@/lib/resume-latex";
import type { ApplicationPacket } from "@/lib/types";
const mocks = vi.hoisted(() => ({ fit: vi.fn(), save: vi.fn(), read: vi.fn(), bytes: new Map<string, Buffer>() }));
vi.mock("@/lib/latex-compiler", () => ({ fitResume: mocks.fit }));
vi.mock("@/lib/resume-artifacts", async (original) => ({ ...await original<typeof import("@/lib/resume-artifacts")>(), saveArtifact: mocks.save, readArtifact: mocks.read }));
import { reviewedPacketFile, reviewedResumeSource, withPacketFiles } from "@/lib/packet-files";
import { coverLetterFromFacts, packetProfileHash, validatePacket } from "@/lib/drafting";
import { approveFill, hasFillApproval, selectApplication, setPacket } from "@/lib/workflow";
import { initialDemoState } from "@/lib/demo-data";

function unrenderedPacket(): ApplicationPacket {
  const { profile, document } = latexFixture();
  return { schemaVersion: 2, version: 1, model: document.model, summary: "Application fixture", createdAt: new Date().toISOString(), profileHash: packetProfileHash(profile), answers: [], resumeDocument: document,
    resumeLines: resumeFields(document).map(({ text, factIds }) => ({ text, factIds })) };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.bytes.clear();
  mocks.fit.mockImplementation(async (profile, document) => ({ document, pdf: Buffer.from("%PDF-reviewed-fixture"), source: resumeLatex(profile, document) }));
  mocks.save.mockImplementation(async (owner, input, bytes: Buffer, extension) => {
    const sha256 = bytesHash(bytes); const storageKey = `${owner}/${input}/${sha256}.${extension}`;
    mocks.bytes.set(storageKey, bytes); return { storageKey, sha256, size: bytes.length };
  });
  mocks.read.mockImplementation(async (_owner, key, hash, size) => {
    const bytes = mocks.bytes.get(key);
    if (!bytes || bytesHash(bytes) !== hash || bytes.length !== size) throw new Error("The application file changed.");
    return bytes;
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("v2 reviewed LaTeX packets", () => {
  it("compiles once and reuses exact saved bytes for preview, source download and upload", async () => {
    const { profile } = latexFixture();
    const packet = await withPacketFiles(profile, unrenderedPacket());
    validatePacket(profile, packet);
    const preview = await reviewedPacketFile(profile, packet, "resume");
    const upload = await reviewedPacketFile(profile, packet, "resume");
    const tex = await reviewedResumeSource(profile, packet);
    expect(upload.bytes.equals(preview.bytes)).toBe(true);
    expect(tex.bytes.toString()).toContain("\\documentclass");
    expect(mocks.fit).toHaveBeenCalledOnce();
    expect(packet.resumeArtifact!.inputHash).toBe(resumeInputHash(profile, packet.resumeDocument!));
  });
  it("reuses artifacts across human-answer edits and cover-letter revisions", async () => {
    const { profile } = latexFixture();
    const packet = await withPacketFiles(profile, unrenderedPacket());
    const letter = coverLetterFromFacts(profile, initialDemoState().jobs[0]);
    const revised = await withPacketFiles(profile, { ...packet, version: 2, coverLetter: letter.text, coverLetterFactIds: letter.factIds,
      answers: [{ question: "Office preference?", answer: "New York", factIds: [], author: "human", userProvided: true, requiresUserInput: false }] });
    validatePacket(profile, revised);
    expect(revised.schemaVersion).toBe(2);
    expect(revised.files![0]).toEqual(packet.files![0]);
    expect(revised.resumeArtifact).toEqual(packet.resumeArtifact);
    expect(mocks.fit).toHaveBeenCalledOnce(); expect(revised.files!.every((file) => Boolean(file.storageKey))).toBe(true);
  });
  it("invalidates approval on rebuild and accepts complete v2 approval semantics", async () => {
    const state = initialDemoState(); state.profile = latexFixture().profile;
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    const packet = await withPacketFiles(state.profile, unrenderedPacket());
    setPacket(state, app, packet); approveFill(app, state.profile.id, app.packetHash!, state.jobs[0].applyUrl);
    expect(hasFillApproval(app, state.profile.id, state.jobs[0].applyUrl)).toBe(true);
    app.status = "draft_review";
    const rebuilt = await withPacketFiles(state.profile, { ...unrenderedPacket(), version: 2 });
    setPacket(state, app, rebuilt);
    expect(app.approvals).toEqual([]); expect(app.packetHash).not.toBe(hashJson(packet));
  });
  it("rejects changed bytes, stale profile, changed content, cross-owner manifests, and preview tampering", async () => {
    const { profile } = latexFixture(); const packet = await withPacketFiles(profile, unrenderedPacket());
    mocks.bytes.set(packet.files![0].storageKey!, Buffer.from("tampered"));
    await expect(reviewedPacketFile(profile, packet, "resume")).rejects.toThrow(/file changed/);
    const stale = structuredClone(profile); stale.facts[0].text += " changed";
    expect(() => validatePacket(stale, packet)).toThrow(/profile changed/);
    const tampered = structuredClone(packet); tampered.resumeLines[0].text = "Invented";
    expect(() => validatePacket(profile, tampered)).toThrow(/preview differs/);
    const crossOwner = structuredClone(packet); crossOwner.files![0].storageKey = packet.files![0].storageKey!.replace(profile.id, "another-owner");
    expect(() => validatePacket(profile, crossOwner)).toThrow(/reviewed content/);
    const changed = structuredClone(packet); changed.resumeDocument!.projects[0].bullets[0].text += " changed";
    changed.resumeDocument = sealResume(profile, changed.resumeDocument!);
    await expect(withPacketFiles(profile, changed)).rejects.toThrow(/reviewed content/);
  });
  it("does not return a new packet if compilation or storage fails", async () => {
    const { profile } = latexFixture(); const packet = unrenderedPacket();
    mocks.fit.mockRejectedValueOnce(new Error("compiler unavailable"));
    await expect(withPacketFiles(profile, packet)).rejects.toThrow(/compiler unavailable/);
    expect(packet.files).toBeUndefined(); expect(mocks.save).not.toHaveBeenCalled();
    mocks.save.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(withPacketFiles(profile, packet)).rejects.toThrow(/storage unavailable/);
    expect(packet.resumeArtifact).toBeUndefined();
  });
});
