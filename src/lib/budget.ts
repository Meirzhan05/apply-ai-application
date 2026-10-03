import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo, mutateState } from "@/lib/repository";

export const serviceBudgetMonth = () => new Date().toISOString().slice(0, 7);

export const browserBudgetReservationId = (applicationId: string, attemptId: string) => `browser:${applicationId}:${attemptId}`;

export async function reserveServiceBudget(
  userId: string,
  reservationId: string,
  projectedUsd: number,
  month = serviceBudgetMonth(),
): Promise<boolean> {
  if (!Number.isFinite(projectedUsd) || projectedUsd <= 0) {
    const error = new Error("A valid projected cost is required.");
    Object.assign(error, { budgetNeverAllocated: true });
    throw error;
  }
  const ceiling = Number(process.env.MONTHLY_SPEND_LIMIT_USD || "500");
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    const error = new Error("Monthly spending limit is not configured correctly.");
    Object.assign(error, { budgetNeverAllocated: true });
    throw error;
  }
  if (isDemo())
    return mutateState(userId, (state) => {
      if (state.budgetMonth !== month) { state.budgetMonth = month; state.budgetReservations = {}; state.estimatedSpendUsd = 0; }
      state.budgetReservations ??= {};
      if (state.budgetReservations[reservationId] !== undefined) return true;
      if (state.estimatedSpendUsd + projectedUsd > ceiling) return false;
      state.estimatedSpendUsd += projectedUsd;
      state.budgetReservations[reservationId] = projectedUsd;
      return true;
    });
  const { data, error } = await adminSupabase().rpc("reserve_account_service_budget", {
    p_owner_id: userId,
    p_reservation_id: `${month}:${reservationId}`,
    p_month: month,
    p_amount: projectedUsd,
    p_limit: ceiling,
  });
  if (error) throw error;
  return data === true;
}

export const reserveBrowserBudget = (userId: string, applicationId: string, attemptId = "initial", month = serviceBudgetMonth()) =>
  reserveServiceBudget(userId, browserBudgetReservationId(applicationId, attemptId), 0.15, month);

export async function releaseServiceBudget(userId: string, reservationId: string, month = serviceBudgetMonth()): Promise<boolean> {
  if (isDemo()) {
    return mutateState(userId, (state) => {
      const held = state.budgetReservations?.[reservationId];
      if (held === undefined) return true;
      delete state.budgetReservations![reservationId];
      state.estimatedSpendUsd = Math.max(0, state.estimatedSpendUsd - held);
      return true;
    });
  }
  const { data, error } = await adminSupabase().rpc("release_service_budget", {
    p_reservation_id: `${month}:${reservationId}`,
    p_month: month,
  });
  if (error) throw error;
  return data === true;
}

export const releaseBrowserBudget = (userId: string, applicationId: string, attemptId: string, month?: string) =>
  releaseServiceBudget(userId, browserBudgetReservationId(applicationId, attemptId), month);

export interface QueuedBudgetReceipt {
  queuedId: string;
  reservationId: string;
  month: string;
  ownerId: string;
  applicationId: string;
  projectedUsd: number;
}

export async function reserveQueuedBudget(userId: string, applicationId: string, queuedId: string, projectedUsd: number): Promise<QueuedBudgetReceipt | null> {
  const month = serviceBudgetMonth();
  if (!Number.isFinite(projectedUsd) || projectedUsd <= 0) throw new Error("A valid projected cost is required.");
  const ceiling = Number(process.env.MONTHLY_SPEND_LIMIT_USD || "500");
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error("Monthly spending limit is not configured correctly.");
  if (isDemo()) {
    if (!await reserveServiceBudget(userId, `queued:${queuedId}`, projectedUsd)) return null;
    return { queuedId, reservationId: `queued:${queuedId}`, month, ownerId: userId, applicationId, projectedUsd };
  }
  const { data, error } = await adminSupabase().rpc("reserve_queued_service_budget", {
    p_queued_id: queuedId, p_owner_id: userId, p_application_id: applicationId, p_month: month, p_amount: projectedUsd, p_limit: ceiling,
  });
  if (error) throw error;
  if (!data) return null;
  return data as QueuedBudgetReceipt;
}

export async function markQueuedBudgetClaimed(receipt: QueuedBudgetReceipt): Promise<boolean> {
  if (isDemo()) return true;
  const { data, error } = await adminSupabase().rpc("claim_queued_service_budget", { p_queued_id: receipt.queuedId, p_owner_id: receipt.ownerId, p_application_id: receipt.applicationId });
  if (error) throw error;
  return data === true;
}

export async function markQueuedBudgetTerminal(receipt: QueuedBudgetReceipt): Promise<boolean> {
  if (isDemo()) return true;
  const { data, error } = await adminSupabase().rpc("mark_queued_service_budget_terminal", { p_queued_id: receipt.queuedId, p_owner_id: receipt.ownerId, p_application_id: receipt.applicationId, p_month: receipt.month });
  if (error) throw error;
  return data === true;
}

export async function releaseQueuedBudget(receipt: QueuedBudgetReceipt): Promise<boolean> {
  if (!receipt.reservationId.startsWith("queued:") || receipt.reservationId !== `queued:${receipt.queuedId}`) throw new Error("A matching queued reservation proof is required.");
  if (isDemo()) {
    return mutateState(receipt.ownerId, (state) => {
      const held = state.budgetReservations?.[receipt.reservationId];
      if (held === undefined) return true;
      delete state.budgetReservations![receipt.reservationId];
      state.estimatedSpendUsd = Math.max(0, state.estimatedSpendUsd - held);
      return true;
    });
  }
  const { data, error } = await adminSupabase().rpc("release_queued_service_budget", { p_queued_id: receipt.queuedId, p_owner_id: receipt.ownerId, p_application_id: receipt.applicationId, p_month: receipt.month, p_terminal_token: receipt.queuedId });
  if (error) throw error;
  return data === true;
}
