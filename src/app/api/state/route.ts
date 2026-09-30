import { NextResponse } from "next/server";
import { currentUserId, loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/repository";

export async function GET() {
  try {
    const userId = await currentUserId();
    const state = await loadState(userId);
    if (!isDemo()) {
      const { data } = await adminSupabase().auth.admin.getUserById(userId);
      state.profile.email = data.user?.email || "";
    }
    return NextResponse.json(publicState(state), {
      headers: { "Cache-Control": "no-store" },
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
