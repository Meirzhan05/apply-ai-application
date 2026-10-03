import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  isDemo: vi.fn(),
  serverSupabase: vi.fn(),
  deleteAccount: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@/lib/repository", () => ({ currentUserId: mocks.currentUserId, isDemo: mocks.isDemo }));
vi.mock("@/lib/supabase", () => ({ serverSupabase: mocks.serverSupabase }));
vi.mock("@/lib/account-deletion", () => ({ deleteAccount: mocks.deleteAccount }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import { DELETE } from "@/app/api/account/delete/route";

const url = "https://app.example.test/api/account/delete";
function request(body: unknown, options: { origin?: string; cookie?: string } = {}) {
  return new Request(url, {
    method: "DELETE",
    headers: {
      ...(options.origin !== undefined ? { Origin: options.origin } : { Origin: "https://app.example.test" }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isDemo.mockReturnValue(false);
  mocks.currentUserId.mockResolvedValue("123e4567-e89b-42d3-a456-426614174000");
  mocks.serverSupabase.mockResolvedValue({ auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "signed-in-token" } }, error: null }) } });
  mocks.deleteAccount.mockResolvedValue(undefined);
  mocks.cookies.mockResolvedValue({ getAll: () => [{ name: "sb-project-auth-token" }, { name: "theme" }] });
});

describe("DELETE /api/account/delete", () => {
  it("rejects missing or foreign origins before reading identity", async () => {
    expect((await DELETE(request({ confirmation: "DELETE" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await DELETE(request({ confirmation: "DELETE" }, { origin: "" }))).status).toBe(403);
    expect(mocks.currentUserId).not.toHaveBeenCalled();
  });

  it("requires the exact typed confirmation and rejects owner identifiers", async () => {
    for (const body of [{ confirmation: "delete" }, {}, { confirmation: "DELETE", userId: "somebody-else" }]) {
      expect((await DELETE(request(body))).status).toBe(400);
    }
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("does not route demo users to the real deletion service", async () => {
    mocks.isDemo.mockReturnValue(true);
    expect((await DELETE(request({ confirmation: "DELETE" }))).status).toBe(403);
    expect(mocks.currentUserId).not.toHaveBeenCalled();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("requires a fresh authenticated session", async () => {
    mocks.currentUserId.mockRejectedValue(new Error("AUTH_REQUIRED"));
    const response = await DELETE(request({ confirmation: "DELETE" }));
    expect(response.status).toBe(401);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes only the current owner and expires Supabase cookies after success", async () => {
    const response = await DELETE(request({ confirmation: "DELETE" }, { cookie: "sb-project-auth-token=old" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.deleteAccount).toHaveBeenCalledWith("123e4567-e89b-42d3-a456-426614174000", "signed-in-token");
    expect(response.headers.get("set-cookie")).toContain("sb-project-auth-token=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).not.toContain("theme=");
  });

  it("returns a retryable error and retains cookies when cleanup is incomplete", async () => {
    mocks.deleteAccount.mockRejectedValue(new Error("Storage could not be verified; retry."));
    const response = await DELETE(request({ confirmation: "DELETE" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "Storage could not be verified; retry." });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
