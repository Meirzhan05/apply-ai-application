import type { Job, JobFeedback, MatchAssessment } from "@/lib/types";

export type MatchFilter = "all" | "strong" | "possible" | "uncertain" | "saved" | "dismissed";

export function matchView({ jobs, matches, feedback, filter, search }: {
  jobs: Job[];
  matches: ReadonlyMap<string, Pick<MatchAssessment, "category">>;
  feedback: ReadonlyMap<string, Pick<JobFeedback, "kind">>;
  filter: MatchFilter;
  search: string;
}) {
  const available = jobs.filter(job => job.active && feedback.get(job.id)?.kind !== "dismissed");
  const terms = search.trim().toLowerCase().split(/\s+/);
  const searched = available.filter(job => terms.every(term => `${job.title} ${job.company}`.toLowerCase().includes(term)));
  const dismissed = jobs.filter(job => job.active && feedback.get(job.id)?.kind === "dismissed" && terms.every(term => `${job.title} ${job.company}`.toLowerCase().includes(term)));
  const belongs = (job: Job, category: MatchFilter) => category === "all" ||
    (category === "saved" ? feedback.get(job.id)?.kind === "saved" : matches.get(job.id)?.category === category);
  const counts: Record<MatchFilter, number> = { all: 0, strong: 0, possible: 0, uncertain: 0, saved: 0, dismissed: dismissed.length };
  for (const category of ["all", "strong", "possible", "uncertain", "saved"] as const) counts[category] = searched.filter(job => belongs(job, category)).length;
  return { jobs: filter === "dismissed" ? dismissed : searched.filter(job => belongs(job, filter)), counts, availableCount: available.length };
}
