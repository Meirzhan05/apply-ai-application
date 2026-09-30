import { currentUserId, loadState } from "@/lib/repository";
import { redactedProfile } from "@/lib/jev";

export async function GET() {
  try {
    const state = await loadState(await currentUserId());
    return Response.json((state.matchLabels ?? []).map(({ profile, job, label }) => ({ profile: redactedProfile(profile), job, label })), { headers: { "Cache-Control": "no-store", "Content-Disposition": 'attachment; filename="labeled-pairs.json"' } });
  } catch { return new Response("Sign in to export your labels.", { status: 401 }); }
}
