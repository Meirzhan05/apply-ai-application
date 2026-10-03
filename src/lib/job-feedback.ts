import type { AppState } from "@/lib/types";

export function updateJobFeedback(state: AppState, change: {
  jobId: string;
  kind: "saved" | "dismissed" | "clear";
  reason?: string;
}) {
  const job = state.jobs.find(job => job.id === change.jobId);
  if (!job) throw new Error("Job not found.");
  const previous = state.feedback.find(item => item.jobId === job.id);
  state.feedback = state.feedback.filter(item => item.jobId !== job.id);
  if (change.kind !== "clear") state.feedback.push({
    jobId: job.id, kind: change.kind, reason: change.reason,
    updatedAt: new Date().toISOString(),
    jobSnapshot: { title: job.title, requirements: [...job.requirements], location: job.location },
  });
  return {
    title: job.title,
    label: change.kind === "saved" ? "Job saved" : change.kind === "dismissed" ? "Job dismissed" :
      previous?.kind === "dismissed" ? "Role restored" : previous?.kind === "saved" ? "Removed from saved" : "Feedback cleared",
  };
}
