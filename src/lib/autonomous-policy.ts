import { assertAutonomousEssay, hasAutonomousEssayValue } from "@/lib/autonomous-essays";
import { originalResumeManifest } from "@/lib/original-resume";
import { hashJson } from "@/lib/crypto";
import { assertJobEligible } from "@/lib/application-policy";
import { validatePacket } from "@/lib/drafting";
import { onboardingCompleteness } from "@/lib/onboarding";
import { canonicalJobUrl } from "@/lib/sources";
import { formDigest } from "@/lib/workflow";
import { answerOwner } from "@/lib/answer-responsibility";
import type { Application, Job, Profile, FormSnapshot } from "@/lib/types";

export function unsupportedAutonomousForm(form: Pick<FormSnapshot, "fields">, application?: Application): boolean {
  return form.fields.some((field) => (field.kind === "textarea" || answerOwner(field.label) === "ai") && (field.required || Boolean(field.value.trim())) && !hasAutonomousEssayValue(application, field, form.fields));
}

export function exactApplicationUrl(raw: string, base?: string): string {
  const url = new URL(raw, base);
  url.hash = "";
  return url.href;
}

export function assertAutonomousDestination(application: Application, form: Pick<FormSnapshot, "url" | "submitControl">): void {
  const auth = application.autonomousAuthorization;
  if (!auth?.expectedFormUrl || auth.expectedFormUrl !== auth.targetUrl || auth.expectedSubmitAction !== auth.targetUrl ||
      exactApplicationUrl(form.url) !== exactApplicationUrl(auth.expectedFormUrl) || !form.submitControl ||
      exactApplicationUrl(form.submitControl.action || form.url, form.url) !== exactApplicationUrl(auth.expectedSubmitAction))
    throw new Error("The observed form or submit destination changed from the authorized application URL. This workflow cannot follow a different posting or action.");
}

export function autonomyProfileHash(profile: Profile): string { return hashJson(profile); }
export function autonomyJobHash(job: Job): string {
  const material = { ...job };
  delete material.lastCheckedAt;
  delete material.importCheck;
  // Discovery time is ingestion metadata, not a change to the opportunity.
  const { discoveredAt, ...posting } = material;
  void discoveredAt;
  return hashJson(posting);
}

/** Final claim guard for owner-confirmed controls kept outside the packet. */
export function hasBoundAutonomousHumanAnswers(application: Application, profile: Profile, form: Pick<FormSnapshot, "url" | "fields">): boolean {
  return (application.autonomousHumanAnswers ?? []).every((answer) => {
    if (answer.userId !== profile.id || answer.applicationId !== application.id || answer.profileHash !== autonomyProfileHash(profile) || answer.targetUrl !== form.url) return false;
    const fields = form.fields.filter((field) => field.identifier === answer.question.identifier && field.kind === answer.question.kind && field.label === answer.question.label);
    if (!fields.length) return false;
    if (answer.question.kind === "radio") {
      const options = fields.map((field) => field.value);
      return options.length === answer.question.options.length && options.every((option, index) => option === answer.question.options[index]) && fields.some((field) => field.value === answer.value && field.checked === true);
    }
    const field = fields.length === 1 ? fields[0] : undefined;
    return Boolean(field && JSON.stringify(field.options ?? []) === JSON.stringify(answer.question.options) && field.value === answer.value);
  });
}

/** Receiver validation for the already claimed attempt, never authorization for another click. */
export function hasBoundSubmissionAttempt(application: Application, profile: Profile, job: Job | undefined): boolean {
  const attempt = application.submissionVerification;
  if (application.status !== "submitting" || !application.submissionWorkerClaimedAt || !attempt ||
      attempt.sessionId !== application.browserSessionId || attempt.attemptedAt !== application.submissionAttemptedAt || attempt.targetUrl !== application.form?.url) return false;
  try { assertAutonomous({ ...application, submissionAttemptedAt: undefined }, profile, job, "submit"); return true; }
  catch { return false; }
}

