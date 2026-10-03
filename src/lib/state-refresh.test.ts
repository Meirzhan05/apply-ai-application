import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), version: vi.fn(), load: vi.fn(), email: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, loadState: mocks.load, isDemo: () => false }));
vi.mock("@/lib/workspace-version", () => ({ workspaceVersion: mocks.version }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ auth: { admin: { getUserById: mocks.email } } }) }));
vi.mock("@/lib/public-state", () => ({ publicState: (state: unknown) => state }));

import { GET } from "@/app/api/state/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue("owner-a");
  mocks.version.mockResolvedValue('"owner-a-version-1"');
  mocks.load.mockResolvedValue({ profile: { email: "" }, jobs: [] });
  mocks.email.mockResolvedValue({ data: { user: { email: "owner@example.com" } } });
});

it("returns no body and reads no large data when the owner's version has not changed", async () => {
  const response = await GET(new Request("https://apply.example/api/state", { headers: { "If-None-Match": '"owner-a-version-1"' } }));
  expect(response.status).toBe(304);
  expect(await response.text()).toBe("");
  expect(mocks.version).toHaveBeenCalledWith("owner-a");
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.email).not.toHaveBeenCalled();
});

it("sends changed data with a private validator, including when another owner's validator is supplied", async () => {
  const response = await GET(new Request("https://apply.example/api/state", { headers: { "If-None-Match": '"owner-b-version-1"' } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("etag")).toBe('"owner-a-version-1"');
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.load).toHaveBeenCalledWith("owner-a");
  expect((await response.json()).profile.email).toBe("owner@example.com");
});

it("authenticates before considering a supplied validator", async () => {
  mocks.user.mockRejectedValueOnce(new Error("AUTH_REQUIRED"));
  const response = await GET(new Request("https://apply.example/api/state", { headers: { "If-None-Match": '"owner-a-version-1"' } }));
  expect(response.status).toBe(401);
  expect(mocks.version).not.toHaveBeenCalled();
  expect(mocks.load).not.toHaveBeenCalled();
});
