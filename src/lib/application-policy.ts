import { explicitConflict } from "@/lib/matching";
import type { Job, Profile } from "@/lib/types";

export class ApplicationEligibilityError extends Error {
  constructor(message: string) { super(message); this.name = "ApplicationEligibilityError"; }
}

export function assertJobEligible(profile: Profile, job: Job | undefined): Job {
  if (!job) throw new ApplicationEligibilityError("The job is no longer available.");
  const conflict = explicitConflict(profile, job);
  if (conflict) throw new ApplicationEligibilityError(conflict);
  return job;
}
