import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";
const mocks = vi.hoisted(() => ({ state: null as AppState | null, draft: vi.fn(), validate: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/repository", () => ({ loadState: async () => mocks.state, mutateState: async (_owner: string, change: (state: AppState) => unknown) => change(mocks.state!) }));
vi.mock("@/lib/drafting", () => ({ draftPacket: mocks.draft, validatePacket: mocks.validate }));
vi.mock("@/lib/workflow", async (original) => ({ ...await original<typeof import("@/lib/workflow")>(), setPacket: mocks.set }));
import { runDraft } from "@/lib/application-runs";
import { selectApplication } from "@/lib/workflow";
import { ResumeDraftError } from "@/lib/resume-document";
beforeEach(() => { vi.clearAllMocks(); mocks.state = initialDemoState(); });
describe("LaTeX drafting worker recovery", () => {
  it("persists actionable grounding findings for manual drafting and preserves the last valid packet", async () => {
    const state = mocks.state!; const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "drafting"; app.runToken = "grounding-run";
    app.packet = { schemaVersion: 1, version: 7, model: "fixture", summary: "last valid packet", createdAt: new Date().toISOString(), resumeLines: [{ text: state.profile.facts[0].text, factIds: [state.profile.facts[0].id] }], answers: [] };
    const previous = structuredClone(app.packet);
    const diagnostics = { version: 1 as const, outcome: "needs_information" as const, writerAttempts: 3, checkerAttempts: 3, repairAttempts: 2, findings: [{ claimId: "experience.0.bullets.0", affectedText: "Increased revenue by 90%.", outcome: "unsupported" as const, reason: "No confirmed fact supports this result.", evidenceFactIds: [state.profile.facts[0].id], requiredInformation: "Confirm the measured revenue increase." }], requiredInformation: ["Confirm the measured revenue increase."] };
    mocks.draft.mockRejectedValueOnce(new ResumeDraftError(diagnostics));
    await expect(runDraft({ userId: state.profile.id, applicationId: app.id, runToken: "grounding-run" })).rejects.toMatchObject({ diagnostics });
    expect(app.status).toBe("draft_review"); expect(app.packet).toEqual(previous);
    expect(app.resumeDraftDiagnostics).toEqual(diagnostics);
    expect(app.error).toContain("Increased revenue by 90%"); expect(app.error).toContain("Confirm the measured revenue increase");
  });

  it("preserves the previous packet on compiler/provider/storage failure", async () => {
    const state = mocks.state!; const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "drafting"; app.runToken = "run";
    app.packet = { schemaVersion: 1, version: 1, model: "fixture", summary: "original", createdAt: new Date().toISOString(), resumeLines: [{ text: state.profile.facts[0].text, factIds: [state.profile.facts[0].id] }], answers: [] };
    const before = structuredClone(app.packet); mocks.draft.mockRejectedValueOnce(new Error("LaTeX compilation failed"));
    await expect(runDraft({ userId: state.profile.id, applicationId: app.id, runToken: "run" })).rejects.toThrow(/compilation failed/);
    expect(app.packet).toEqual(before); expect(app.status).toBe("draft_review"); expect(app.error).toContain("compilation failed"); expect(mocks.set).not.toHaveBeenCalled();
  });
  it("preserves legacy resume behavior for an older tab and rebuilds only with explicit resume mode", async () => {
    const state = mocks.state!; const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "drafting"; app.runToken = "legacy-run";
    app.packet = { schemaVersion: 1, version: 1, model: "fixture", summary: "original", createdAt: new Date().toISOString(), resumeLines: [], answers: [] };
    mocks.draft.mockResolvedValue({ summary: "new packet" });
    await runDraft({ userId: state.profile.id, applicationId: app.id, runToken: "legacy-run" });
    expect(mocks.draft.mock.calls[0][3]).toMatchObject({ preserveResume: true, regenerateEssays: true });
    app.runWorkerClaimedAt = undefined; app.runToken = "resume-run";
    await runDraft({ userId: state.profile.id, applicationId: app.id, runToken: "resume-run", draftMode: "resume" });
    expect(mocks.draft.mock.calls[1][3]).toMatchObject({ preserveResume: false, regenerateEssays: false });
  });
  it("ignores duplicate delivery before drafting or compiling again", async () => {
    const state = mocks.state!; const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.status = "drafting"; app.runToken = "run";
    mocks.draft.mockResolvedValue({ summary: "new packet" });
    const results = await Promise.all([runDraft({ userId: state.profile.id, applicationId: app.id, runToken: "run" }), runDraft({ userId: state.profile.id, applicationId: app.id, runToken: "run" })]);
    expect(results.some((result) => "skipped" in result)).toBe(true); expect(mocks.draft).toHaveBeenCalledOnce();
    expect(mocks.draft.mock.calls[0][3].resumeFormat).toBe("latex");
  });
});
