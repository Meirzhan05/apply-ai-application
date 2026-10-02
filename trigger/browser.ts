import { runFill } from "../src/lib/application-runs";
import { runSubmission } from "../src/lib/application-submission";
import { task } from "@trigger.dev/sdk";

export const fillApplicationForm = task({ id: "fill-application-form", retry: { maxAttempts: 1 }, maxDuration: 300, run: runFill });
export const submitApplicationForm = task({ id: "submit-application-form", retry: { maxAttempts: 1 }, maxDuration: 300, run: runSubmission });
