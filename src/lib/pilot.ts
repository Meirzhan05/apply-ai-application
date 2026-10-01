import { canonicalJobUrl } from "@/lib/sources";
import { hashJson, newId } from "@/lib/crypto";
import { onboardingCompleteness } from "@/lib/onboarding";
import { controlledFixtureAllowsJob, controlledFixtureScope, controlledReceiverUrl } from "@/lib/controlled-tests";
import type {
  AppState,
  Application,
  Job,
  PilotActor,
  PilotAttempt,
  PilotCohort,
  PilotConsentEpisode,
  PilotEvent,
  PilotEventKind,
  PilotOrigin,
  PilotPostingSnapshot,
  PilotProfileSnapshot,
  PilotState,
  Profile,
} from "@/lib/types";
import { PILOT_CONSENT_TEXT, PILOT_CONSENT_VERSION } from "@/lib/pilot-constants";

export { PILOT_CONSENT_TEXT, PILOT_CONSENT_VERSION, PILOT_GATE_VERSION } from "@/lib/pilot-constants";

export const PILOT_CLASSIFIER_VERSION = "posting-cohort-v1";

export interface PilotMutationContext {
  actor?: PilotActor;
  action?: string;
}

const serviceActor: PilotActor = { kind: "service" };

function bounded(value: string | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

function profileSnapshot(profile: Profile): PilotProfileSnapshot {
  return {
    name: bounded(profile.name, 160),
    school: bounded(profile.school, 160),
    graduationYear: bounded(profile.graduationYear, 20),
    headline: bounded(profile.headline, 300),
    workAuthorization: bounded(profile.workAuthorization, 120),
    facts: profile.facts.slice(0, 80).map((fact) => ({
      id: bounded(fact.id, 120),
      text: bounded(fact.text, 500),
      verified: fact.verified,
      source: fact.source,
    })),
    skills: profile.skills.slice(0, 40).map((skill) => bounded(skill, 120)),
    preferredTitles: profile.preferredTitles.slice(0, 30).map((title) => bounded(title, 120)),
    preferredLocations: profile.preferredLocations.slice(0, 30).map((location) => bounded(location, 120)),
    questionnaire: profile.onboarding?.questionnaire ? structuredClone(profile.onboarding.questionnaire) : {},
    resumeHash: profile.resumeSource?.sha256,
    factsTruncated: profile.facts.length > 80,
  };
}

function isRecognizedRealSource(job: Job): boolean {
  return job.source === "greenhouse" || job.source === "lever" || job.source === "ashby";
}

export function pilotConsentText(version = PILOT_CONSENT_VERSION): string {
  if (version !== PILOT_CONSENT_VERSION) throw new Error("Unsupported pilot consent version.");
  return PILOT_CONSENT_TEXT;
}

export function pilotConsentHash(version = PILOT_CONSENT_VERSION): string {
  return hashJson({ version, text: pilotConsentText(version) });
}

export function pilotState(state: AppState): PilotState {
  state.pilot ??= { version: 1, episodes: [], events: [] };
  state.pilot.events ??= [];
  return state.pilot;
}

export function enrollPilot(
  state: AppState,
  ownerId: string,
  input: { consentVersion: string; confirmed: boolean },
): PilotConsentEpisode {
  if (!input.confirmed) throw new Error("Confirm the pilot participation statement before enrolling.");
  if (input.consentVersion !== PILOT_CONSENT_VERSION) throw new Error("This pilot consent version is no longer available.");
  if (state.profile.id !== ownerId) throw new Error("This pilot account belongs to another user.");
  const complete = onboardingCompleteness(state.profile);
  if (!complete.complete) throw new Error(`Complete onboarding before joining the pilot: ${complete.missing.join(", ")}.`);
  const now = new Date().toISOString();
  const episode: PilotConsentEpisode = {
    version: 1,
    id: newId(),
    ownerId,
    consentVersion: input.consentVersion,
    consentTextHash: pilotConsentHash(input.consentVersion),
    consentedAt: now,
    onboardingCompletedAt: state.profile.onboarding?.completedAt ?? now,
    automationVersion: state.profile.automationVersion,
    automationAuthorization: state.profile.automationAuthorization ? structuredClone(state.profile.automationAuthorization) : undefined,
    profileHash: hashJson(profileSnapshot(state.profile)),
    profileSnapshot: profileSnapshot(state.profile),
  };
  const pilot = pilotState(state);
  if (pilot.activeEpisodeId) {
    const active = pilot.episodes.find((item) => item.id === pilot.activeEpisodeId);
    if (active && !active.withdrawnAt) throw new Error("This account is already enrolled in the pilot.");
  }
  pilot.episodes.push(episode);
  pilot.activeEpisodeId = episode.id;
  pilot.events.push(event("owner-action", { kind: "owner", userId: ownerId }, "Pilot enrollment consented."));
  return episode;
}

export function withdrawPilot(state: AppState, ownerId: string): PilotConsentEpisode {
  const pilot = pilotState(state);
  const episode = pilot.activeEpisodeId ? pilot.episodes.find((item) => item.id === pilot.activeEpisodeId) : undefined;
  if (!episode || episode.ownerId !== ownerId || episode.withdrawnAt) throw new Error("This account is not enrolled in the pilot.");
  episode.withdrawnAt = new Date().toISOString();
  pilot.activeEpisodeId = undefined;
  pilot.events.push(event("owner-action", { kind: "owner", userId: ownerId }, "Pilot participation withdrawn for future initiations."));
  return episode;
}

export function activePilotEpisode(state: AppState): PilotConsentEpisode | undefined {
  const pilot = state.pilot;
  if (!pilot?.activeEpisodeId) return undefined;
  const episode = pilot.episodes.find((item) => item.id === pilot.activeEpisodeId);
  return episode && !episode.withdrawnAt ? episode : undefined;
}

function evidenceText(job: Job): string {
  return [job.title, job.employmentType, job.description].map((value) => value.trim()).filter(Boolean).join(" | ").slice(0, 900);
}

function credentialFreePostingUrl(raw: string): string {
  try {
    const url = new URL(canonicalJobUrl(raw));
    url.username = "";
    url.password = "";
    url.hash = "";
    const safe = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (/^(?:gh_jid|job[_-]?id)$/i.test(key)) safe.set(key, value);
    }
    url.search = safe.toString();
    return url.toString();
  } catch {
    return "";
  }
}

