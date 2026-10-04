import { task } from "@trigger.dev/sdk";
import { probeResumeFeedback } from "../src/lib/resume-feedback-probe";

export const verifyResumeFeedback = task({
  id: "verify-resume-feedback", retry: { maxAttempts: 1 }, maxDuration: 120,
  run: async (payload: Record<string, never>) => {
    if (Object.keys(payload).length) throw new Error("The feedback check accepts no input.");
    return { cases: await probeResumeFeedback() };
  },
});
