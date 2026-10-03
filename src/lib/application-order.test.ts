import { expect, it } from "vitest";
import { compareApplications } from "./application-order";
it("orders recent activity within a stage while retaining stage groups", () => {
  const old = { status: "draft_review" as const, updatedAt: "2026-10-01T00:00:00Z" };
  const recent = { status: "draft_review" as const, updatedAt: "2026-10-02T00:00:00Z" };
  expect(compareApplications(old, recent, "stage")).toBe(0);
  expect(compareApplications(old, recent, "recent")).toBeGreaterThan(0);
  expect(compareApplications(old, { status: "submitted", updatedAt: "2026-10-03T00:00:00Z" }, "recent")).toBeLessThan(0);
});
it("keeps stable ordering for equal or unavailable timestamps", () => {
  const app = { status: "selected" as const, updatedAt: "unavailable" };
  expect(compareApplications(app, app, "recent")).toBe(0);
});
