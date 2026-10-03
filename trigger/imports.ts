import { task } from "@trigger.dev/sdk";
import { loadState, mutateState } from "../src/lib/repository";
import { applyImportedRefresh, refreshImportedJobs } from "../src/lib/import-jobs";
import { queueMatchAssessment } from "../src/lib/match-queue";
import { withAccountOperation } from "../src/lib/account-lifecycle";

export const refreshUserImports = task({
  id: "refresh-user-imported-jobs",
  retry: { maxAttempts: 1 }, queue: { concurrencyLimit: 1 }, maxDuration: 600,
  run: async ({ userId }: { userId: string }, { ctx }) => withAccountOperation(userId, "worker", async () => {
    const state = await loadState(userId);
    const before = state.importedJobs ?? [];
    if (!before.length) return { checked: 0 };
    const refreshed = await refreshImportedJobs(before);
    try {
      const checked = await mutateState(userId, (current) => applyImportedRefresh(current, before, refreshed));
      if (process.env.OPENAI_API_KEY) await queueMatchAssessment(userId);
      return { checked, verified: refreshed.filter((job) => job.importCheck?.status === "verified").length,
        closed: refreshed.filter((job) => job.importCheck?.status === "closed").length,
        unavailable: refreshed.filter((job) => job.importCheck?.status === "unavailable").length };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23503" &&
        "message" in error && typeof error.message === "string" && error.message.includes('"app_states_user_id_fkey"'))
        return { checked: 0, stopped: "owner_removed" };
      throw error;
    }
  }, ctx.run.id),
});
