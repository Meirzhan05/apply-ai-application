import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ rpc: mocks.rpc }) }));

import { AccountDeletionInProgressError, acquireAccountOperation, beginAccountDeletion, withAccountOperation } from "@/lib/account-lifecycle";

beforeEach(() => vi.clearAllMocks());

describe("account operation leases", () => {
  it("admits an owner-scoped lease and always releases it after the operation", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: true, error: null });
    await expect(withAccountOperation("owner-a", "upload", async () => "done", "upload-1")).resolves.toBe("done");
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "acquire_account_operation", expect.objectContaining({
      p_owner_id: "owner-a", p_operation: "upload", p_reference: "upload-1",
    }));
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, "release_account_operation", expect.objectContaining({ p_lease_id: expect.any(String) }));
  });

  it("rejects a lease when deletion has fenced new operations", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(acquireAccountOperation("owner-a", "dispatch")).rejects.toBeInstanceOf(AccountDeletionInProgressError);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("can begin a durable deletion lock through the service-only RPC", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await expect(beginAccountDeletion("owner-a")).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("begin_account_deletion", { p_owner_id: "owner-a" });
  });
});
