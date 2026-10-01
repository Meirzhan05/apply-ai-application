import { newId } from "@/lib/crypto";
import { mutateState } from "@/lib/repository";
import { authorizeKnownAnswerApplication, autonomyProfileHash } from "@/lib/autonomous-policy";
import { transition } from "@/lib/workflow";
import type {
  AppState,
  Application,
  ApplicationBlocker,
  ApplicationBlockerReason,
  AutonomousHumanAnswer,
} from "@/lib/types";

const now = () => new Date().toISOString();

export function blockerReason(message: string): ApplicationBlockerReason {
  const value = message.toLowerCase();
  if (/cover letter|resume|résumé|material|unsupported/.test(value)) return "disabled_material";
  if (/login|sign[ -]?in|password|credential/.test(value)) return "login";
  if (/captcha|verification|verify|two[- ]factor|2fa/.test(value)) return "verification";
  if (/upload|attachment|file|mime|pdf|document/.test(value)) return "upload_failure";
  if (/redirect|navigation|destination|origin|url/.test(value)) return "navigation";
  if (/missing|required|answer|fact|question|availability|graduation|authorization|correct or complete|choose an exact option|select and confirm/.test(value)) return "missing_answer";
  if (/control|button|select|checkbox|form/.test(value)) return "unfamiliar_control";
  return "other";
}

export function activeApplicationBlockers(application: Application): ApplicationBlocker[] {
  return (application.blockers ?? []).filter((blocker) => blocker.progress === "blocked" || blocker.progress === "resuming" || (blocker.reviewOnly && blocker.progress === "expired"));
}

export function resolveResumingApplicationBlockers(application: Application): void {
  const timestamp = now();
  for (const blocker of application.blockers ?? []) {
    if (blocker.progress === "resuming") {
      blocker.progress = "resolved";
      blocker.resolvedAt = timestamp;
      blocker.updatedAt = timestamp;
    }
  }
}

export function resolveResourceHold(application: Application): void {
  const timestamp = now();
  for (const blocker of application.blockers ?? []) {
    if (blocker.reason === "resource_hold" && (blocker.progress === "blocked" || blocker.progress === "resuming")) {
      blocker.progress = "resolved";
      blocker.resolvedAt = timestamp;
      blocker.updatedAt = timestamp;
    }
  }
}

export function recordReviewOnlyBlocker(application: Application, reason: ApplicationBlockerReason, message: string, context?: ApplicationBlocker["context"]): ApplicationBlocker {
  const blocker = recordApplicationBlocker(application, reason, message, context);
  blocker.progress = "expired";
  blocker.reviewOnly = true;
  blocker.updatedAt = now();
  return blocker;
}

export function recordApplicationBlocker(
  application: Application,
  reason: ApplicationBlockerReason | string,
  message: string,
  context?: ApplicationBlocker["context"],
): ApplicationBlocker {
  const knownReasons = new Set<ApplicationBlockerReason>([
    "missing_answer", "login", "verification", "disabled_material",
    "unfamiliar_control", "upload_failure", "navigation", "other",
    "resource_hold",
  ]);
  const resolvedReason = (knownReasons.has(reason as ApplicationBlockerReason) ? reason : blockerReason(message)) as ApplicationBlockerReason;
  const timestamp = now();
  application.blockers ??= [];
  const existing = application.blockers.find((item) => item.reason === resolvedReason && item.progress !== "expired");
  if (existing) {
    existing.message = message;
    existing.progress = "blocked";
    existing.updatedAt = timestamp;
    existing.context = context ?? existing.context;
    application.error = message;
    return existing;
  }
  const blocker: ApplicationBlocker = {
    id: newId(), applicationId: application.id, userId: application.userId,
    reason: resolvedReason, message, progress: "blocked", createdAt: timestamp, updatedAt: timestamp, context,
  };
  application.blockers.unshift(blocker);
  application.error = message;
  return blocker;
}

export function expireApplicationBlocker(application: Application, message: string): ApplicationBlocker {
  const blocker = recordApplicationBlocker(application, "other", message);
  blocker.progress = "blocked";
  blocker.updatedAt = now();
  return blocker;
}

function findOwnedBlocker(state: AppState, userId: string, applicationId: string, blockerId: string): { application: Application; blocker: ApplicationBlocker } {
  const application = state.applications.find((item) => item.id === applicationId && item.userId === userId);
  if (!application) throw new Error("Application not found.");
  const blocker = application.blockers?.find((item) => item.id === blockerId && item.userId === userId);
  if (!blocker) throw new Error("Blocker not found.");
  return { application, blocker };
}

export type AutonomousHumanAnswerInput = Pick<AutonomousHumanAnswer, "question" | "value">;
export interface ResumeBlockedOptions { freshReconstruct?: boolean }

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const credentialLabel = /password|passcode|one[- ]time|otp|token|secret|credit\s*card|payment|bank|routing|ssn|social\s+security|cvv/i;

