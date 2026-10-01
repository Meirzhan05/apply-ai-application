import type { AppState, Application } from "@/lib/types";
import { transition } from "@/lib/workflow";

export function recoverStaleRuns(state: AppState, now = Date.now()): Application[] {
  const closed: Application[] = [];
  for (const app of state.applications) {
    const idle = now - new Date(app.updatedAt).getTime();
    const expired = app.browserSessionId && (app.browserSessionExpiresAt
      ? now >= new Date(app.browserSessionExpiresAt).getTime()
      : now - new Date(app.browserSessionCreatedAt || app.updatedAt).getTime() > 30 * 60 * 1000);
    if (!expired && app.browserQuestionRun && now - Date.parse(app.browserQuestionRun.startedAt) > 5 * 60 * 1000 && ["filling", "needs_user_action"].includes(app.status)) {
      app.browserQuestionRun = undefined;
      transition(app, ["filling", "needs_user_action"], "needs_user_action");
      app.approvals = app.approvals.filter((approval) => approval.kind !== "submit");
      app.error = "The agent paused while handling your answers. Your browser is saved; refresh the form before continuing.";
      continue;
    }
    if (app.status === "submitting" && idle > 10 * 60 * 1000) {
      closed.push(structuredClone(app));
      transition(app, ["submitting"], "uncertain");
      app.error = "The submit worker stopped before confirmation. Check the employer site; no automatic retry will occur.";
    } else if (["drafting", "filling"].includes(app.status) && idle > (app.status === "drafting" ? 12 : 10) * 60 * 1000) {
      closed.push(structuredClone(app));
      const previous = app.status;
      transition(app, ["drafting", "filling"], previous === "drafting" ? (app.packet ? "draft_review" : "selected") : "authorized_to_fill");
      app.runDispatch = undefined;
      app.error = "The worker stopped before review. You can request a new run.";
    } else if (expired && ["final_review", "approved_to_submit", "needs_user_action"].includes(app.status)) {
      closed.push(structuredClone(app));
      transition(app, ["final_review", "approved_to_submit", "needs_user_action"], "needs_user_action");
      app.error = "The browser session expired. Start a fresh session and review its form again.";
      app.approvals = app.approvals.filter((approval) => approval.kind !== "submit");
    } else continue;
    app.browserSessionId = app.browserConnectUrl = app.browserLiveUrl = undefined;
    app.browserQuestionRun = app.browserQuestionDrafts = undefined;
  }
  return closed;
}
