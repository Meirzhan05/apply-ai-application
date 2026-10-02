import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ApplicationPacket } from "@/lib/types";

const mocks = vi.hoisted(() => ({ user: vi.fn(), loadState: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, loadState: mocks.loadState }));

import { initialDemoState } from "@/lib/demo-data";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import { parsePdfSource } from "@/lib/pdf-source";
import { pdfSourceLayout, sourceLayoutHash } from "@/lib/resume-source-layout";
import { sourceEvidenceAnchors, sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";
import { sourceJobHash, sourceProfileHash } from "@/lib/resume-source-draft";
import { packetProfileHash } from "@/lib/drafting";
import { selectApplication } from "@/lib/workflow";
import { hashJson } from "@/lib/crypto";
import { bytesHash, readArtifact } from "@/lib/resume-artifacts";
import { saveDemoOriginalResume } from "@/lib/original-resume";
import { withPacketFiles } from "@/lib/packet-files";
import { ensurePdfTestRuntime } from "@/lib/pdf-test-runtime";
import { GET } from "@/app/api/applications/[id]/files/[kind]/route";

const cleanupPaths: string[] = [];
const publicBytes = (applicationId: string, kind: string, query = "") => GET(
  new Request(`https://apply.example/api/applications/${applicationId}/files/${kind}${query}`),
  { params: Promise.resolve({ id: applicationId, kind }) },
);

async function setup(options: { stale?: boolean; imported?: boolean } = {}) {
  const state = initialDemoState();
  const application = selectApplication(state, state.jobs[0].id, state.profile.id);
  const job = state.jobs.find((item) => item.id === application.jobId)!;
  const originalBytes = await createPdfSourceFixture();
  const sourceKey = `${state.profile.id}/${randomUUID()}.pdf`;
  await saveDemoOriginalResume(sourceKey, originalBytes);
  cleanupPaths.push(`.data/resumes/${sourceKey}`);
  const parsed = await parsePdfSource(originalBytes, state.profile.name);
  const source = sourceWithCurrentEvidenceClaims(parsed, state.profile.name);
  const sourceFacts = sourceEvidenceAnchors(source, 2, state.profile.name);
  state.profile.resumeFileName = "original.pdf";
  state.profile.resumeSource = { storageKey: sourceKey, sha256: bytesHash(originalBytes), size: originalBytes.length, mimeType: "application/pdf" };
  state.profile.resumeText = source.text;
  state.profile.resumeSourceDocument = source;
  state.profile.facts = sourceFacts.map((anchor, index) => ({ id: `comparison-fact-${index}`, text: anchor.text, verified: true, source: "resume" as const, sourceAnchorId: anchor.id }));
  const claims = sourceFacts.map((anchor, index) => ({ anchorId: anchor.id, text: anchor.text, factIds: [`comparison-fact-${index}`] }));
  const layout = pdfSourceLayout(source)!;
  const plan = {
    version: 1 as const, evidencePolicyVersion: 2 as const, jobHashPolicyVersion: 2 as const, format: "pdf" as const,
    sourceHash: source.sourceHash, representationVersion: source.version, profileHash: sourceProfileHash(state.profile),
    factsHash: hashJson(state.profile.facts.filter((fact) => fact.verified).map(({ id, text, source: factSource, sourceAnchorId }) => ({ id, text, source: factSource, ...(sourceAnchorId ? { sourceAnchorId } : {}) }))),
    settingsHash: hashJson(state.profile.automationSettings ?? null), jobHash: "", sourceLayout: layout, layoutHash: sourceLayoutHash(layout),
    claims, edits: [], grounding: { version: 1 as const, writerAttempts: 1, checkerAttempts: 1, repairAttempts: 0,
      findings: claims.map((claim) => ({ claimId: claim.anchorId, affectedText: claim.text, outcome: "supported" as const,
        reason: "The confirmed source fact supports this wording.", evidenceFactIds: claim.factIds })) }, model: "fixture",
  };
  if (options.imported) {
    Object.assign(job, { source: "imported" as const, sourceId: "synthetic-imported-posting", sourceLabel: "Private synthetic posting",
      url: "https://example.invalid/synthetic-role", applyUrl: "https://example.invalid/synthetic-role", importUrl: "https://example.invalid/synthetic-role",
      description: "Synthetic description used only before verification.", requirements: ["synthetic requirement"], importCheck: undefined });
  }
  application.jobSnapshot = structuredClone(job);
  plan.jobHash = sourceJobHash(importedAutonomyJob(application, job), 2);
  const draft: ApplicationPacket = { schemaVersion: 3, version: 1, summary: "Résumé comparison fixture", resumeLines: claims.map(({ text, factIds }) => ({ text, factIds })),
    answers: [], createdAt: "2026-10-01T00:00:00.000Z", model: plan.model, resumeMode: "tailored", resumeSourcePlan: plan,
    profileHash: packetProfileHash(state.profile) };
  application.packet = await withPacketFiles(state.profile, draft);
  application.packetHash = hashJson(application.packet);
  const artifact = application.packet.resumeArtifact!;
  if (artifact.format !== "pdf") throw new Error("The comparison fixture did not create the expected PDF artifact.");
  cleanupPaths.push(`.data/application-files/${application.packet.files!.find((file) => file.kind === "resume")!.storageKey}`,
    `.data/application-files/${artifact.baseline.storageKey}`, `.data/application-files/${artifact.source.storageKey}`);
  if (options.stale) state.profile.automationSettings = { ...state.profile.automationSettings!, resumeTailoring: false };
  mocks.user.mockResolvedValue(state.profile.id);
  mocks.loadState.mockResolvedValue(state);
  return { state, application, job, originalBytes };
}

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("DEMO_MODE", "true"); });
afterEach(async () => { vi.unstubAllEnvs(); for (const file of cleanupPaths.splice(0)) await rm(file, { force: true }); });
beforeAll(async () => { await ensurePdfTestRuntime(); }, 150_000);

