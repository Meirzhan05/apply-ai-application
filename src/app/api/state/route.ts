import { NextResponse } from "next/server";
import { currentUserId, loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/repository";
import { workspaceVersion } from "@/lib/workspace-version";

export async function GET(request?: Request) {
  try {
    const userId = await currentUserId();
    const version = await workspaceVersion(userId);
    const headers: Record<string, string> = { "Cache-Control": "private, no-store", Vary: "Cookie" };
    if (version) headers.ETag = version;
    if (version && request?.headers.get("if-none-match") === version) {
      return new Response(null, { status: 304, headers });
    }
    const state = await loadState(userId);
    if (!isDemo()) {
      const { data } = await adminSupabase().auth.admin.getUserById(userId);
      state.profile.email = data.user?.email || "";
    }
    return NextResponse.json(publicState(state), {
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load your workspace.",
      },
      { status: 401 },
    );
  }
}