export function classifyPilotCohort(job: Job): { cohort: PilotCohort; evidence?: string } {
  const title = job.title.toLowerCase();
  const type = job.employmentType.toLowerCase();
  const description = job.description.toLowerCase();
  const internship = /\bintern(ship)?\b|co[- ]?op/.test(`${title} ${type} ${description}`);
  const graduate = /\bnew grad(uate)?\b|entry[- ]level|recent graduate/.test(`${title} ${type} ${description}`);
  if (internship === graduate) return { cohort: "unclassified" };
  return internship
    ? { cohort: "internship", evidence: evidenceText(job).slice(0, 300) }
    : { cohort: "new-grad", evidence: evidenceText(job).slice(0, 300) };
}

export function classifyPilotOrigin(state: AppState, job: Job, application?: Application): PilotOrigin {
  const fixtureScope = controlledFixtureScope(state, application?.userId ?? state.profile.id);
  if (fixtureScope.controlled) {
    return application?.controlledTest && controlledFixtureAllowsJob(state, application.userId, job) ? "controlled" : "unknown";
  }
  if (job.source === "demo") return "controlled";
  if (controlledReceiverUrl(job.url) || controlledReceiverUrl(job.applyUrl)) return "unknown";
  if (isRecognizedRealSource(job)) return "real";
  return "unknown";
}

