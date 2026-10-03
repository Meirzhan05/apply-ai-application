import { task } from "@trigger.dev/sdk";
import { withAccountOperation } from "../src/lib/account-lifecycle";
import { withModelUsageContext } from "../src/lib/model-usage";
import { runPersonalSearch } from "../src/lib/personal-search";

export const discoverUserJobs = task({
  id: "discover-user-jobs", retry: { maxAttempts: 1 }, queue: { concurrencyLimit: 1 }, maxDuration: 300,
  run: async ({ userId, requestId }: { userId: string; requestId: string }, { ctx }) =>
    withAccountOperation(userId, "worker", () => withModelUsageContext({ userId, runId: ctx.run.id, backgroundJobId: ctx.run.id },
      () => runPersonalSearch(userId, requestId)), ctx.run.id),
});
