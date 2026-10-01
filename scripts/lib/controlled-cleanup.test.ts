import { describe, expect, it, vi } from "vitest";
import { cleanupControlledOwner } from "./controlled-cleanup";

function fixture() {
  const objects = new Map([["application-files:owner/packet", [{ name: "orphan.pdf", id: "file" }]], ["application-files:owner", [{ name: "packet", id: null }]]]);
  return {
    sessions: [{ provider: "browser-use" as const, sessionId: "session", runId: "run" }], workerInFlight: false, allocationUnknown: false,
    stopAndConfirm: vi.fn(async () => undefined),
    list: vi.fn(async (bucket: string, prefix: string) => objects.get(`${bucket}:${prefix}`) ?? []),
    remove: vi.fn(async (bucket: string, keys: string[]) => { for (const key of keys) objects.set(`${bucket}:${key.substring(0, key.lastIndexOf("/"))}`, []); }),
    deleteOwner: vi.fn(async () => undefined),
  };
}
describe("controlled synthetic cleanup", () => {
  it("stops the provider, removes owner-prefix orphan artifacts, then deletes the owner", async () => {
    const deps = fixture(); await cleanupControlledOwner("owner", deps);
    expect(deps.remove).toHaveBeenCalledWith("application-files", ["owner/packet/orphan.pdf"]);
    expect(deps.stopAndConfirm.mock.invocationCallOrder[0]).toBeLessThan(deps.remove.mock.invocationCallOrder[0]);
    expect(deps.remove.mock.invocationCallOrder[0]).toBeLessThan(deps.deleteOwner.mock.invocationCallOrder[0]);
  });
  it.each(["provider_release", "storage_list", "storage_remove", "owner_delete", "worker_in_flight", "allocation_unknown"] as const)("surfaces %s and preserves measurable evidence", async (reason) => {
    const deps = fixture();
    if (reason === "provider_release") deps.stopAndConfirm.mockRejectedValue(new Error("private provider error"));
    if (reason === "storage_list") deps.list.mockRejectedValue(new Error("private storage error"));
    if (reason === "storage_remove") deps.remove.mockRejectedValue(new Error("private storage error"));
    if (reason === "owner_delete") deps.deleteOwner.mockRejectedValue(new Error("private auth error"));
    if (reason === "worker_in_flight") deps.workerInFlight = true;
    if (reason === "allocation_unknown") deps.allocationUnknown = true;
    await expect(cleanupControlledOwner("owner", deps)).rejects.toThrow(reason);
    if (reason !== "owner_delete") expect(deps.deleteOwner).not.toHaveBeenCalled();
    if (["provider_release", "worker_in_flight", "allocation_unknown"].includes(reason)) expect(deps.remove).not.toHaveBeenCalled();
  });
  it("retains the owner if a storage removal silently leaves an orphan", async () => {
    const deps = fixture(); deps.remove.mockImplementation(async () => undefined);
    await expect(cleanupControlledOwner("owner", deps)).rejects.toThrow("storage_remove"); expect(deps.deleteOwner).not.toHaveBeenCalled();
  });
});
