import { hashJson, newId } from "@/lib/crypto";
import { allPilotAttempts, pilotAttemptExcluded, pilotAttemptHasIntervention, pilotEvidenceDigest, PILOT_GATE_VERSION } from "@/lib/pilot";
import type { AppState, PilotActor, PilotAttempt, PilotCohort, PilotGateStatus, PilotReportSnapshot } from "@/lib/types";
import { costReport } from "@/lib/service-costs";

function confirmed(attempt: PilotAttempt): boolean {
  return attempt.events.some((event) => event.kind === "receipt-confirmed" && event.outcome === "confirmed");
}

function reviewed(attempt: PilotAttempt): boolean {
  const review = attempt.reviews.at(-1);
  return Boolean(review && review.evidenceDigest === pilotEvidenceDigest(attempt) && review.suitability === "pass" && ["pass", "not-applicable"].includes(review.factualAccuracy));
}

function safeCell(value: unknown): string {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return /^[=+\-@\t\x00]/.test(text) ? `'${text}` : text;
}

export function pilotReportStatus(reasons: string[]): PilotGateStatus {
  if (reasons.includes("fewer-than-20-real-initiated")) return "insufficient-real-evidence";
  if (reasons.some((reason) => reason === "cohorts-missing" || reason === "unattended-rate-below-80-percent" || reason === "confirmed-attempt-review-failed")) return "failed";
  if (reasons.includes("confirmed-attempt-review-incomplete")) return "review-incomplete";
  return "passed";
}

export function buildPilotReportSnapshot(
  state: AppState,
  createdBy: PilotActor,
  options: { ownerId?: string; cutoffAt?: string; stateOwnerIds?: string[] } = {},
): PilotReportSnapshot {
  const cutoffAt = options.cutoffAt ?? new Date().toISOString();
  const allAttempts = allPilotAttempts(state);
  const permanentlyExcluded = new Set(allAttempts.filter((attempt) => attempt.origin === "controlled" || attempt.events.some((event) => event.kind === "controlled-excluded")).map((attempt) => attempt.id));
  const attempts = allAttempts
    .filter((attempt) => !options.ownerId || attempt.ownerId === options.ownerId)
    .filter((attempt) => attempt.initiatedAt <= cutoffAt)
    .map((attempt) => {
      const snapshot = structuredClone(attempt);
      const exclusionEvents = snapshot.events.filter((event) => event.kind === "controlled-excluded");
      if (exclusionEvents.length) snapshot.controlledExclusion = { eventIds: exclusionEvents.map((event) => event.id), latestAt: exclusionEvents.at(-1)!.at, afterCutoff: exclusionEvents.some((event) => event.at > cutoffAt) };
      snapshot.events = snapshot.events.filter((event) => event.at <= cutoffAt);
      snapshot.reviews = snapshot.reviews.filter((review) => review.createdAt <= cutoffAt);
      const submissionEvent = snapshot.events.find((event) => event.kind === "submission-attempted");
      if (!submissionEvent) {
        snapshot.submissionProfileSnapshot = undefined;
        snapshot.submissionEvidenceHash = undefined;
      }
      return { ...snapshot, currentEvidenceDigest: pilotEvidenceDigest(snapshot) };
    })
    .sort((left, right) => left.initiatedAt.localeCompare(right.initiatedAt) || left.id.localeCompare(right.id));
  const real = attempts.filter((attempt) => attempt.origin === "real" && !permanentlyExcluded.has(attempt.id) && !pilotAttemptExcluded(attempt));
  const controlled = attempts.filter((attempt) => permanentlyExcluded.has(attempt.id) || pilotAttemptExcluded(attempt));
  const unknown = attempts.filter((attempt) => attempt.origin === "unknown" && !permanentlyExcluded.has(attempt.id) && !pilotAttemptExcluded(attempt));
  const confirmedReal = real.filter(confirmed);
  const unattendedConfirmed = confirmedReal.filter((attempt) => !pilotAttemptHasIntervention(attempt));
  const cohorts: Record<PilotCohort, { initiated: number; confirmed: number }> = {
    internship: { initiated: 0, confirmed: 0 },
    "new-grad": { initiated: 0, confirmed: 0 },
    unclassified: { initiated: 0, confirmed: 0 },
  };
  for (const attempt of real) {
    cohorts[attempt.cohort].initiated += 1;
    if (confirmed(attempt)) cohorts[attempt.cohort].confirmed += 1;
  }
  const reasons: string[] = [];
  if (real.length < 20) reasons.push("fewer-than-20-real-initiated");
  if (!cohorts.internship.initiated || !cohorts["new-grad"].initiated) reasons.push("cohorts-missing");
  if (real.length && unattendedConfirmed.length / real.length < 0.8) reasons.push("unattended-rate-below-80-percent");
  if (confirmedReal.some((attempt) => !reviewed(attempt))) reasons.push("confirmed-attempt-review-incomplete");
  if (confirmedReal.some((attempt) => { const review = attempt.reviews.at(-1); return review?.suitability === "fail" || review?.factualAccuracy === "fail"; })) reasons.push("confirmed-attempt-review-failed");
  const status = pilotReportStatus(reasons);
  return {
    version: 1,
    id: newId(),
    createdAt: new Date().toISOString(),
    createdBy,
    cutoffAt,
    gateVersion: PILOT_GATE_VERSION,
    status,
    reasons,
    totals: {
      realInitiated: real.length,
      confirmed: confirmedReal.length,
      unattendedConfirmed: unattendedConfirmed.length,
      interventions: real.filter(pilotAttemptHasIntervention).length,
      controlled: controlled.length,
      unknown: unknown.length,
      unknownCosts: real.filter((attempt) => attempt.costEvidence?.status !== "measured").length,
    },
    cohorts,
  sourceManifest: { stateOwnerIds: options.stateOwnerIds ?? (options.ownerId ? [options.ownerId] : createdBy.userId ? [createdBy.userId] : []), stateReadAt: new Date().toISOString(), complete: true, stateRows: (options.stateOwnerIds ?? (options.ownerId ? [options.ownerId] : createdBy.userId ? [createdBy.userId] : [])).map((ownerId) => ({ ownerId, readAt: new Date().toISOString(), eventPrefixes: [] })), controlledExclusions: attempts.flatMap((attempt) => attempt.controlledExclusion ? [{ attemptId: attempt.id, eventIds: attempt.controlledExclusion.eventIds, latestAt: attempt.controlledExclusion.latestAt }] : []) },
    attempts,
  };
}

