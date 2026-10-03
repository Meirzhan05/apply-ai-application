import type { Application } from "@/lib/types";

export function canReturnToMaterials(application: Application) {
  return !application.autonomousAuthorization &&
    ["authorized_to_fill", "needs_user_action", "final_review", "approved_to_submit"].includes(application.status) &&
    !application.queuedRun && !application.browserQuestionRun &&
    !application.submissionStartedAt && !application.submissionAttemptedAt &&
    !application.submissionDispatch && !application.submissionReceipt && !application.submittedAt &&
    !application.manualSubmissionReport;
}

export function returnToMaterials(application: Application) {
  if (!canReturnToMaterials(application)) throw new Error("This attempt cannot return to materials review while work or submission is in progress. Refresh and review its current status.");
  application.status = "draft_review";
  application.approvals = [];
  application.form = undefined;
  application.browserQuestionDrafts = undefined;
  application.browserAnswerApprovals = undefined;
  application.browserSessionId = application.browserConnectUrl = application.browserLiveUrl = undefined;
  application.error = undefined;
  application.updatedAt = new Date().toISOString();
}
