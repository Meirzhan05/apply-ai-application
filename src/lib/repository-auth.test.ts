import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentUserId } from "./repository";

const cookies = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({ cookies: async () => ({
  getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
  set: (name: string, value: string) => cookies.set(name, value),
}) }));

const owner = "18ae0b6f-a1e0-4c3d-aee2-9f235ae742a5";
const user = { id: owner, email: "synthetic@example.com", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" };

beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BETA_ALLOWED_EMAILS", "");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "synthetic-publishable-key");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = [JSON.stringify({ alg: "HS256", typ: "JWT" }), JSON.stringify({ sub: owner, exp: expires, aud: "authenticated" }), "synthetic-signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");
  cookies.clear();
  cookies.set("sb-example-auth-token", `base64-${Buffer.from(JSON.stringify({ access_token: accessToken, refresh_token: "synthetic-refresh", expires_at: expires, token_type: "bearer", user })).toString("base64url")}`);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/auth/v1/user")) return Response.json(user);
    throw new Error(`Unexpected auth transport: ${url}`);
  }));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); cookies.clear(); });

it("admits a verified production account without an email invitation list", async () => {
  expect(await currentUserId()).toBe(owner);
});

it("ignores an obsolete invitation list excluding the verified account", async () => {
  vi.stubEnv("BETA_ALLOWED_EMAILS", "previous-invite@example.com");
  expect(await currentUserId()).toBe(owner);
});

it("still rejects signed-out production requests", async () => {
  cookies.clear();
  await expect(currentUserId()).rejects.toThrow("AUTH_REQUIRED");
  expect(fetch).not.toHaveBeenCalled();
});

it("still rejects a stored session that Auth no longer validates", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ msg: "Invalid JWT", error_code: "bad_jwt" }, { status: 401 })));
  await expect(currentUserId()).rejects.toThrow("AUTH_REQUIRED");
});
