import { task } from "@trigger.dev/sdk";
import { runDraft } from "../src/lib/application-runs";
import { withAccountOperation } from "../src/lib/account-lifecycle";

export const draftApplicationPacket = task({
  id: "draft-application-packet",
  machine: "medium-1x",
  retry: { maxAttempts: 1 },
  maxDuration: 600,
  run: async (payload: Parameters<typeof runDraft>[0], { ctx }) => withAccountOperation(payload.userId, "worker", () => runDraft(payload), ctx.run.id),
});
