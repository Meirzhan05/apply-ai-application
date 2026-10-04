import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { parseDocxSource } from "@/lib/docx-source";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import type { AppState, VerifiedFact } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: null as AppState | null, extract: vi.fn(), budget: true, search: vi.fn(), matches: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/repository", () => ({ isDemo: () => false, loadState: async () => structuredClone(fixture.state!), mutateState: async (_owner: string, fn: (s: AppState) => unknown) => fn(fixture.state!) }));
vi.mock("@/lib/account-lifecycle", () => ({ withAccountOperation: async (_owner: string, _kind: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/budget", () => ({ reserveServiceBudget: async () => fixture.budget }));
vi.mock("@/lib/model-usage", () => ({ withModelUsageContext: async (_context: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/resume-fact-extraction", () => ({ extractResumeFacts: fixture.extract }));
vi.mock("@/lib/personal-search", () => ({ queuePersonalSearch: fixture.search }));
vi.mock("@/lib/match-queue", () => ({ queueMatchAssessment: fixture.matches }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger: fixture.dispatch } }));
import { ensureResumeExtraction, queuedResumeExtraction, retryResumeExtraction, runResumeExtraction } from "@/lib/resume-extraction-jobs";

beforeEach(async () => {
  vi.clearAllMocks(); fixture.budget = true;
  fixture.state = initialDemoState(); fixture.state.profile.name = "Riley Example";
  fixture.state.profile.facts = [
    { id: "manual", text: "Built a Python API for a class project.", source: "user", verified: true },
    { id: "old", text: "Old resume experience.", source: "resume", verified: true },
  ];
  const document = await parseDocxSource(await createDocxSourceFixture(), "Riley Example");
  fixture.state.profile.resumeFileName = "old.pdf";
  fixture.state.profile.resumeText = "Old source text.";
  fixture.state.profile.resumeExtraction = queuedResumeExtraction("new.docx", { source: {
    sha256: document.sourceHash, size: 1000, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", storageKey: "owner/fixture.docx",
  }, document });
  const bullet = document.anchors.find(a => a.kind === "bullet")!;
  const facts: VerifiedFact[] = [{ id: "new", text: "Built a recommender with 92% precision.", source: "resume", verified: false, status: "accepted", sourceAnchorId: bullet.id,
    grounding: { version: 1, sourceHash: document.sourceHash, model: "test", acceptedText: "Built a recommender with 92% precision.", evidence: [{ anchorId: bullet.id, quote: bullet.text }] } }];
  fixture.extract.mockResolvedValue(facts);
  fixture.search.mockResolvedValue(true); fixture.matches.mockResolvedValue(undefined); fixture.dispatch.mockResolvedValue({ id: "dispatched" });
  vi.stubEnv("TRIGGER_SECRET_KEY", "test");
});

it("activates source and facts together, preserving manual facts and starting downstream matching", async () => {
  const id = fixture.state!.profile.resumeExtraction!.id;
  const originalVersion = fixture.state!.profile.automationVersion;
  expect(await runResumeExtraction({ userId: "owner", requestId: id })).toMatchObject({ ready: true, facts: 1 });
  expect(fixture.state!.profile.resumeFileName).toBe("new.docx");
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "new"]);
  expect(fixture.state!.profile.resumeExtraction).toMatchObject({ status: "ready", pending: undefined });
  expect(fixture.state!.profile.automationVersion).toBeGreaterThan(originalVersion);
  expect(fixture.search).toHaveBeenCalledWith("owner");
  expect(fixture.matches).toHaveBeenCalledWith("owner");
  expect(await runResumeExtraction({ userId: "owner", requestId: id })).toEqual({ skipped: true });
  expect(fixture.extract).toHaveBeenCalledTimes(1);
});

it("retains the complete previous snapshot on model failure and retries with a fresh request", async () => {
  const original = structuredClone(fixture.state!.profile);
  fixture.extract.mockRejectedValueOnce(new Error("Provider temporarily unavailable."));
  await expect(runResumeExtraction({ userId: "owner", requestId: original.resumeExtraction!.id })).rejects.toThrow("Provider temporarily unavailable");
  expect(fixture.state!.profile.facts).toEqual(original.facts);
  expect(fixture.state!.profile.resumeText).toBe("Old source text.");
  expect(fixture.state!.profile.resumeFileName).toBe("old.pdf");
  expect(fixture.state!.profile.resumeExtraction!.status).toBe("failed");
  await retryResumeExtraction("owner");
  const retryId = fixture.state!.profile.resumeExtraction!.id;
  expect(retryId).not.toBe(original.resumeExtraction!.id);
  expect(await runResumeExtraction({ userId: "owner", requestId: retryId })).toMatchObject({ ready: true });
});

it("does not allow an older upload to replace a newer pending upload", async () => {
  const oldId = fixture.state!.profile.resumeExtraction!.id;
  fixture.extract.mockImplementationOnce(async () => {
    fixture.state!.profile.resumeExtraction = { ...fixture.state!.profile.resumeExtraction!, id: "newer-request", status: "queued" };
    return [{ id: "old-output", text: "Stale model output.", source: "resume", verified: true }];
  });
  expect(await runResumeExtraction({ userId: "owner", requestId: oldId })).toMatchObject({ ready: false });
  expect(fixture.state!.profile.resumeExtraction!.id).toBe("newer-request");
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "old"]);
  expect(fixture.search).not.toHaveBeenCalled();
});

it("preserves manual facts entered while extraction is running", async () => {
  fixture.extract.mockImplementationOnce(async () => {
    fixture.state!.profile.facts.push({ id: "late-manual", text: "Led a separate volunteer project.", source: "user", verified: true });
    return [];
  });
  await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id });
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "late-manual"]);
});

it("keeps prior facts when the service budget prevents extraction", async () => {
  fixture.budget = false;
  expect(await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id })).toEqual({ budgetLimited: true });
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "old"]);
  expect(fixture.state!.profile.resumeExtraction!.status).toBe("budget_limited");
  expect(fixture.extract).not.toHaveBeenCalled();
});

it("migrates an existing stored resume once without clearing its active facts", async () => {
  const pending = fixture.state!.profile.resumeExtraction!.pending!;
  fixture.state!.profile.resumeSource = pending.source;
  fixture.state!.profile.resumeSourceDocument = pending.document;
  fixture.state!.profile.resumeExtraction = undefined;
  expect(await ensureResumeExtraction("owner", fixture.state!.profile)).toBe(true);
  expect(await ensureResumeExtraction("owner", fixture.state!.profile)).toBe(false);
  expect(fixture.state!.profile.facts.map(f => f.id)).toEqual(["manual", "old"]);
  expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  expect(fixture.state!.profile.resumeExtraction!.pending!.document).toBeUndefined();
});


it("continues a valid extraction when a newer upload has not passed parsing", async () => {
  const facts = await fixture.extract.getMockImplementation()!();
  fixture.extract.mockImplementationOnce(async (_source, options) => {
    fixture.state!.profile.resumeUploadSequence = 2;
    await options.beforeModelCall();
    return facts;
  });
  expect(await runResumeExtraction({ userId: "owner", requestId: fixture.state!.profile.resumeExtraction!.id })).toMatchObject({ ready: true });
  expect(fixture.state!.profile.resumeExtraction!.status).toBe("ready");
});
