import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";

const mocks = vi.hoisted(() => ({ user: vi.fn(), state: vi.fn(), file: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, loadState: mocks.state }));
vi.mock("@/lib/packet-files", () => ({ historicalPacketFile: mocks.file }));

import { GET } from "@/app/api/pilot/evidence/[ownerId]/[applicationId]/[kind]/route";

beforeEach(() => {
  mocks.user.mockResolvedValue("reviewer");
  mocks.state.mockResolvedValue(initialDemoState());
  mocks.file.mockResolvedValue({ bytes: Buffer.from("archived-packet"), filename: "resume.pdf", mimeType: "application/pdf" });
  vi.stubEnv("USAGE_OPERATOR_USER_IDS", "reviewer");
});

it("keeps archived submitted materials behind the configured operator boundary", async () => {
  const state = initialDemoState();
  state.profile.id = "owner-a";
  state.applications = [{ id: "app-a", userId: "owner-a", jobId: state.jobs[0].id, jobSnapshot: state.jobs[0], status: "submitted", approvals: [], createdAt: "2026-10-01", updatedAt: "2026-10-01", submissionAttemptedAt: "2026-10-01", submissionMaterials: { resumeMode: "original", files: [{ kind: "resume", filename: "resume.pdf", mimeType: "application/pdf", sha256: "a".repeat(64), size: 15, factIds: [], storageKey: "owner-a/application/resume.pdf", storageBucket: "application-files" }], capturedAt: "2026-10-01" } }];
  mocks.state.mockResolvedValue(state);
  const response = await GET(new Request("http://localhost/api/pilot/evidence/owner-a/app-a/resume"), { params: Promise.resolve({ ownerId: "owner-a", applicationId: "app-a", kind: "resume" }) });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("archived-packet");
  mocks.user.mockResolvedValue("owner-a");
  expect((await GET(new Request("http://localhost/api/pilot/evidence/owner-a/app-a/resume"), { params: Promise.resolve({ ownerId: "owner-a", applicationId: "app-a", kind: "resume" }) })).status).toBe(404);
});
