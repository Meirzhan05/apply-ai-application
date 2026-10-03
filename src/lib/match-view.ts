import type { Job, JobFeedback, MatchAssessment } from "@/lib/types";

export type MatchFilter = "all" | "strong" | "possible" | "uncertain";
export type MatchCollection = "all" | "saved" | "dismissed";

export function matchView({ jobs, matches, feedback, filter, collection = "all", search }: {
  jobs: Job[];
  matches: ReadonlyMap<string, Pick<MatchAssessment, "category">>;
  feedback: ReadonlyMap<string, Pick<JobFeedback, "kind">>;
  filter: MatchFilter;
  collection?: MatchCollection;
  search: string;
}) {
  const available = jobs.filter(job => job.active && feedback.get(job.id)?.kind !== "dismissed");
  const terms = search.trim().toLowerCase().split(/\s+/);
  const searched = jobs.filter(job => job.active && terms.every(term => `${job.title} ${job.company}`.toLowerCase().includes(term)));
  const belongs = (job: Job, category: MatchFilter) => category === "all" || matches.get(job.id)?.category === category;
  const inCollection = (job: Job, scope: MatchCollection) => scope === "dismissed" ? feedback.get(job.id)?.kind === "dismissed" :
    feedback.get(job.id)?.kind !== "dismissed" && (scope === "all" || feedback.get(job.id)?.kind === "saved");
  const scoped = searched.filter(job => inCollection(job, collection));
  const counts: Record<MatchFilter, number> = { all: 0, strong: 0, possible: 0, uncertain: 0 };
  for (const category of ["all", "strong", "possible", "uncertain"] as const) counts[category] = scoped.filter(job => belongs(job, category)).length;
  const collections: Record<MatchCollection, number> = { all: 0, saved: 0, dismissed: 0 };
  for (const scope of ["all", "saved", "dismissed"] as const) collections[scope] = searched.filter(job => inCollection(job, scope) && belongs(job, filter)).length;
  return { jobs: scoped.filter(job => belongs(job, filter)), counts, collections, availableCount: available.length };
}
