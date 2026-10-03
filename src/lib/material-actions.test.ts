import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { AppState, ScreeningAnswer } from "@/lib/types";
const fixture = vi.hoisted(() => ({ state: null as AppState | null, inMutation: false, race: false, savedOutside: [] as boolean[] }));
vi.mock("@/lib/repository", () => ({ isDemo: () => true, currentUserId: async () => fixture.state!.profile.id, loadState: async () => structuredClone(fixture.state), mutateState: async (_user: string, change: (state: AppState) => unknown) => { fixture.inMutation = true; try { return await change(fixture.state!); } finally { fixture.inMutation = false; } } }));
vi.mock("@/lib/browser-runner", () => ({ cancelBrowser: async () => undefined, refreshBrowserSnapshot: vi.fn(), repairEducationFields: vi.fn() }));
vi.mock("@/lib/resume-artifacts", () => ({ bytesHash: (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"), saveArtifact: async (owner: string, inputHash: string, bytes: Buffer, extension: string) => { fixture.savedOutside.push(!fixture.inMutation); if (fixture.race) { fixture.state!.profile.name = "Changed during archival"; fixture.race = false; } const sha256 = createHash("sha256").update(bytes).digest("hex"); return { storageKey: `${owner}/${inputHash}/${sha256}.${extension}`, sha256, size: bytes.length }; }, readArtifact: vi.fn() }));
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication, setPacket } from "@/lib/workflow";
import { packetProfileHash } from "@/lib/drafting";
import { essayContentHash, essayEvidenceHash } from "@/lib/answer-policy";
import { POST } from "@/app/api/actions/route";
const action = (name: string, payload: Record<string, unknown>) => POST(new Request("https://apply.example/api/actions", { method: "POST", headers: { Origin: "https://apply.example", "Content-Type": "application/json" }, body: JSON.stringify({ action: name, payload }) }));
beforeEach(() => {
  fixture.state = initialDemoState(); fixture.state.applications = []; fixture.savedOutside = []; fixture.inMutation = false; fixture.race = false;
  const state = fixture.state; const fact = state.profile.facts.find((item) => item.verified)!;
  const answer: ScreeningAnswer = { question: "Why are you excited to join us?", answer: fact.text, factIds: [fact.id], requiresUserInput: true, author: "ai", aiDraft: { version: 1, model: "fixture", sentences: [{ text: fact.text, kind: "fact", factIds: [fact.id] }], evidenceHash: essayEvidenceHash(state.profile, [fact.id]), contentHash: "" } };
  answer.aiDraft!.contentHash = essayContentHash(answer);
  const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  setPacket(state, app, { schemaVersion: 1, files: [{ kind: "resume", filename: "tailored-resume.pdf", mimeType: "application/pdf", sha256: "0".repeat(64), size: 1, factIds: [fact.id] }], version: 1, model: "fixture", summary: "fixture", createdAt: new Date().toISOString(), resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [answer], profileHash: packetProfileHash(state.profile) });
});
function payload(name: string) {
  const app = fixture.state!.applications[0];
  if (name === "addCoverLetter") { app.status = "needs_user_action"; app.needsCoverLetter = true; }
  return { applicationId: app.id, packetHash: app.packetHash, answerIndex: 0, answerHash: app.packet!.answers[0].aiDraft!.contentHash, answers: app.packet!.answers, text: "I want to bring my survey analysis experience to this role." };
}
it.each(["editPacket", "confirmEssay", "reviseEssay", "addCoverLetter"])("archives legacy %s material outside atomic state updates", async (name) => {
  const response = await action(name, payload(name));
  expect(response.status).toBe(200); expect(fixture.savedOutside.length).toBeGreaterThan(0); expect(fixture.savedOutside.every(Boolean)).toBe(true);
  const app = fixture.state!.applications[0]; expect(app.status).toBe("draft_review"); expect(app.packet?.version).toBe(2); expect(app.approvals).toEqual([]); expect(app.packet?.files?.every((file) => file.storageKey)).toBe(true);
});
it.each(["editPacket", "confirmEssay", "reviseEssay", "addCoverLetter"])("does not overwrite a changed profile while archiving %s", async (name) => {
  const input = payload(name); const before = structuredClone(fixture.state!.applications[0]); fixture.race = true;
  expect((await action(name, input)).status).toBe(400); expect(fixture.state!.applications[0]).toEqual(before);
});

it("rejects stale essay saves and confirmations and stores revised wording without promoting it to source facts", async () => {
  const input = payload("reviseEssay");
  const facts = structuredClone(fixture.state!.profile.facts);
  expect((await action("reviseEssay", { ...input, answerHash: "stale" })).status).toBe(400);
  expect((await action("reviseEssay", input)).status).toBe(200);
  const app = fixture.state!.applications[0];
  const answer = app.packet!.answers[0];
  expect(answer).toMatchObject({ author: "human", userProvided: true, factIds: [], requiresUserInput: true });
  expect(answer.confirmedAt).toBeUndefined();
  expect((await action("confirmEssay", input)).status).toBe(400);
  expect((await action("confirmEssay", { ...input, packetHash: app.packetHash, answerHash: answer.userRevision!.contentHash })).status).toBe(200);
  expect(app.packet!.answers[0].confirmedAt).toBeTruthy();
  expect(app.approvals).toEqual([]);
  expect(fixture.state!.profile.facts).toEqual(facts);
});