/** Validate an explicit owner answer against the exact control the browser observed. */
export function validateAutonomousHumanAnswer(
  application: Application,
  blocker: ApplicationBlocker,
  profile: AppState["profile"],
  answer: AutonomousHumanAnswerInput,
): AutonomousHumanAnswer {
  const observed = blocker.context?.observedQuestion;
  const form = application.form;
  if (!observed || !form || !blocker.context?.formHash || form.hash !== blocker.context.formHash)
    throw new Error("This form question is stale. Refresh the application before answering it.");
  if (!blocker.context.targetUrl || form.url !== blocker.context.targetUrl)
    throw new Error("The application destination changed. Refresh the application before answering it.");
  if (application.autonomousAuthorization?.profileHash !== autonomyProfileHash(profile))
    throw new Error("Your automation settings changed. Refresh this application before answering it.");
  if (answer.question.identifier !== observed.identifier || answer.question.kind !== observed.kind ||
      answer.question.label !== observed.label || !sameArray(answer.question.options, observed.options))
    throw new Error("The employer changed this question. Refresh the application before answering it.");
  if (!answer.value.trim() || answer.value.length > 500)
    throw new Error("Enter a confirmed answer before resuming this application.");
  if (["password", "file", "checkbox", "textarea"].includes(observed.kind) || credentialLabel.test(observed.label))
    throw new Error("This control requires browser takeover and cannot be answered by the automatic workflow.");
  if (["select", "radio"].includes(observed.kind) && !observed.options.includes(answer.value))
    throw new Error("Choose one of the employer's current options before resuming.");
  const fields = form.fields.filter((item) => item.identifier === observed.identifier && item.kind === observed.kind && item.label === observed.label);
  const currentOptions = observed.kind === "radio" ? fields.map((field) => field.value) : fields.length === 1 ? fields[0].options ?? [] : [];
  if (!fields.length || !sameArray(currentOptions, observed.options))
    throw new Error("The employer changed this question. Refresh the application before answering it.");
  return {
    version: 1,
    userId: profile.id,
    applicationId: application.id,
    targetUrl: form.url,
    profileHash: autonomyProfileHash(profile),
    formHash: form.hash,
    question: { identifier: observed.identifier, kind: observed.kind, label: observed.label, options: [...observed.options] },
    value: answer.value,
    confirmedAt: now(),
  };
}

/** Resolve one autonomous blocker and enqueue a fresh pre-submit browser run. */
export async function resumeBlockedApplication(userId: string, applicationId: string, blockerId: string, answer?: AutonomousHumanAnswerInput, options: ResumeBlockedOptions = {}): Promise<void> {
  const accepted = await mutateState(userId, (state) => {
    const { application, blocker } = findOwnedBlocker(state, userId, applicationId, blockerId);
    if (application.status === "cancelled") throw new Error("A cancelled application cannot be resumed.");
    if (!application.autonomousAuthorization) throw new Error("Only autonomous applications have resumable blockers.");
    if (blocker.reviewOnly) throw new Error("This submission outcome is terminal and can only be reviewed; it cannot be resumed.");
    if (application.browserReleasePending || application.browserSessionId)
      throw new Error("The previous browser session is still attached. Resume will be available after it is confirmed stopped and released.");
    if (blocker.progress === "resuming") return false;
    if (blocker.progress !== "blocked") throw new Error("This blocker is already resolved or expired.");
    if (!options.freshReconstruct && blocker.context?.formHash && application.form?.hash !== blocker.context.formHash)
      throw new Error("This form question is stale. Refresh the application before resuming it.");
    if (!options.freshReconstruct && blocker.context?.targetUrl && application.form?.url !== blocker.context.targetUrl)
      throw new Error("The application destination changed. Refresh the application before resuming it.");
    const job = state.jobs.find((item) => item.id === application.jobId) ?? application.jobSnapshot;
    if (!job) throw new Error("Job not found.");
    const confirmedAnswer = answer ? validateAutonomousHumanAnswer(application, blocker, state.profile, answer) : undefined;
    if (blocker.context?.observedQuestion && !confirmedAnswer && !options.freshReconstruct)
      throw new Error("Confirm the observed question before resuming this application.");
    // A user may have answered a missing fact or changed a setting since the
    // blocker was recorded. Rebuild the packet and its bindings from the
    // current enabled authorization; the application identity is preserved.
    authorizeKnownAnswerApplication(application, state.profile, job);
    if (confirmedAnswer) {
      application.autonomousHumanAnswers = (application.autonomousHumanAnswers ?? []).filter((item) =>
        !(item.question.identifier === confirmedAnswer.question.identifier && item.targetUrl === confirmedAnswer.targetUrl));
      application.autonomousHumanAnswers.push(confirmedAnswer);
    }
    if (options.freshReconstruct) application.autonomousHumanAnswers = undefined;
    application.packet = undefined;
    application.packetHash = undefined;
    application.approvals = [];
    blocker.progress = "resuming";
    blocker.updatedAt = now();
    // The old snapshot may have been the cause of the blocker. A new run
    // reconstructs the form against current settings and authorization.
    application.form = undefined;
    application.browserSessionId = application.browserConnectUrl = application.browserLiveUrl = undefined;
    application.browserSessionExpiresAt = undefined;
    if (application.status === "needs_user_action") transition(application, ["needs_user_action"], "selected");
    application.queuedRun = { id: newId(), kind: "draft", requestedAt: now(), reason: "waiting" };
    state.activity.unshift({ id: newId(), at: now(), label: "Blocker resolved", detail: `Resuming ${application.jobSnapshot?.title ?? "application"} with current settings.` });
    return true;
  });
  if (!accepted) return;
  const { dispatchUserQueue } = await import("@/lib/application-queue");
  await dispatchUserQueue(userId);
}

export function blockersForReview(state: AppState): ApplicationBlocker[] {
  return state.applications.flatMap((application) => activeApplicationBlockers(application).filter((blocker) => blocker.userId === state.profile.id));
}

export function recordAutonomousBlocker(
  userId: string,
  applicationId: string,
  message: string,
  context?: ApplicationBlocker["context"],
): Promise<ApplicationBlocker | undefined> {
  return mutateState(userId, (state) => {
    const application = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!application || !application.autonomousAuthorization) return undefined;
    return recordApplicationBlocker(application, blockerReason(message), message, context);
  });
}
