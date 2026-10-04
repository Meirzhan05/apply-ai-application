import { ensureResumeExtraction } from "@/lib/resume-extraction-jobs";
import { NextResponse } from "next/server";
import { currentUserId, isDemo, loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { workspaceVersion } from "@/lib/workspace-version";
import { adminSupabase } from "@/lib/supabase-admin";

export async function GET(request: Request) {
  try {
    const userId = await currentUserId();
    const version = await workspaceVersion(userId);
    const headers: Record<string, string> = { "Cache-Control": "private, no-store", Vary: "Cookie" };
    if (version) headers.ETag = version;
    if (version && request?.headers.get("if-none-match") === version) {
      return new Response(null, { status: 304, headers });
    }
    let state = await loadState(userId);
    if (await ensureResumeExtraction(userId, state.profile)) state = await loadState(userId);
    if (!isDemo()) {
      const { data } = await adminSupabase().auth.admin.getUserById(userId);
      state.profile.email = data.user?.email || "";
    }
    return NextResponse.json({ ...publicState(state), demoMode: isDemo() }, {
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
