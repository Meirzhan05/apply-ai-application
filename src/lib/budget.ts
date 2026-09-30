import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo, mutateState } from "@/lib/repository";

export async function reserveServiceBudget(
  userId: string,
  reservationId: string,
  projectedUsd: number,
): Promise<boolean> {
  if (!Number.isFinite(projectedUsd) || projectedUsd <= 0) throw new Error("A valid projected cost is required.");
  const ceiling = Number(process.env.MONTHLY_SPEND_LIMIT_USD || "500");
  if (!Number.isFinite(ceiling) || ceiling <= 0)
    throw new Error("Monthly spending limit is not configured correctly.");
  const month = new Date().toISOString().slice(0, 7);
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
  const { data, error } = await adminSupabase().rpc("reserve_service_budget", {
    p_reservation_id: `${month}:${reservationId}`,
    p_month: month,
    p_amount: projectedUsd,
    p_limit: ceiling,
  });
  if (error) throw error;
  return data === true;
}

export const reserveBrowserBudget = (userId: string, applicationId: string) =>
  reserveServiceBudget(userId, `browser:${applicationId}`, 0.15);
