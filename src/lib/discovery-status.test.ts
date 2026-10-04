import { expect, it } from "vitest";
import { checkAge, discoveryStatus } from "./discovery-status";

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

it("reports precise check age at minute/hour/day boundaries and handles bad or future timestamps", () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  expect(checkAge("2026-10-03T09:59:30Z", now)).toBe("just now");
  expect(checkAge("2026-10-03T09:59:00Z", now)).toBe("1 minute ago");
  expect(checkAge("2026-10-03T09:01:00Z", now)).toBe("59 minutes ago");
  expect(checkAge("2026-10-03T09:00:00Z", now)).toBe("1 hour ago");
  expect(checkAge("2026-10-03T06:00:00Z", now)).toBe("4 hours ago");
  expect(checkAge("2026-10-02T10:00:00Z", now)).toBe("yesterday");
  expect(checkAge("2026-10-03T11:00:00Z", now)).toBe("just now");
  expect(checkAge("invalid", now)).toBe("time unavailable");
});
