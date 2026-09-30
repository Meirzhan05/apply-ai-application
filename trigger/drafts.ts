import { task } from "@trigger.dev/sdk";
import { runDraft } from "../src/lib/application-runs";

export const draftApplicationPacket = task({
  id: "draft-application-packet",
  retry: { maxAttempts: 1 },
  maxDuration: 600,
  run: runDraft,
});
