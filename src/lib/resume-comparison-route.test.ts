import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationPacket } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  loadState: vi.fn(),
  validate: vi.fn(),
  comparison: vi.fn(),
  finalFile: vi.fn(),
  original: vi.fn(),
  readOriginal: vi.fn(),
}));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, loadState: mocks.loadState }));
vi.mock("@/lib/drafting", () => ({ validatePacket: mocks.validate }));
vi.mock("@/lib/packet-files", () => ({ reviewedResumeComparisonFiles: mocks.comparison, reviewedPacketFile: mocks.finalFile }));
vi.mock("@/lib/original-resume", () => ({ originalResumeManifest: mocks.original, readOriginalResume: mocks.readOriginal }));

import { initialDemoState } from "@/lib/demo-data";
import { sourceJobHash } from "@/lib/resume-source-draft";
import { selectApplication } from "@/lib/workflow";
import { GET } from "@/app/api/applications/[id]/files/[kind]/route";

const sourceHash = "a".repeat(64);
const baselineBytes = Buffer.from("%PDF-baseline-exact");
const tailoredBytes = Buffer.from("%PDF-tailored-exact");
const originalBytes = Buffer.from("original upload exact bytes");

function setup(stale = true) {
  const state = initialDemoState();
  const application = selectApplication(state, state.jobs[0].id, state.profile.id);
  const job = state.jobs.find((item) => item.id === application.jobId)!;
  const packet: ApplicationPacket = {
    schemaVersion: 3, version: 1, summary: "Résumé comparison", resumeLines: [], answers: [],
    createdAt: "2026-10-01T00:00:00.000Z", model: "fixture",
    resumeSourcePlan: { version: 1, format: "docx", sourceHash, representationVersion: 1, profileHash: "b".repeat(64), factsHash: "c".repeat(64), settingsHash: "d".repeat(64), jobHash: sourceJobHash(job), claims: [], edits: [], grounding: { version: 1, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0, findings: [] }, model: "fixture" },
  };
  application.packet = packet;
  state.profile.resumeFileName = "original.docx";
  state.profile.resumeSource = { storageKey: `${state.profile.id}/00000000-0000-4000-8000-000000000001.docx`, sha256: sourceHash, size: originalBytes.length, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  state.profile.resumeSourceDocument = { version: 1, parser: "docx-ooxml-1", format: "docx", sourceHash, text: "Source", support: { status: "candidate" }, layout: { columns: 1, sectionCount: 1, pageSizePt: { width: 612, height: 792 }, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 }, pageCount: 1, fontFamilies: ["Noto Sans"] }, sections: [], anchors: [] };
  mocks.user.mockResolvedValue(state.profile.id);
  mocks.loadState.mockResolvedValue(state);
  mocks.validate.mockImplementation(() => {});
  mocks.comparison.mockResolvedValue({
    baseline: { bytes: baselineBytes, filename: "original-layout-preview.pdf", mimeType: "application/pdf" },
    tailored: { bytes: tailoredBytes, filename: "tailored-resume.pdf", mimeType: "application/pdf" },
    stale, staleReasons: stale ? ["facts"] : [],
  });
  mocks.finalFile.mockResolvedValue({ bytes: tailoredBytes, filename: "tailored-resume.pdf", mimeType: "application/pdf" });
  mocks.original.mockReturnValue({ ...state.profile.resumeSource, filename: state.profile.resumeFileName });
  mocks.readOriginal.mockResolvedValue(originalBytes);
  return { state, application };
}

async function get(applicationId: string, kind: string, query = "") {
  return GET(new Request(`https://apply.example/api/applications/${applicationId}/files/${kind}${query}`), { params: Promise.resolve({ id: applicationId, kind }) });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("owner-scoped résumé comparison files", () => {
  it("serves the saved baseline and tailored PDF bytes as inline previews and downloads", async () => {
    const { application } = setup(false);
    const baseline = await get(application.id, "resume-original-preview");
    const tailored = await get(application.id, "resume-tailored-preview");
    const download = await get(application.id, "resume-tailored-preview", "?download=1");
    const employerAttachment = await get(application.id, "resume");

    expect(baseline.status).toBe(200);
    expect(Buffer.from(await baseline.arrayBuffer())).toEqual(baselineBytes);
    expect(baseline.headers.get("Content-Type")).toBe("application/pdf");
    expect(baseline.headers.get("Content-Disposition")).toContain("inline");
    const tailoredResponseBytes = Buffer.from(await tailored.arrayBuffer());
    expect(tailoredResponseBytes).toEqual(tailoredBytes);
    expect(tailored.headers.get("Content-Disposition")).toContain("inline");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(tailoredBytes);
    expect(Buffer.from(await employerAttachment.arrayBuffer())).toEqual(tailoredResponseBytes);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    expect(baseline.headers.get("Cache-Control")).toBe("no-store");
    expect(baseline.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("reports stale saved inputs without authorizing them as current", async () => {
    const { application } = setup();
    const response = await get(application.id, "resume-comparison-status");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stale: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const stalePreview = await get(application.id, "resume-tailored-preview");
    expect(stalePreview.status).toBe(409);
    expect(await stalePreview.text()).toContain("Rebuild the résumé");
  });

  it("downloads the exact original upload when it still matches the saved source", async () => {
    const { application } = setup();
    const response = await get(application.id, "resume-original", "?download=1");

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(originalBytes);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(mocks.readOriginal).toHaveBeenCalledWith("demo-user", expect.objectContaining({ sha256: sourceHash, filename: "original.docx" }));
  });

  it("denies other owners before reading source or comparison files", async () => {
    const { application } = setup();
    mocks.user.mockResolvedValue("another-owner");

    expect((await get(application.id, "resume-original-preview")).status).toBe(404);
    expect((await get(application.id, "resume-original")).status).toBe(404);
    expect(mocks.comparison).not.toHaveBeenCalled();
    expect(mocks.readOriginal).not.toHaveBeenCalled();
  });
});
