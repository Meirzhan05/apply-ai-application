import type { ApplicationStatus } from "@/lib/types";

export const applicationStages = ["Materials", "Employer form", "Completed attempts"] as const;
export type ApplicationStage = typeof applicationStages[number];

export function applicationStage(status: ApplicationStatus): ApplicationStage {
  if (["selected", "drafting", "draft_review"].includes(status)) return "Materials";
  if (["submitted", "cancelled"].includes(status)) return "Completed attempts";
  return "Employer form";
}