export function assertAutomationEnabled(profile: Profile): void {
  if (!profile.onboarding?.completedAt || !onboardingCompleteness(profile).complete ||
      profile.automationAuthorization?.status !== "enabled" || profile.automationAuthorization.version !== profile.automationVersion ||
      profile.automationSettings?.version !== profile.automationVersion)
    throw new Error("Complete onboarding and enable your current automation settings before applying automatically.");
  if (!profile.automationSettings.resumeTailoring) originalResumeManifest(profile);
  if (profile.automationSettings.essayMode !== "automatic-truthful")
    throw new Error("This essay workflow is not available yet.");
}

export function authorizeKnownAnswerApplication(application: Application, profile: Profile, job: Job): void {
  application.autonomousAuthorization = { version: 1, userId: profile.id, profileVersion: profile.automationVersion!, targetUrl: job.applyUrl, expectedFormUrl: job.applyUrl, expectedSubmitAction: job.applyUrl, authorizedAt: new Date().toISOString(), profileHash: autonomyProfileHash(profile), jobHash: autonomyJobHash(job), postingIdentity: canonicalJobUrl(job.url) };
  assertAutonomous(application, profile, job, "draft");
}

/** Each phase validates current persisted inputs. Unsealed legacy records cannot authorize automation. */
export function assertAutonomous(application: Application, profile: Profile, job: Job | undefined, phase: "draft" | "fill" | "submit"): void {
  assertAutomationEnabled(profile);
  if (!job?.active) throw new Error("The listing closed before this application could proceed.");
  assertJobEligible(profile, job);
  const auth = application.autonomousAuthorization;
  if (!auth || auth.version !== 1 || auth.userId !== profile.id || application.userId !== profile.id ||
      auth.profileVersion !== profile.automationVersion || auth.profileHash !== autonomyProfileHash(profile) ||
      auth.jobHash !== autonomyJobHash(job) || auth.postingIdentity !== canonicalJobUrl(job.url) || auth.targetUrl !== job.applyUrl ||
      auth.expectedFormUrl !== auth.targetUrl || auth.expectedSubmitAction !== auth.targetUrl ||
      ["cancelled", "submitted", "uncertain", "awaiting_verification"].includes(application.status))
    throw new Error("The application authorization changed. Start a new authorized workflow after reviewing your settings.");
  if (phase === "draft") return;
  if (!application.packet || auth.packetHash !== application.packetHash || application.packetHash !== hashJson(application.packet) ||
      !auth.filesHash || auth.filesHash !== hashJson(application.packet.files) || (application.packet.coverLetter && (profile.automationSettings!.coverLetterMode === "disabled" || (profile.automationSettings!.coverLetterMode === "required-only" && !auth.requiredCoverLetter))))
    throw new Error("The validated application materials changed or require an unsupported letter or essay.");
  validatePacket(profile, application.packet);
  for (const answer of application.packet.answers) assertAutonomousEssay(profile, job, answer);
  if (phase === "fill") return;
  const form = application.form;
  if (form) assertAutonomousDestination(application, form);
  if (auth.requiredCoverLetter && !form?.fields.some((field) => field.kind === "file" && field.required && /cover\s*letter/i.test(field.label))) throw new Error("The authorized required cover-letter control changed.");
  if (!form || !form.readyToSubmit || unsupportedAutonomousForm(form, application) || !hasBoundAutonomousHumanAnswers(application, profile, form) || form.blockers?.length || form.hash !== formDigest(form) || auth.formHash !== form.hash ||
      application.packet.files?.some((file) => (file.kind === "resume" || form.fields.some((field) => field.kind === "file" && /cover\s*letter/i.test(field.label))) && !form.fields.some((field) => field.fileHashes?.includes(`${file.filename}:${file.size}:${file.sha256}`))) ||
      application.submissionAttemptedAt)
    throw new Error("The authorized form changed or a submission was already attempted. No new submission is allowed.");
}

export function sealAutonomousPacket(application: Application): void {
  application.autonomousAuthorization!.packetHash = application.packetHash;
  application.autonomousAuthorization!.filesHash = hashJson(application.packet!.files);
}
