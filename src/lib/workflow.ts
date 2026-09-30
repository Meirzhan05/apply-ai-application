import { hashJson, newId } from "@/lib/crypto";
import { answerNeedsAction } from "@/lib/answer-responsibility";
import { validatePacket } from "@/lib/drafting";
import { explicitConflict } from "@/lib/matching";
import { canonicalJobUrl } from "@/lib/sources";
import type {
  AppState,
  Application,
  ApplicationPacket,
  Approval,
  ApplicationStatus,
  FormSnapshot,
} from "@/lib/types";

export function transition(
  application: Application,
  from: ApplicationStatus[],
  to: ApplicationStatus,
): void {
  if (!from.includes(application.status))
    throw new Error(`Cannot move from ${application.status} to ${to}.`);
  application.transitionHistory ??= [];
  application.transitionHistory.push({ from: application.status, to, at: new Date().toISOString() });
  application.status = to;
  application.updatedAt = new Date().toISOString();
}

export function dailyRunCount(
  state: AppState,
  userId: string,
  now = new Date(),
): number {
  const dayKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: state.profile.timeZone || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const day = dayKey(now);
  return state.applications.filter(
    (application) =>
      application.userId === userId &&
      dayKey(new Date(application.createdAt)) === day,
  ).length;
}

export function selectApplication(
  state: AppState,
  jobId: string,
  userId: string,
): Application {
  const job = state.jobs.find((item) => item.id === jobId && item.active);
  if (!job) throw new Error("This job is no longer available.");
  const conflict = explicitConflict(state.profile, job);
  if (conflict) throw new Error(conflict);
  if (
    state.applications.some(
      (application) =>
        application.userId === userId &&
        (application.jobId === jobId || (application.jobSnapshot && canonicalJobUrl(application.jobSnapshot.url) === canonicalJobUrl(job.url))) &&
        application.status !== "cancelled",
    )
  ) {
    throw new Error("An application for this job already exists.");
  }
  if (dailyRunCount(state, userId) >= 3)
    throw new Error("You have reached today's limit of three applications.");
  const now = new Date().toISOString();
  const application: Application = {
    id: newId(),
    userId,
    jobId,
    jobSnapshot: job,
    status: "selected",
    approvals: [],
    createdAt: now,
    updatedAt: now,
  };
  state.applications.unshift(application);
  return application;
}

export function setPacket(
  state: AppState,
  application: Application,
  packet: ApplicationPacket,
): void {
  validatePacket(state.profile, packet);
  transition(
    application,
    ["selected", "drafting", "draft_review"],
    "draft_review",
  );
  application.packet = packet;
  application.packetHash = hashJson(packet);
  application.approvals = [];
  application.form = undefined;
}

export function approveFill(
  application: Application,
  userId: string,
  packetHash: string,
  targetUrl: string,
): void {
  if (application.userId !== userId)
    throw new Error("This application belongs to another user.");
  if (
    application.status !== "draft_review" ||
    application.queuedRun ||
    !application.packet ||
    !application.packetHash ||
    application.packetHash !== packetHash
  ) {
    throw new Error(
      "Review the current application packet before approving it.",
    );
  }
  if (application.packet.answers.some(answerNeedsAction))
    throw new Error("Complete human answers and confirm every AI essay before approving the packet.");
  application.approvals.push({
    version: 1,
    id: newId(),
    kind: "fill",
    userId,
    applicationId: application.id,
    targetUrl,
    reviewHash: packetHash,
    createdAt: new Date().toISOString(),
  });
  transition(application, ["draft_review"], "authorized_to_fill");
}

export function setFormSnapshot(
  application: Application,
  form: Omit<FormSnapshot, "hash">,
): void {
  transition(
    application,
    ["authorized_to_fill", "filling", "needs_user_action", "final_review", "submitting"],
    form.readyToSubmit === false ? "needs_user_action" : "final_review",
  );
  application.form = { ...form, hash: formDigest(form) };
  application.approvals = application.approvals.filter(
    (approval) => approval.kind !== "submit",
  );
}

export function formDigest(
  form: Pick<FormSnapshot, "url" | "fields" | "attachments"> & Partial<Pick<FormSnapshot, "readyToSubmit" | "blockers" | "submitControl">>,
): string {
  return hashJson({
    url: form.url,
    fields: form.fields,
    attachments: [...form.attachments].sort(),
    readyToSubmit: form.readyToSubmit,
    blockers: form.blockers,
    submitControl: form.submitControl,
  });
}

export function approveSubmit(
  application: Application,
  userId: string,
  formHash: string,
): void {
  if (application.userId !== userId)
    throw new Error("This application belongs to another user.");
  if (
    application.status !== "final_review" ||
    !application.form ||
    application.form.readyToSubmit === false ||
    application.form.hash !== formHash
  ) {
    throw new Error(
      "The form changed. Review its current contents before submitting.",
    );
  }
  application.approvals.push({
    version: 1,
    id: newId(),
    kind: "submit",
    userId,
    applicationId: application.id,
    targetUrl: application.form.url,
    reviewHash: formHash,
    createdAt: new Date().toISOString(),
  });
  transition(application, ["final_review"], "approved_to_submit");
}

function supportedApproval(approval: Approval): boolean {
  // Existing records used these exact fields before the version was explicit.
  // They retain v1 semantics; future or malformed explicit versions do not.
  return approval.version === 1 || approval.version === undefined;
}

export function hasFillApproval(application: Application, userId: string, targetUrl: string | undefined): boolean {
  return Boolean(targetUrl && application.userId === userId && application.packet &&
    (application.packet.schemaVersion === undefined || application.packet.schemaVersion === 1) &&
    application.packetHash === hashJson(application.packet) &&
    application.approvals.some((approval) => supportedApproval(approval) &&
      approval.kind === "fill" && approval.userId === userId &&
      approval.applicationId === application.id &&
      approval.reviewHash === application.packetHash && approval.targetUrl === targetUrl));
}

export function hasSubmissionApproval(application: Application): boolean {
  return (
    ["approved_to_submit", "submitting"].includes(application.status) &&
    Boolean(
      application.form && application.form.readyToSubmit !== false && application.packet &&
      application.packetHash === hashJson(application.packet) &&
      !application.submissionAttemptedAt &&
      hasFillApproval(application, application.userId, application.jobSnapshot?.applyUrl) &&
        application.approvals.some(
          (approval) =>
            supportedApproval(approval) && approval.kind === "submit" &&
            approval.userId === application.userId &&
            approval.applicationId === application.id &&
            approval.targetUrl === application.form?.url &&
            approval.reviewHash === application.form?.hash,
        ),
    )
  );
}

export function canSubmit(application: Application): boolean {
  return application.status === "approved_to_submit" && !application.submissionStartedAt && hasSubmissionApproval(application);
}
