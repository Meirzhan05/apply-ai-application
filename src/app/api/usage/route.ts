import { currentUserId } from "@/lib/repository";
import { ownerUsageView } from "@/lib/usage-view";
import { isConfiguredOperator } from "@/lib/pilot-authorization";

export const runtime = "nodejs";
export async function GET(request: Request) {
  let userId: string;
  try { userId = await currentUserId(); }
  catch { return Response.json({ error: "Sign in to inspect your usage." }, { status: 401, headers: { "Cache-Control": "no-store" } }); }
  // Ownership comes only from verified server authentication. Cross-owner reads require explicit server-configured operator authorization.
  const requestedOwner = new URL(request.url).searchParams.get("userId");
  const operator = isConfiguredOperator(userId);
  if (requestedOwner && requestedOwner !== userId && !operator) return Response.json({ error: "Usage belongs to the signed-in account." }, { status: 403 });
  try { return Response.json(await ownerUsageView(requestedOwner || userId), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Usage could not be loaded. Try again." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