/** Adds provider ledger references without changing the immutable denominator. */
export async function attachPilotCostEvidence(report: PilotReportSnapshot, options: { ownerId?: string; service?: boolean; period?: string } = {}): Promise<PilotReportSnapshot> {
  let costs;
  try {
    costs = await costReport(options.ownerId ?? report.createdBy.userId ?? "", { service: options.service, period: options.period });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : "Cost evidence could not be loaded.";
    return {
      ...report,
      totals: { ...report.totals, unknownCosts: report.attempts.length },
      sourceManifest: { ...report.sourceManifest, cost: { scope: options.service ? "service" : "owner", period: options.period, evidenceIds: [], unknownComponents: 1, complete: false, error: message, capturedAt: new Date().toISOString() } },
      attempts: report.attempts.map((attempt) => ({ ...attempt, costEvidence: { ...attempt.costEvidence, status: "unknown", measuredUsd: undefined, estimatedUsd: undefined, reconciledUsd: undefined, evidenceIds: [], capturedAt: new Date().toISOString() } })),
    };
  }
  const attempts = report.attempts.map((attempt) => {
    const evidence = costs.evidence.filter((item) => item.applicationId === attempt.applicationId);
    const known = evidence.filter((item) => item.amountUsd !== null);
    const measured = known.filter((item) => item.measurement === "measured");
    const estimated = known.filter((item) => item.measurement === "estimated");
    const status: "unknown" | "incomplete" | "estimated" | "measured" = evidence.length === 0 || evidence.some((item) => item.unknown) ? (evidence.length ? "incomplete" : "unknown") : estimated.length ? "estimated" : "measured";
    const reconciled = known.filter((item) => item.reconciledUsd !== null);
    return { ...attempt, costEvidence: { ...attempt.costEvidence, status, estimatedUsd: estimated.length ? estimated.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : undefined, measuredUsd: measured.length ? measured.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : undefined, reconciledUsd: reconciled.length ? reconciled.reduce((sum, item) => sum + (item.reconciledUsd ?? 0), 0) : undefined, evidenceIds: evidence.map((item) => item.id), estimatedEvidenceIds: estimated.map((item) => item.id), measuredEvidenceIds: measured.map((item) => item.id), reconciledEvidenceIds: reconciled.map((item) => item.id), rateVersions: [...new Set(evidence.map((item) => item.rateVersion).filter((item): item is string => Boolean(item)))], capturedAt: new Date().toISOString() } };
  });
  return { ...report, attempts, totals: { ...report.totals, unknownCosts: attempts.filter((attempt) => attempt.costEvidence.status !== "measured").length }, sourceManifest: { ...report.sourceManifest, cost: { scope: costs.scope, period: costs.period, evidenceIds: costs.evidence.map((item) => item.id), unknownComponents: costs.unknownComponents, complete: costs.unknownComponents === 0, capturedAt: new Date().toISOString() } } };
}

