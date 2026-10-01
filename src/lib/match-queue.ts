import { tasks } from "@trigger.dev/sdk";
import type { assessUserMatches } from "../../trigger/matches";

export function queueMatchAssessment(userId: string, continuationToken?: string) {
  // The task limit of one applies to this owner's queue. Profile changes and
  // catalog refreshes cannot assess the same uncached jobs in parallel.
  return tasks.trigger<typeof assessUserMatches>("assess-user-matches", continuationToken ? { userId, continuationToken } : { userId }, { concurrencyKey: userId });
}
