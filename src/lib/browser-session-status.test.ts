import { describe, expect, it } from "vitest";
import { browserSessionAvailable } from "@/lib/browser-session-status";

describe("browser recovery availability", () => {
  const now = Date.parse("2026-10-03T01:00:00Z");
  it("does not offer takeover without a session", () => {
    expect(browserSessionAvailable(undefined, now)).toBe(false);
    expect(browserSessionAvailable({}, now)).toBe(false);
  });
  it("treats an expired or unreadable deadline as unavailable even with a session id", () => {
    for (const deadline of ["2026-10-03T00:59:59Z", "2026-10-03T01:00:00Z", "invalid"])
      expect(browserSessionAvailable({ browserSessionId: "saved", browserSessionExpiresAt: deadline }, now)).toBe(false);
  });
  it("allows a current session and legacy sessions without a recorded deadline", () => {
    expect(browserSessionAvailable({ browserSessionId: "live", browserSessionExpiresAt: "2026-10-03T01:01:00Z" }, now)).toBe(true);
    expect(browserSessionAvailable({ browserSessionId: "legacy" }, now)).toBe(true);
  });
});
