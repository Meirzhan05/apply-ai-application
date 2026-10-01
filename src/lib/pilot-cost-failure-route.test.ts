import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";

const mocks = vi.hoisted(() => ({ user: vi.fn(), costReport: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, isDemo: () => true, loadState: async () => initialDemoState() }));
vi.mock("@/lib/service-costs", () => ({ costReport: mocks.costReport }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: vi.fn() }));

import { GET } from "@/app/api/pilot/route";

beforeEach(() => {
  mocks.user.mockResolvedValue("owner-a");
  mocks.costReport.mockRejectedValue(new Error("cost ledger temporarily unavailable"));
});

it("keeps the public report usable with an explicit unknown-cost state when the ledger transport fails", async () => {
  const response = await GET(new Request("http://localhost/api/pilot"));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.sourceManifest.cost).toEqual(expect.objectContaining({ complete: false, unknownComponents: 1 }));
  expect(body.totals.unknownCosts).toBe(body.attempts.length);
  expect(body.sourceManifest.cost.error).toContain("cost ledger temporarily unavailable");
});
