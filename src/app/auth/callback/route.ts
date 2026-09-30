import { NextResponse } from "next/server";
import { serverSupabase } from "@/lib/supabase";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  if (tokenHash && ["email", "magiclink", "signup"].includes(type ?? "")) {
    const client = await serverSupabase();
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: type as "email" | "magiclink" | "signup" });
    return NextResponse.redirect(new URL(error ? "/login?error=invalid-link" : "/", url.origin));
  }
  if (!code)
    return NextResponse.redirect(
      new URL("/login?error=missing-code", url.origin),
    );
  const client = await serverSupabase();
  const { error } = await client.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(
    new URL(error ? "/login?error=invalid-link" : "/", url.origin),
  );
}
