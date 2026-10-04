import { task } from "@trigger.dev/sdk";
import { withAccountOperation } from "../src/lib/account-lifecycle";
import { runResumeExtraction } from "../src/lib/resume-extraction-jobs";

export const extractUploadedResume = task({
  id: "extract-uploaded-resume",
  machine: "small-1x",
  retry: { maxAttempts: 2, minTimeoutInMs: 1500, maxTimeoutInMs: 5000 },
  maxDuration: 540,
  run: async (payload: Parameters<typeof runResumeExtraction>[0], { ctx }) =>
    withAccountOperation(payload.userId, "worker", () => runResumeExtraction(payload), ctx.run.id),
});
