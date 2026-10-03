import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";

const mocks = vi.hoisted(() => ({ user: vi.fn(), state: vi.fn(), mutate: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, isDemo: () => true, loadState: mocks.state, mutateState: mocks.mutate }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));

import { GET, POST } from "@/app/api/pilot/route";

beforeEach(() => {
  mocks.user.mockReset();
  mocks.state.mockReset();
  mocks.mutate.mockReset();
  mocks.user.mockResolvedValue("owner-a");
  mocks.state.mockResolvedValue(initialDemoState() as AppState);
  vi.unstubAllEnvs();
});

it("returns a signed-in owner's pilot report and rejects a forged cross-owner read", async () => {
  expect((await GET(new Request("http://localhost/api/pilot"))).status).toBe(200);
  expect((await GET(new Request("http://localhost/api/pilot?userId=owner-b"))).status).toBe(403);
});

it("keeps report capture operator-only and same-origin protected", async () => {
  const body = JSON.stringify({});
  expect((await POST(new Request("http://localhost/api/pilot", { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body }))).status).toBe(403);
  expect((await POST(new Request("http://localhost/api/pilot", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body }))).status).toBe(403);
  vi.stubEnv("USAGE_OPERATOR_USER_IDS", "owner-a");
  expect((await POST(new Request("http://localhost/api/pilot", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body }))).status).toBe(201);
});
