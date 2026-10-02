import { task } from "@trigger.dev/sdk";
import { runDocxRuntimeProbe } from "../src/lib/docx-runtime-probe";

export const verifyDocxRuntime = task({
  id: "verify-docx-runtime",
  machine: "medium-1x",
  maxDuration: 180,
  retry: { maxAttempts: 1 },
  run: async () => runDocxRuntimeProbe(),
});