function postingSnapshot(job: Job): PilotPostingSnapshot {
  const url = canonicalJobUrl(job.url);
  return {
    jobId: job.id,
    source: job.source,
    sourceId: bounded(job.sourceId, 200),
    canonicalUrl: bounded(credentialFreePostingUrl(job.url), 2048),
    targetIdentityHash: hashJson({ url, applyUrl: canonicalJobUrl(job.applyUrl), source: job.source, sourceId: job.sourceId }),
    title: bounded(job.title, 240),
    company: bounded(job.company, 240),
    employmentType: bounded(job.employmentType, 120),
    description: bounded(job.description, 4000),
    evidenceHash: hashJson({ title: job.title, company: job.company, employmentType: job.employmentType, description: job.description, requirements: job.requirements.slice(0, 40) }),
  };
}

function event(
  kind: PilotEventKind,
  actor: PilotActor,
  detail?: string,
  extra: Partial<Pick<PilotEvent, "blockerId" | "blockerReason" | "outcome" | "evidenceHash">> = {},
): PilotEvent {
  return { version: 1, id: newId(), kind, at: new Date().toISOString(), actor, detail: detail?.slice(0, 500), ...extra };
}

function sameEvent(left: PilotEvent, right: PilotEvent): boolean {
  return left.kind === right.kind && left.blockerId === right.blockerId && left.blockerReason === right.blockerReason && left.outcome === right.outcome && left.detail === right.detail && left.evidenceHash === right.evidenceHash && left.actor.kind === right.actor.kind && left.actor.userId === right.actor.userId;
}

function appendEvent(attempt: PilotAttempt, next: PilotEvent): void {
  if (!attempt.events.some((existing) => sameEvent(existing, next))) attempt.events.push(next);
}

function applicationWithoutPilot(application: Application): unknown {
  const copy = structuredClone(application);
  delete copy.pilotAttempt;
  return copy;
}

function initiatedAttempt(state: AppState, application: Application): PilotAttempt | undefined {
  const episode = activePilotEpisode(state);
  if (!episode || application.pilotAttempt) return undefined;
  const job = application.jobSnapshot ?? state.jobs.find((item) => item.id === application.jobId);
  if (!job) return undefined;
  const cohort = classifyPilotCohort(job);
  const origin = classifyPilotOrigin(state, job, application);
  const attempt: PilotAttempt = {
    version: 1,
    id: newId(),
    applicationId: application.id,
    ownerId: application.userId,
    consentEpisodeId: episode.id,
    consentVersion: episode.consentVersion,
    consentedAt: episode.consentedAt,
    initiatedAt: application.createdAt,
    onboardingCompletedAt: episode.onboardingCompletedAt,
    automationVersion: state.profile.automationVersion,
    automationAuthorization: state.profile.automationAuthorization ? structuredClone(state.profile.automationAuthorization) : undefined,
    profileHash: hashJson(profileSnapshot(state.profile)),
    profileSnapshot: profileSnapshot(state.profile),
    postingSnapshot: postingSnapshot(job),
    origin,
    cohort: cohort.cohort,
    cohortEvidence: cohort.evidence,
    cohortClassifierVersion: PILOT_CLASSIFIER_VERSION,
    costEvidence: { version: 1, status: "unknown", projectedUsd: 0, evidenceIds: [] },
    events: [],
    reviews: [],
  };
  appendEvent(attempt, event("initiated", { kind: "owner", userId: application.userId }, "Application initiated for the enrolled pilot."));
  return attempt;
}

/** Captures the denominator in the same state mutation that creates the app. */
export function attachPilotAttempt(state: AppState, application: Application): void {
  const attempt = initiatedAttempt(state, application);
  if (attempt) application.pilotAttempt = attempt;
}

function immutableAttemptProjection(attempt: PilotAttempt): unknown {
  const immutable = structuredClone(attempt) as Omit<PilotAttempt, "costEvidence"> & { costEvidence?: PilotAttempt["costEvidence"] };
  delete immutable.costEvidence;
  delete immutable.currentEvidenceDigest;
  delete immutable.submissionProfileSnapshot;
  delete immutable.submissionEvidenceHash;
  delete immutable.controlledExclusion;
  immutable.events = [];
  immutable.reviews = [];
  return immutable;
}

