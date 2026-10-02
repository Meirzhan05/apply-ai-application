import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { initialDemoState } from "@/lib/demo-data";
import { meterModelResponse } from "@/lib/model-usage";
const auth = vi.hoisted(() => ({ currentUserId: vi.fn(), loadState: vi.fn() }));
// This is the route's signed-in owner boundary; no operator/user-selected owner is trusted.
vi.mock("@/lib/repository", () => auth);
import { GET } from "@/app/api/usage/route";
beforeEach(() => { auth.currentUserId.mockReset(); auth.loadState.mockReset(); });
it("rejects anonymous usage access before returning private records", async () => {
  auth.currentUserId.mockRejectedValue(new Error("AUTH_REQUIRED"));
  expect((await GET(new Request("https://apply.example/api/usage"))).status).toBe(401);
});
it("shows only the signed-in owner's usage and preserves cancelled application costs", async () => {
  const owner = randomUUID(), other = randomUUID();
  auth.currentUserId.mockResolvedValue(owner);
  const state = initialDemoState();
  state.profile.id = owner;
  state.applications = [{ id: "cancelled-app", userId: owner, jobId: state.jobs[0].id, jobSnapshot: state.jobs[0], status: "cancelled", approvals: [], createdAt: "2026-10-01", updatedAt: "2026-10-01", runs: [{ token: "run", kind: "draft", projectedUsd: 0.2, requestedAt: "2026-10-01" }] }];
  auth.loadState.mockResolvedValue(state);
  await meterModelResponse({ userId: owner, applicationId: "cancelled-app" }, "essay-generation", "gpt-6-sol", async () => ({ id: "owner-response", usage: { input_tokens: 50, output_tokens: 20 } }));
  await meterModelResponse({ userId: other, backgroundJobId: "private-other-job" }, "matching", "gpt-6-luna", async () => ({ id: "other-response" }));
  const response = await GET(new Request("https://apply.example/api/usage"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.records).toHaveLength(1);
  expect(body.records[0]).toMatchObject({ userId: owner, applicationStatus: "cancelled", tokens: { input: 50, output: 20 } });
  expect(body.projectedReservations).toEqual([{ applicationId: "cancelled-app", runId: "run", kind: "draft", projectedUsd: 0.2 }]);
  expect((await GET(new Request(`https://apply.example/api/usage?userId=${other}`))).status).toBe(403);
});

it("allows a configured operator to inspect an owner without accepting client role claims", async () => {
  const operator = randomUUID(), owner = randomUUID();
  auth.currentUserId.mockResolvedValue(operator);
  auth.loadState.mockResolvedValue({ ...initialDemoState(), applications: [] });
  await meterModelResponse({ userId: owner, backgroundJobId: "owner-job" }, "matching", "gpt-6-luna", async () => ({ id: "operator-test-response" }));
  vi.stubEnv("USAGE_OPERATOR_USER_IDS", operator);
  try {
    const response = await GET(new Request(`https://apply.example/api/usage?userId=${owner}`));
    expect(response.status).toBe(200);
    expect((await response.json()).records).toHaveLength(1);
    auth.currentUserId.mockResolvedValue(randomUUID());
    expect((await GET(new Request(`https://apply.example/api/usage?userId=${owner}&operator=true`))).status).toBe(403);
  } finally { vi.unstubAllEnvs(); }
});
