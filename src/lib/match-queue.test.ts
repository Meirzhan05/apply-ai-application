import { describe, expect, it, vi } from "vitest";
import { queueMatchAssessment } from "@/lib/match-queue";

const trigger = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "synthetic-run" }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger } }));

describe("owner match queues", () => {
  it("uses the authenticated owner's concurrency key for every assessment request", async () => {
    await Promise.all([queueMatchAssessment("owner-a"), queueMatchAssessment("owner-a"), queueMatchAssessment("owner-b")]);
    expect(trigger.mock.calls).toEqual([
      ["assess-user-matches", { userId: "owner-a" }, { concurrencyKey: "owner-a", tags: ["owner:owner-a"] }],
      ["assess-user-matches", { userId: "owner-a" }, { concurrencyKey: "owner-a", tags: ["owner:owner-a"] }],
      ["assess-user-matches", { userId: "owner-b" }, { concurrencyKey: "owner-b", tags: ["owner:owner-b"] }],
    ]);
  });
});
