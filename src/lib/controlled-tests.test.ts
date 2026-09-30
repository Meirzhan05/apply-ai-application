import { afterEach, describe, expect, it, vi } from "vitest";
import { issueControlledTestGrant, verifyControlledTestGrant } from "@/lib/controlled-tests";

const owner = "bcd5ea6e-12f3-4768-a09f-fc5bc892b48a";
const app = "d7b8253c-a80c-48a2-b64a-944d00b8a5ea";
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("controlled cloud test grants", () => {
  it("binds a short-lived grant to one owner and application", () => {
    vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-private-test-secret");
    const { token, grant } = issueControlledTestGrant(owner, app);
    expect(verifyControlledTestGrant(token)).toEqual(grant);
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
  });
  it("rejects tampering and another signing key", () => {
    vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-private-test-secret");
    const { token } = issueControlledTestGrant(owner, app);
    expect(verifyControlledTestGrant(`x${token}`)).toBeNull();
    vi.stubEnv("INTERNAL_TASK_SECRET", "different-private-test-secret");
    expect(verifyControlledTestGrant(token)).toBeNull();
  });
  it("rejects expiry and absent configuration", () => {
    vi.useFakeTimers();
    vi.stubEnv("INTERNAL_TASK_SECRET", "synthetic-private-test-secret");
    const { token } = issueControlledTestGrant(owner, app);
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(verifyControlledTestGrant(token)).toBeNull();
    vi.stubEnv("INTERNAL_TASK_SECRET", "");
    expect(verifyControlledTestGrant(token)).toBeNull();
  });
});
