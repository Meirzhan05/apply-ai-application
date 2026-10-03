import { NextResponse } from "next/server";
import { deleteAccount } from "@/lib/account-deletion";
import { currentUserId, isDemo } from "@/lib/repository";
import { serverSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

function sameOriginRequired(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

export async function DELETE(request: Request) {
  if (!sameOriginRequired(request)) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  if (isDemo()) return NextResponse.json({ error: "Account deletion is unavailable in demo mode." }, { status: 403 });

  let input: unknown;
  try { input = await request.json(); }
  catch { return NextResponse.json({ error: "Type DELETE to confirm account removal." }, { status: 400 }); }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 1 || (input as { confirmation?: unknown }).confirmation !== "DELETE") {
    return NextResponse.json({ error: "Type DELETE to confirm account removal." }, { status: 400 });
  }

  let ownerId: string;
  let accessToken: string;
  try {
    ownerId = await currentUserId();
    const { data, error } = await (await serverSupabase()).auth.getSession();
    if (error || !data.session?.access_token) throw new Error("AUTH_REQUIRED");
    accessToken = data.session.access_token;
  } catch {
    return NextResponse.json({ error: "Sign in to remove your account." }, { status: 401 });
  }

  try {
    await deleteAccount(ownerId, accessToken);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Account removal could not be completed. Retry to continue safely." }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true });
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (!name.startsWith("sb-")) continue;
    response.cookies.set(name, "", { path: "/", maxAge: 0, expires: new Date(0), httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  }
  return response;
}
