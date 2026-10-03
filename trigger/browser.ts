import { runFill } from "../src/lib/application-runs";
import { runSubmission } from "../src/lib/application-submission";
import { task } from "@trigger.dev/sdk";
import { withAccountOperation } from "../src/lib/account-lifecycle";

export const fillApplicationForm = task({ id: "fill-application-form", retry: { maxAttempts: 1 }, maxDuration: 300, run: async (payload: Parameters<typeof runFill>[0], { ctx }) => withAccountOperation(payload.userId, "worker", () => runFill(payload), ctx.run.id) });
export const submitApplicationForm = task({ id: "submit-application-form", retry: { maxAttempts: 1 }, maxDuration: 300, run: async (payload: Parameters<typeof runSubmission>[0], { ctx }) => withAccountOperation(payload.userId, "worker", () => runSubmission(payload), ctx.run.id) });
