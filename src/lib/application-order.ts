import { applicationStage, applicationStages } from "./application-stage";
import type { Application } from "./types";
export type ApplicationOrder = "stage" | "recent";

export function compareApplications(a: Pick<Application, "status" | "updatedAt">, b: Pick<Application, "status" | "updatedAt">, order: ApplicationOrder): number {
  const stage = applicationStages.indexOf(applicationStage(a.status)) - applicationStages.indexOf(applicationStage(b.status));
  return stage || (order === "recent" ? (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) : 0);
}
