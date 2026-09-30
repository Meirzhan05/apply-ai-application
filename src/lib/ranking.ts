import type { Job, JobFeedback, MatchAssessment } from "@/lib/types";

const words = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) ?? []);

export function feedbackAdjustment(
  job: Job,
  feedback: JobFeedback[],
  jobs: Job[],
): number {
  const terms = words(`${job.title} ${job.requirements.join(" ")}`);
  let adjustment = 0;
  for (const item of feedback) {
    const previous = item.jobSnapshot ?? jobs.find((candidate) => candidate.id === item.jobId);
    if (!previous) continue;
    const previousTerms = [
      ...words(`${previous.title} ${previous.requirements.join(" ")}`),
    ].filter((term) => term.length > 3);
    const shared = previousTerms.filter((term) => terms.has(term)).length;
    const similar =
      shared >= 2 ||
      (item.reason?.toLowerCase().includes("location") &&
        previous.location === job.location);
    if (similar) adjustment += item.kind === "saved" ? 8 : -8;
  }
  return Math.max(-20, Math.min(20, adjustment));
}

export function compareRankedJobs(
  a: Job, b: Job,
  assessments: ReadonlyMap<string, Pick<MatchAssessment, "score">>,
  feedback: JobFeedback[], jobs: Job[],
): number {
  const score = (job: Job) => (assessments.get(job.id)?.score ?? 0) +
    feedbackAdjustment(job, feedback, jobs) +
    (feedback.find((item) => item.jobId === job.id)?.kind === "saved" ? 15 : 0);
  const difference = score(b) - score(a);
  if (difference) return difference;
  const recent = new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime();
  return Number.isFinite(recent) && recent !== 0 ? recent : a.id.localeCompare(b.id);
}
