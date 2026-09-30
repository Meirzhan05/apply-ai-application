import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesHash, readArtifact, saveArtifact } from "@/lib/resume-artifacts";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ storage: { from: () => mocks } }) }));
beforeEach(() => { vi.stubEnv("DEMO_MODE", "false"); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
const bytes = Buffer.from("synthetic PDF"); const inputHash = "a".repeat(64); const hash = bytesHash(bytes);
describe("immutable private resume artifacts", () => {
  it("uses owner-prefixed content-addressed objects and verifies persisted bytes", async () => {
    mocks.upload.mockResolvedValue({ error: null }); mocks.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
    const file = await saveArtifact("owner-1", inputHash, bytes, "pdf");
    expect(file.storageKey).toBe(`owner-1/${inputHash}/${hash}.pdf`);
    expect(mocks.upload.mock.calls[0][2]).toEqual({ contentType: "application/pdf", upsert: false });
  });
  it("verifies bytes on duplicate worker delivery instead of overwriting them", async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: "409" } }); mocks.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
    expect((await saveArtifact("owner-1", inputHash, bytes, "pdf")).sha256).toBe(hash);
    mocks.download.mockResolvedValue({ data: new Blob(["tampered"]), error: null });
    await expect(saveArtifact("owner-1", inputHash, bytes, "pdf")).rejects.toThrow(/file changed/);
  });
  it("rejects cross-owner keys and traversal before storage access", async () => {
    await expect(readArtifact("owner-2", `owner-1/${inputHash}/${hash}.pdf`, hash, bytes.length)).rejects.toThrow(/does not belong/);
    await expect(readArtifact("owner-1", `owner-1/../../etc/passwd`, hash, bytes.length)).rejects.toThrow(/does not belong/);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("fails when saving or retrieving an artifact fails", async () => {
    mocks.upload.mockResolvedValue({ error: { statusCode: "503" } });
    await expect(saveArtifact("owner-1", inputHash, bytes, "tex")).rejects.toThrow(/Saving/);
    mocks.download.mockResolvedValue({ data: null, error: new Error("not found") });
    await expect(readArtifact("owner-1", `owner-1/${inputHash}/${hash}.pdf`, hash, bytes.length)).rejects.toThrow(/unavailable/);
  });
});
