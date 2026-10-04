import { importedAutonomyJob } from "@/lib/import-compatibility";
import { sourceJobHash } from "@/lib/resume-source-draft";
import type { Application, Job } from "@/lib/types";

export function normalizedSourceJobHash(application: Application, job: Job): string {
  const normalizedJob = importedAutonomyJob(application, job);
  return sourceJobHash(normalizedJob, 2);
}

export function sourcePlanJobIsCurrent(application: Application, job: Job, expectedJobHash = application.packet?.resumeSourcePlan?.jobHash,
  policyVersion: 1 | 2 = application.packet?.resumeSourcePlan?.jobHashPolicyVersion ?? 1): boolean {
  if (!expectedJobHash) return !application.packet || !application.jobSnapshot || application.jobSnapshot.location === job.location;
  return sourceJobHash(importedAutonomyJob(application, job), policyVersion) === expectedJobHash;
}

export function assertSourceJobCurrent(application: Application, job: Job, expectedJobHash = application.packet?.resumeSourcePlan?.jobHash,
  policyVersion: 1 | 2 = application.packet?.resumeSourcePlan?.jobHashPolicyVersion ?? 1): void {
  if (!sourcePlanJobIsCurrent(application, job, expectedJobHash, policyVersion)) {
    if (!expectedJobHash) throw new Error("The job destination changed. Prepare and review new application materials before filling.");
    throw new Error("The source résumé plan is stale because the effective job details or verification changed. Prepare a new résumé draft before review or attachment.");
  }
}