function appendOnly(previous: PilotAttempt, next: PilotAttempt): boolean {
  if (hashJson(immutableAttemptProjection(previous)) !== hashJson(immutableAttemptProjection(next))) return false;
  if (next.events.length < previous.events.length || next.reviews.length < previous.reviews.length) return false;
  for (let index = 0; index < previous.events.length; index++) if (hashJson(previous.events[index]) !== hashJson(next.events[index])) return false;
  for (let index = 0; index < previous.reviews.length; index++) if (hashJson(previous.reviews[index]) !== hashJson(next.reviews[index])) return false;
  return true;
}

function statusEvidence(application: Application, profile?: Profile): { kind: PilotEventKind; outcome?: PilotEvent["outcome"]; evidenceHash?: string } | undefined {
  if (application.status === "submitted" && application.submissionReceipt && application.submissionAttemptedAt) return { kind: "receipt-confirmed", outcome: "confirmed", evidenceHash: hashJson({ receipt: application.submissionReceipt, submittedAt: application.submittedAt, attemptedAt: application.submissionAttemptedAt, materials: application.submissionMaterials, answers: application.packet?.answers, form: application.form, profile: profile ? profileSnapshot(profile) : undefined }) };
  if (application.status === "uncertain") return { kind: "outcome-uncertain", outcome: "uncertain" };
  if (application.status === "cancelled") return { kind: "cancelled", outcome: "cancelled" };
  return undefined;
}

function submittedEvidenceProjection(application: Application): unknown {
  return {
    submissionReceipt: application.submissionReceipt,
    submissionMaterials: application.submissionMaterials,
    answers: application.packet?.answers,
    form: application.form,
  };
}

/**
 * Pure before/after observer. It runs after a mutation callback and before its
 * revision-qualified save, so evidence cannot be lost in a post-CAS side effect.
 */