export function pilotReportCsv(report: PilotReportSnapshot): string {
  const header = ["attemptId", "ownerId", "applicationId", "origin", "cohort", "initiatedAt", "outcome", "intervention", "reviewed"];
  const rows = report.attempts.map((attempt) => [
    attempt.id,
    attempt.ownerId,
    attempt.applicationId,
    attempt.origin,
    attempt.cohort,
    attempt.initiatedAt,
    attempt.events.some((event) => event.outcome === "confirmed") ? "confirmed" : attempt.events.at(-1)?.outcome ?? "pending",
    pilotAttemptHasIntervention(attempt) ? "yes" : "no",
    reviewed(attempt) ? "yes" : "no",
  ]);
  return [header, ...rows].map((row) => row.map((cell) => `"${safeCell(cell).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}

export function pilotReportDigest(report: PilotReportSnapshot): string {
  const copy = structuredClone(report);
  copy.id = "";
  copy.createdAt = "";
  copy.sourceManifest.stateReadAt = "";
  copy.sourceManifest.stateRows = copy.sourceManifest.stateRows.map((row) => ({ ...row, readAt: "" }));
  if (copy.sourceManifest.cost) copy.sourceManifest.cost = { ...copy.sourceManifest.cost, capturedAt: "" };
  copy.attempts = copy.attempts.map((attempt) => ({ ...attempt, costEvidence: { ...attempt.costEvidence, capturedAt: undefined } }));
  return hashJson(copy);
}

export function pilotReportIdentity(report: PilotReportSnapshot): string {
  return hashJson({ gateVersion: report.gateVersion, cutoffAt: report.cutoffAt, stateOwnerIds: report.sourceManifest.stateOwnerIds, complete: report.sourceManifest.complete, stateRows: report.sourceManifest.stateRows.map((row) => ({ ownerId: row.ownerId, revision: row.revision, eventPrefixes: row.eventPrefixes })), controlledExclusions: report.sourceManifest.controlledExclusions, cost: report.sourceManifest.cost ? { scope: report.sourceManifest.cost.scope, period: report.sourceManifest.cost.period, evidenceIds: report.sourceManifest.cost.evidenceIds, unknownComponents: report.sourceManifest.cost.unknownComponents } : undefined, attempts: report.attempts.map((attempt) => ({ id: attempt.id, applicationId: attempt.applicationId, events: attempt.events, reviews: attempt.reviews, controlledExclusion: attempt.controlledExclusion, costEvidence: { ...attempt.costEvidence, capturedAt: undefined } })) });
}

export function ownerPilotReport(report: PilotReportSnapshot, ownerId: string): PilotReportSnapshot {
  return {
    ...report,
    attempts: report.attempts.filter((attempt) => attempt.ownerId === ownerId),
  };
}
