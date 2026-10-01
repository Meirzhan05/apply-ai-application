import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const owner = "18ae0b6f-a1e0-4c3d-aee2-9f235ae742a5";
const user = { id: owner, email: "synthetic@example.com", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" };
const cookieName = "sb-example-auth-token";
const calls: string[] = [];

function token(exp: number) {
  return [JSON.stringify({ alg: "HS256", typ: "JWT" }), JSON.stringify({ sub: owner, exp, aud: "authenticated" }), "synthetic-signature"].map((part) => Buffer.from(part).toString("base64url")).join(".");
}

function request(path: string, expired = true) {
  const expires = expired ? 1 : Math.floor(Date.now() / 1000) + 3600;
  const session = { access_token: token(expires), refresh_token: "synthetic-old-refresh", expires_at: expires, expires_in: 3600, token_type: "bearer", user };
  return new NextRequest(`https://apply.example${path}`, { headers: { cookie: `${cookieName}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` } });
}

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BETA_ALLOWED_EMAILS", user.email);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "synthetic-publishable-key");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("/auth/v1/token?grant_type=refresh_token")) return Response.json({ access_token: token(Math.floor(Date.now() / 1000) + 3600), refresh_token: "synthetic-rotated-refresh", expires_in: 3600, token_type: "bearer", user });
    if (url.endsWith("/auth/v1/user")) return Response.json(user);
    throw new Error(`Unexpected auth transport: ${url}`);
  }));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("renews an expired session through the real SSR client and preserves rotated cookies on login redirect", async () => {
  const incoming = request("/login");
  const response = await proxy(incoming);
  expect(response.headers.get("location")).toBe("https://apply.example/");
  expect(calls.filter((url) => url.includes("grant_type=refresh_token"))).toHaveLength(1);
  expect(calls.some((url) => url.includes("/otp"))).toBe(false);
  const rotated = response.cookies.get(cookieName)!;
  expect(JSON.parse(Buffer.from(rotated.value.slice("base64-".length), "base64url").toString()).refresh_token).toBe("synthetic-rotated-refresh");
  expect(incoming.cookies.get(cookieName)?.value).toBe(rotated.value);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("passes renewed cookies to the requested workspace page without redirecting it to login", async () => {
  const response = await proxy(request("/pilot"));
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.cookies.get(cookieName)).toBeDefined();
  expect(response.headers.get("x-middleware-request-cookie")).toContain("base64-");
});

it("recognizes an existing valid session without asking for a new link or refreshing unnecessarily", async () => {
  const response = await proxy(request("/login", false));
  expect(response.headers.get("location")).toBe("https://apply.example/");
  expect(calls).toEqual(["https://example.supabase.co/auth/v1/user"]);
});

it("does not grant access or redirect into an account when a refresh token has been revoked", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error_code: "refresh_token_not_found", msg: "Refresh token revoked" }, { status: 401 })));
  const response = await proxy(request("/login"));
  expect(response.headers.get("location")).toBeNull();
  expect(response.cookies.get(cookieName)?.value).toBe("");
});

it("leaves signed-out visits alone without calling Auth or sending email", async () => {
  const response = await proxy(new NextRequest("https://apply.example/login"));
  expect(response.headers.get("location")).toBeNull();
  expect(calls).toEqual([]);
});

it("opens the workspace for a signed-in account regardless of the obsolete invitation list", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("BETA_ALLOWED_EMAILS", "invited@example.com");
  const response = await proxy(request("/login", false));
  expect(response.headers.get("location")).toBe("https://apply.example/");
});

it("opens the workspace for a signed-in account without a production invitation list", async () => {
  vi.stubEnv("BETA_ALLOWED_EMAILS", "");
  const response = await proxy(request("/login", false));
  expect(response.headers.get("location")).toBe("https://apply.example/");
});
