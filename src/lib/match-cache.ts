import { hashJson } from "@/lib/crypto";
import type { Job, Profile } from "@/lib/types";

export function matchKey(profile: Profile, job: Job): string {
  return `${job.id}:${hashJson({ policyVersion: 6, profileUpdatedAt: profile.updatedAt, title: job.title, location: job.location, remote: job.remote, deadline: job.deadline, description: job.description, requirements: job.requirements, active: job.active, importStatus: job.importCheck?.status, lastCheckedAt: job.lastCheckedAt })}`;
}

export function matchReservationId(profile: Profile, job: Job): string {
  return `match:${profile.id}:${matchKey(profile, job)}`;
}