export function preparePilotMutation(previous: AppState, next: AppState, context: PilotMutationContext = {}): void {
  const actor = context.actor ?? serviceActor;
  const previousAccountEvents = previous.pilot?.events ?? [];
  const nextAccountEvents = next.pilot?.events ?? [];
  if (nextAccountEvents.length < previousAccountEvents.length || previousAccountEvents.some((item, index) => hashJson(item) !== hashJson(nextAccountEvents[index]))) {
    throw new Error("Pilot account evidence is immutable and append-only.");
  }
  const previousEpisodes = previous.pilot?.episodes ?? [];
  const nextEpisodes = next.pilot?.episodes ?? [];
  if (nextEpisodes.length < previousEpisodes.length || previousEpisodes.some((episode, index) => {
    const current = nextEpisodes[index];
    return !current || hashJson({ ...episode, withdrawnAt: undefined }) !== hashJson({ ...current, withdrawnAt: undefined }) || (episode.withdrawnAt && episode.withdrawnAt !== current.withdrawnAt);
  })) throw new Error("Pilot consent episodes are immutable.");
  const previousApps = new Map(previous.applications.map((app) => [app.id, app]));
  for (const previousApp of previous.applications) {
    const current = next.applications.find((app) => app.id === previousApp.id);
    if (previousApp.pilotAttempt && (!current || !current.pilotAttempt)) throw new Error("Pilot attempts cannot be removed or detached.");
  }
  const profileChanged = hashJson(profileSnapshot(previous.profile)) !== hashJson(profileSnapshot(next.profile));
  for (const app of next.applications) {
    const attempt = app.pilotAttempt;
    if (!attempt) continue;
    const oldApp = previousApps.get(app.id);
    const oldAttempt = oldApp?.pilotAttempt;
    if (oldAttempt && !appendOnly(oldAttempt, attempt)) throw new Error("Pilot evidence is immutable and append-only.");
    if (oldAttempt?.submissionEvidenceHash && (oldAttempt.submissionEvidenceHash !== attempt.submissionEvidenceHash || hashJson(oldAttempt.submissionProfileSnapshot) !== hashJson(attempt.submissionProfileSnapshot)))
      throw new Error("Submission-time profile evidence is immutable.");
    if (oldApp?.submissionReceipt && hashJson(submittedEvidenceProjection(oldApp)) !== hashJson(submittedEvidenceProjection(app)))
      throw new Error("Submitted evidence is immutable after the receipt is captured.");
    if (!oldAttempt) {
      if (oldApp || !activePilotEpisode(previous) || app.userId !== previous.profile.id) throw new Error("Pilot attempts can only be attached when a new enrolled application is initiated.");
      for (const blocker of app.blockers ?? []) if (blocker.progress === "blocked" && blocker.reason !== "resource_hold") appendEvent(attempt, event("intervention-requested", serviceActor, blocker.message, { blockerId: blocker.id, blockerReason: blocker.reason, evidenceHash: hashJson(blocker) }));
      if (app.controlledTest) appendEvent(attempt, event("controlled-excluded", serviceActor, "A controlled validation marker was observed at initiation."));
      continue;
    }
    attempt.costEvidence ??= { version: 1, status: "unknown", projectedUsd: 0, evidenceIds: [] };
    if (actor.kind === "owner" && profileChanged && !["submitted", "uncertain", "cancelled"].includes(app.status)) appendEvent(attempt, event("owner-action", actor, context.action || "Profile or automation settings updated."));
    if (actor.kind === "owner" && oldApp && hashJson(applicationWithoutPilot(oldApp)) !== hashJson(applicationWithoutPilot(app))) appendEvent(attempt, event("owner-action", actor, context.action || "Application updated."));
    if (!oldApp?.manualSubmissionReport && app.manualSubmissionReport) appendEvent(attempt, event("owner-action", { kind: "owner", userId: app.userId }, "The owner reported an unconfirmed manual outcome.", { evidenceHash: hashJson({ reportedAt: app.manualSubmissionReport.reportedAt, outcome: app.manualSubmissionReport.outcome }) }));
    if ((app.autonomousHumanAnswers?.length ?? 0) > (oldApp?.autonomousHumanAnswers?.length ?? 0)) appendEvent(attempt, event("owner-action", { kind: "owner", userId: app.userId }, "The owner supplied a required application answer.", { evidenceHash: hashJson(app.autonomousHumanAnswers) }));
    const projectedUsd = [...(app.runs ?? [])].reduce((sum, run) => sum + run.projectedUsd, 0) + (app.budgetReservation?.projectedUsd ?? 0);
    if (projectedUsd !== attempt.costEvidence.projectedUsd) attempt.costEvidence = { ...attempt.costEvidence, projectedUsd };
    const newSubmission = Boolean(app.submissionAttemptedAt && !oldApp?.submissionAttemptedAt);
    if (newSubmission && !attempt.submissionEvidenceHash) {
      attempt.submissionProfileSnapshot = profileSnapshot(next.profile);
      attempt.submissionEvidenceHash = hashJson({ profile: attempt.submissionProfileSnapshot, evidence: submittedEvidenceProjection(app) });
    }
    if (oldApp?.status !== app.status) {
      const status = statusEvidence(app, next.profile);
      if (status) appendEvent(attempt, event(status.kind, status.kind === "receipt-confirmed" ? serviceActor : actor, `Application status: ${app.status}.`, { outcome: status.outcome, evidenceHash: status.evidenceHash }));
    }
    if (newSubmission) appendEvent(attempt, event("submission-attempted", serviceActor, "The agent recorded one submission attempt.", { evidenceHash: attempt.submissionEvidenceHash }));
    if (!oldApp?.submissionReceipt && app.submissionReceipt && app.submissionAttemptedAt) {
      appendEvent(attempt, event("receipt-confirmed", serviceActor, "An agent-observed submission receipt was captured.", { outcome: "confirmed", evidenceHash: hashJson({ receipt: app.submissionReceipt, submittedAt: app.submittedAt, attemptedAt: app.submissionAttemptedAt, materials: app.submissionMaterials, answers: app.packet?.answers, form: app.form, profile: profileSnapshot(next.profile) }) }));
    }
    if (!oldApp?.queuedRun && app.queuedRun) appendEvent(attempt, event("queued", serviceActor, `Queued ${app.queuedRun.kind} work.`));
    if (app.budgetReservation?.status === "release_pending" && oldApp?.budgetReservation?.status !== "release_pending") appendEvent(attempt, event("hold", serviceActor, "Service spend is held pending a later release."));
    if (app.error && app.error !== oldApp?.error) appendEvent(attempt, event("failed", serviceActor, "The application reported an operational failure.", { outcome: "failed", evidenceHash: hashJson(app.error) }));
    const oldBlockers = new Map((oldApp?.blockers ?? []).map((blocker) => [blocker.id, blocker]));
    for (const blocker of app.blockers ?? []) {
      if (blocker.reason === "resource_hold" || blocker.progress !== "blocked") continue;
      const prior = oldBlockers.get(blocker.id);
      const fingerprint = hashJson({ reason: blocker.reason, message: blocker.message, context: blocker.context, progress: blocker.progress });
      const priorFingerprint = prior ? hashJson({ reason: prior.reason, message: prior.message, context: prior.context, progress: prior.progress }) : undefined;
      if (!prior || fingerprint !== priorFingerprint) {
        appendEvent(attempt, event("intervention-requested", serviceActor, blocker.message, { blockerId: blocker.id, blockerReason: blocker.reason, evidenceHash: fingerprint }));
      }
    }
    if (app.controlledTest && attempt.origin !== "controlled") {
      appendEvent(attempt, event("controlled-excluded", serviceActor, "A controlled validation marker was observed after initiation."));
    }
  }
}

