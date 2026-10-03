import type { Application } from "@/lib/types";
import { canReopenManualAttempt } from "@/lib/form-review";
import { transition } from "@/lib/workflow";

export function reopenManualAttempt(app: Application, userId: string, confirmedNotAccepted: boolean): void {
  if (app.autonomousAuthorization) throw new Error("An automatic application keeps its original attempt. Check the existing result without resubmitting.");
  if (app.userId !== userId) throw new Error("This application belongs to another user.");
  if (confirmedNotAccepted !== true) throw new Error("Confirm that this attempt did not submit an application before reopening it.");
  if (!canReopenManualAttempt(app)) throw new Error("This submission requires outcome review before another attempt.");
  app.manualSubmissionReport!.resolution = {
    outcome: "not_accepted",
    reviewedAt: new Date().toISOString(),
    previousForm: app.form ? structuredClone(app.form) : undefined,
    previousApprovals: structuredClone(app.approvals),
  };
  app.approvals = [];
  app.form = undefined;
  app.browserSessionId = app.browserConnectUrl = app.browserLiveUrl = undefined;
  app.browserSessionCreatedAt = undefined;
  app.runToken = app.runWorkerClaimedAt = undefined;
  app.runDispatch = undefined;
  app.confirmation = app.error = undefined;
  transition(app, ["uncertain"], "draft_review");
}
