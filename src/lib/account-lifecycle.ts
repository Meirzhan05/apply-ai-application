import { randomUUID } from "node:crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";

export type AccountOperation = "request" | "upload" | "dispatch" | "worker" | "maintenance" | "email";

export class AccountDeletionInProgressError extends Error {
  constructor(message = "Account deletion is in progress. Finish or retry the deletion before starting more work.") {
    super(message);
    this.name = "AccountDeletionInProgressError";
  }
}

export interface AccountOperationLease {
  leaseId: string;
  ownerId: string;
  operation: AccountOperation;
  reference?: string;
  acquiredAt?: string;
}

export async function acquireAccountOperation(
  ownerId: string,
  operation: AccountOperation,
  reference?: string,
): Promise<string | undefined> {
  if (isDemo()) return undefined;
  const leaseId = randomUUID();
  const { data, error } = await adminSupabase().rpc("acquire_account_operation", {
    p_owner_id: ownerId,
    p_lease_id: leaseId,
    p_operation: operation,
    p_reference: reference ?? null,
  });
  if (error) {
    if (error.message.includes("ACCOUNT_DELETION_IN_PROGRESS")) throw new AccountDeletionInProgressError();
    throw new Error("The account work lock could not be checked. Try again.");
  }
  if (data !== true) throw new AccountDeletionInProgressError();
  return leaseId;
}

export async function releaseAccountOperation(leaseId: string | undefined): Promise<void> {
  if (!leaseId) return;
  const { data, error } = await adminSupabase().rpc("release_account_operation", { p_lease_id: leaseId });
  if (error || data !== true) throw new Error("The account work lock could not be released. Account deletion will remain blocked until this work is reconciled.");
}

export async function withAccountOperation<T>(
  ownerId: string,
  operation: AccountOperation,
  callback: () => Promise<T>,
  reference?: string,
): Promise<T> {
  const leaseId = await acquireAccountOperation(ownerId, operation, reference);
  let callbackError: unknown;
  try {
    return await callback();
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await releaseAccountOperation(leaseId);
    } catch (releaseError) {
      if (callbackError instanceof Error && releaseError instanceof Error) {
        Object.assign(callbackError, { leaseReleaseError: releaseError.message });
      } else {
        throw releaseError;
      }
    }
  }
}

export async function beginAccountDeletion(ownerId: string): Promise<void> {
  const { data, error } = await adminSupabase().rpc("begin_account_deletion", { p_owner_id: ownerId });
  if (error) throw new Error("The account could not be locked for deletion. No account data was removed.");
  if (data !== true) throw new Error("This account is no longer available.");
}

export async function accountOperationLeases(ownerId: string): Promise<AccountOperationLease[]> {
  const { data, error } = await adminSupabase()
    .from("account_operation_leases")
    .select("lease_id,owner_id,operation,reference,acquired_at")
    .eq("owner_id", ownerId)
    .order("acquired_at", { ascending: true });
  if (error) throw new Error("Active account work could not be checked. No account data was removed.");
  return (data ?? []).map((row) => ({
    leaseId: row.lease_id,
    ownerId: row.owner_id,
    operation: row.operation as AccountOperation,
    reference: row.reference ?? undefined,
    acquiredAt: row.acquired_at,
  }));
}
