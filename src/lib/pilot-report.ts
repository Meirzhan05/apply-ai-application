import { hashJson, newId } from "@/lib/crypto";
import { allPilotAttempts, pilotAttemptExcluded, pilotAttemptHasIntervention, PILOT_GATE_VERSION } from "@/lib/pilot";
import type { AppState, PilotActor, PilotAttempt, PilotCohort, PilotGateStatus, PilotReportSnapshot } from "@/lib/types";
import { costReport } from "@/lib/service-costs";

function confirmed(attempt: PilotAttempt): boolean {
  return attempt.events.some((event) => event.kind === "receipt-confirmed" && event.outcome === "confirmed");
}

function reviewed(attempt: PilotAttempt): boolean {
  const review = attempt.reviews.at(-1);
  return Boolean(review && review.suitability === "pass" && review.factualAccuracy === "pass");
}

function safeCell(value: unknown): string {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  return /^[=+\-@\t\x00]/.test(text) ? `'${text}` : text;
}

export function pilotReportStatus(reasons: string[]): PilotGateStatus {
  if (reasons.includes("fewer-than-20-real-initiated")) return "insufficient-real-evidence";
  if (reasons.some((reason) => reason === "cohorts-missing" || reason === "unattended-rate-below-80-percent")) return "failed";
  if (reasons.includes("confirmed-attempt-review-incomplete")) return "review-incomplete";
  return "passed";
}

export function buildPilotReportSnapshot(
  state: AppState,
  createdBy: PilotActor,
  options: { ownerId?: string; cutoffAt?: string; stateOwnerIds?: string[] } = {},
): PilotReportSnapshot {
  const cutoffAt = options.cutoffAt ?? new Date().toISOString();
  const attempts = allPilotAttempts(state)
    .filter((attempt) => !options.ownerId || attempt.ownerId === options.ownerId)
    .filter((attempt) => attempt.initiatedAt <= cutoffAt)
    .map((attempt) => structuredClone(attempt))
    .sort((left, right) => left.initiatedAt.localeCompare(right.initiatedAt) || left.id.localeCompare(right.id));
  const real = attempts.filter((attempt) => attempt.origin === "real" && !pilotAttemptExcluded(attempt));
  const controlled = attempts.filter((attempt) => pilotAttemptExcluded(attempt));
  const unknown = attempts.filter((attempt) => attempt.origin === "unknown" && !pilotAttemptExcluded(attempt));
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
    sourceManifest: { stateOwnerIds: options.stateOwnerIds ?? (options.ownerId ? [options.ownerId] : createdBy.userId ? [createdBy.userId] : []), stateReadAt: new Date().toISOString(), stateRows: (options.stateOwnerIds ?? (options.ownerId ? [options.ownerId] : createdBy.userId ? [createdBy.userId] : [])).map((ownerId) => ({ ownerId, readAt: new Date().toISOString() })) },
    attempts,
  };
}

/** Adds provider ledger references without changing the immutable denominator. */
export async function attachPilotCostEvidence(report: PilotReportSnapshot, options: { ownerId?: string; service?: boolean; period?: string } = {}): Promise<PilotReportSnapshot> {
  const costs = await costReport(options.ownerId ?? report.createdBy.userId ?? "", { service: options.service, period: options.period });
  const attempts = report.attempts.map((attempt) => {
    const evidence = costs.evidence.filter((item) => item.applicationId === attempt.applicationId);
    const known = evidence.filter((item) => item.amountUsd !== null);
    const status: "unknown" | "incomplete" | "measured" = evidence.length === 0 || evidence.some((item) => item.unknown) ? (evidence.length ? "incomplete" : "unknown") : "measured";
    const reconciled = known.filter((item) => item.reconciledUsd !== null);
    return { ...attempt, costEvidence: { ...attempt.costEvidence, status, measuredUsd: known.length ? known.reduce((sum, item) => sum + (item.amountUsd ?? 0), 0) : undefined, reconciledUsd: reconciled.length ? reconciled.reduce((sum, item) => sum + (item.reconciledUsd ?? 0), 0) : undefined, evidenceIds: evidence.map((item) => item.id).slice(0, 100), capturedAt: new Date().toISOString() } };
  });
  return { ...report, attempts, sourceManifest: { ...report.sourceManifest, cost: { scope: costs.scope, period: costs.period, evidenceIds: costs.evidence.map((item) => item.id).slice(0, 500), unknownComponents: costs.unknownComponents, capturedAt: new Date().toISOString() } } };
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
  return hashJson({ gateVersion: report.gateVersion, cutoffAt: report.cutoffAt, stateOwnerIds: report.sourceManifest.stateOwnerIds, stateRows: report.sourceManifest.stateRows.map((row) => ({ ownerId: row.ownerId, revision: row.revision })), cost: report.sourceManifest.cost ? { scope: report.sourceManifest.cost.scope, period: report.sourceManifest.cost.period, evidenceIds: report.sourceManifest.cost.evidenceIds, unknownComponents: report.sourceManifest.cost.unknownComponents } : undefined, attempts: report.attempts.map((attempt) => ({ id: attempt.id, applicationId: attempt.applicationId, events: attempt.events, reviews: attempt.reviews, costEvidence: { ...attempt.costEvidence, capturedAt: undefined } })) });
}

export function ownerPilotReport(report: PilotReportSnapshot, ownerId: string): PilotReportSnapshot {
  return {
    ...report,
    attempts: report.attempts.filter((attempt) => attempt.ownerId === ownerId),
  };
}
