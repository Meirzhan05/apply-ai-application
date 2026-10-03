import { expect, it } from "vitest";
import { discoveryStatus } from "./discovery-status";

it("distinguishes demo, unknown and first-check states", () => {
  expect(discoveryStatus(undefined, true)).toContain("no live source checks");
  expect(discoveryStatus(undefined, false)).toBe("Source check status is unavailable");
  expect(discoveryStatus({ sources: [], events: [] }, false)).toBe("Waiting for the first source check");
});

it("keeps failures visible without a timestamp and reports hours rather than workspace freshness", () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  const state = { sources: [{ source: "board", status: "unavailable" as const, checkedAt: "" }], events: [] };
  expect(discoveryStatus(state, false, now)).toBe("1 of 1 sources unavailable · Check time not reported");
  expect(discoveryStatus({ ...state, lastRefreshAt: "2026-10-03T08:00:00Z" }, false, now)).toBe("1 of 1 sources unavailable · Sources last checked 2 hours ago");
});