export function pilotAttemptExcluded(attempt: PilotAttempt): boolean {
  return attempt.origin === "controlled" || attempt.events.some((item) => item.kind === "controlled-excluded");
}

export function pilotAttemptHasIntervention(attempt: PilotAttempt): boolean {
  return attempt.events.some((item) => item.kind === "intervention-requested" || item.kind === "owner-action");
}

export function pilotEvidenceDigest(attempt: PilotAttempt): string {
  return hashJson({ immutable: immutableAttemptProjection(attempt), events: attempt.events });
}

export function appendPilotReview(
  state: AppState,
  reviewerId: string,
  input: { applicationId: string; evidenceDigest: string; suitability: "pass" | "fail" | "insufficient"; factualAccuracy: "pass" | "fail" | "insufficient" | "not-applicable"; notes: string; rubricVersion?: string },
): void {
  const app = state.applications.find((item) => item.id === input.applicationId);
  if (!app?.pilotAttempt) throw new Error("Pilot attempt not found.");
  if (pilotEvidenceDigest(app.pilotAttempt) !== input.evidenceDigest) throw new Error("Pilot evidence changed; refresh the review before saving it.");
  app.pilotAttempt.reviews.push({ version: 1, id: newId(), attemptId: app.pilotAttempt.id, reviewerId, rubricVersion: (input.rubricVersion || "pilot-review-v1").slice(0, 80), suitability: input.suitability, factualAccuracy: input.factualAccuracy, notes: bounded(input.notes, 1000), evidenceDigest: input.evidenceDigest, createdAt: new Date().toISOString(), supersedesReviewId: app.pilotAttempt.reviews.at(-1)?.id });
}

export function allPilotAttempts(state: AppState): PilotAttempt[] {
  return state.applications.flatMap((app) => app.pilotAttempt ? [app.pilotAttempt] : []);
}
