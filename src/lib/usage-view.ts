import { loadState } from "@/lib/repository";
import { readModelUsage, type ModelUsageReport } from "@/lib/model-usage";
import type { ApplicationStatus } from "@/lib/types";

export interface UsageView extends ModelUsageReport {
  records: Array<ModelUsageReport["records"][number] & { applicationStatus: ApplicationStatus | null; applicationTitle: string | null }>;
  projectedReservations: Array<{ applicationId: string; runId: string; kind: string; projectedUsd: number }>;
}
export async function ownerUsageView(userId: string): Promise<UsageView> {
  const [report, state] = await Promise.all([readModelUsage(userId), loadState(userId)]);
  return { ...report, records: report.records.map((record) => {
    const application = state.applications.find((item) => item.id === record.applicationId && item.userId === userId);
    return { ...record, applicationStatus: application?.status ?? null,
      applicationTitle: application?.jobSnapshot?.title ?? null };
  }), projectedReservations: state.applications.filter((app) => app.userId === userId).flatMap((app) => (app.runs ?? []).map((run) => ({ applicationId: app.id, runId: run.token, kind: run.kind, projectedUsd: run.projectedUsd }))) };
}
