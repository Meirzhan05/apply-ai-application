import { Check } from "lucide-react";
import type { ApplicationStatus } from "@/lib/types";

const stages = ["Role chosen", "Review materials", "Fill form", "Review form", "Submit"];
const stageIndex: Record<ApplicationStatus, number> = {
  selected: 1, drafting: 1, draft_review: 1, authorized_to_fill: 2, filling: 2,
  needs_user_action: 2, final_review: 3, approved_to_submit: 4, submitting: 4,
  awaiting_verification: 4, submitted: 4, uncertain: 4, cancelled: 0,
};
const currentLabels: Partial<Record<ApplicationStatus, string>> = {
  selected: "Prepare materials",
  drafting: "Preparing materials", needs_user_action: "Your input needed", approved_to_submit: "Ready to submit",
  submitting: "Submitting", awaiting_verification: "Finish verification", submitted: "Submission confirmed",
  uncertain: "Check submission result",
};

export function ApplicationProgress({ status }: { status: ApplicationStatus }) {
  const current = stageIndex[status];
  const timeline = <ol className="progress" aria-label="Application stages">
    {stages.map((label, index) => <li key={label} aria-current={status !== "cancelled" && index === current ? "step" : undefined}
      className={status === "cancelled" ? "" : index < current ? "done" : index === current ? "current" : ""}>
      <span className="progress-marker" aria-hidden="true">{status !== "cancelled" && index < current ? <Check size={14} /> : index + 1}</span>
      <span>{label}</span>
    </li>)}
  </ol>;
  return <div className="application-progress">
    <div className="progress-desktop">{timeline}</div>
    <details className="progress-mobile">
      <summary>{status === "cancelled" ? "Application cancelled" : `Step ${current + 1} of ${stages.length} · ${currentLabels[status] ?? stages[current]}`}</summary>
      {timeline}
    </details>
  </div>;
}