describe("owner-scoped résumé comparison files", () => {
  it("serves the real saved baseline and tailored artifact as inline previews and downloads", async () => {
    const { state, application } = await setup();
    const packet = application.packet!;
    const artifact = packet.resumeArtifact!;
    if (artifact.format !== "pdf") throw new Error("Expected a PDF source artifact.");
    const finalFile = packet.files!.find((file) => file.kind === "resume")!;
    const baselineBytes = await readArtifact(state.profile.id, artifact.baseline.storageKey, artifact.baseline.sha256, artifact.baseline.size);
    const tailoredBytes = await readArtifact(state.profile.id, finalFile.storageKey!, finalFile.sha256, finalFile.size);
    const baseline = await publicBytes(application.id, "resume-original-preview");
    const tailored = await publicBytes(application.id, "resume-tailored-preview");
    const download = await publicBytes(application.id, "resume-tailored-preview", "?download=1");
    const employerAttachment = await publicBytes(application.id, "resume");

    expect(baseline.status).toBe(200);
    expect(Buffer.from(await baseline.arrayBuffer())).toEqual(baselineBytes);
    expect(baseline.headers.get("Content-Type")).toBe("application/pdf");
    expect(baseline.headers.get("Content-Disposition")).toContain("inline");
    const tailoredResponseBytes = Buffer.from(await tailored.arrayBuffer());
    expect(tailoredResponseBytes).toEqual(tailoredBytes);
    expect(tailored.headers.get("Content-Disposition")).toContain("inline");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(tailoredResponseBytes);
    expect(Buffer.from(await employerAttachment.arrayBuffer())).toEqual(tailoredResponseBytes);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    expect(baseline.headers.get("Cache-Control")).toBe("no-store");
    expect(baseline.headers.get("X-Content-Type-Options")).toBe("nosniff");
  }, 120_000);

  it("reports stale saved inputs without authorizing them as current", async () => {
    const { application } = await setup({ stale: true });
    const status = await publicBytes(application.id, "resume-comparison-status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ stale: true });
    expect(status.headers.get("Cache-Control")).toBe("no-store");
    const stalePreview = await publicBytes(application.id, "resume-tailored-preview");
    expect(stalePreview.status).toBe(409);
    expect(await stalePreview.text()).toContain("Rebuild the résumé");
  }, 120_000);

  it("keeps an unchanged unverified imported job current under the same normalization used by drafting", async () => {
    const { application } = await setup({ imported: true });
    const status = await publicBytes(application.id, "resume-comparison-status");
    const preview = await publicBytes(application.id, "resume-tailored-preview");
    expect(await status.json()).toMatchObject({ stale: false });
    expect(preview.status).toBe(200);
  }, 120_000);

  it("ignores changed unverified imported description and URL, but blocks changed verified job inputs", async () => {
    const { application, job } = await setup({ imported: true });
    const expected = application.packet!.resumeSourcePlan!.jobHash;
    job.description = "A different unverified description";
    job.requirements = ["A different unverified requirement"];
    job.url = "https://example.invalid/role?target=changed";
    job.applyUrl = job.url; job.importUrl = job.url;
    expect(sourceJobHash(importedAutonomyJob(application, job), 2)).toBe(expected);
    const freshStatus = await publicBytes(application.id, "resume-comparison-status");
    expect(await freshStatus.json()).toMatchObject({ stale: false });
    expect((await publicBytes(application.id, "resume")).status).toBe(200);

    job.importCheck = { status: "verified", checkedAt: "2026-10-02T00:00:00.000Z" };
    job.url = "https://boards.greenhouse.io/synthetic/jobs/123";
    job.applyUrl = job.url; job.importUrl = job.url;
    const staleStatus = await publicBytes(application.id, "resume-comparison-status");
    const staleArtifact = await publicBytes(application.id, "resume");
    expect(await staleStatus.json()).toMatchObject({ stale: true, staleReasons: ["job"] });
    expect(staleArtifact.status).toBe(409);
    expect(await staleArtifact.text()).toContain("Prepare and review a new résumé");
  }, 120_000);

  it("stales normalized title and trust changes while preserving the saved packet", async () => {
    const title = await setup({ imported: true });
    const originalPacket = structuredClone(title.application.packet);
    title.job.title = "Changed synthetic role title";
    const titleStatus = await publicBytes(title.application.id, "resume-comparison-status");
    const titlePreview = await publicBytes(title.application.id, "resume-tailored-preview");
    expect(await titleStatus.json()).toMatchObject({ stale: true, staleReasons: ["job"] });
    expect(titlePreview.status).toBe(409);
    expect(title.application.packet).toEqual(originalPacket);

    const trust = await setup({ imported: true });
    trust.job.url = "https://boards.greenhouse.io/synthetic/jobs/123";
    trust.job.applyUrl = trust.job.url; trust.job.importUrl = trust.job.url;
    trust.job.importCheck = { status: "verified", checkedAt: "2026-10-01T00:00:00.000Z" };
    expect((await publicBytes(trust.application.id, "resume-comparison-status")).status).toBe(200);
    expect(await (await publicBytes(trust.application.id, "resume-comparison-status")).json()).toMatchObject({ stale: true });
    expect((await publicBytes(trust.application.id, "resume-tailored-preview")).status).toBe(409);
  }, 120_000);

  it("downloads the exact owner-checked original upload", async () => {
    const { application, originalBytes } = await setup();
    const response = await publicBytes(application.id, "resume-original", "?download=1");
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(originalBytes);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(bytesHash(originalBytes)).toBe(application.packet!.resumeSourcePlan!.sourceHash);
  }, 120_000);

  it("denies other owners before returning source or comparison material", async () => {
    const { application } = await setup();
    mocks.user.mockResolvedValue("another-owner");
    expect((await publicBytes(application.id, "resume-original-preview")).status).toBe(404);
    expect((await publicBytes(application.id, "resume-original")).status).toBe(404);
  }, 120_000);
});
