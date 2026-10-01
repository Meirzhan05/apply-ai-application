import { z } from "zod";
import { currentUserId, mutateState } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { appendPilotReview } from "@/lib/pilot";

export const runtime = "nodejs";

function isOperator(userId: string): boolean {
  return (process.env.USAGE_OPERATOR_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean).includes(userId);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  let reviewerId: string;
  try { reviewerId = await currentUserId(); } catch { return Response.json({ error: "Sign in to review the pilot." }, { status: 401 }); }
  if (!isOperator(reviewerId)) return Response.json({ error: "Only a configured pilot operator may review attempts." }, { status: 403 });
  try {
    const input = z.object({ ownerId: z.string().min(1), applicationId: z.string().min(1), evidenceDigest: z.string().length(64), suitability: z.enum(["pass", "fail", "insufficient"]), factualAccuracy: z.enum(["pass", "fail", "insufficient", "not-applicable"]), notes: z.string().max(1000).default(""), rubricVersion: z.string().max(80).optional() }).parse(await request.json());
    await mutateState(input.ownerId, (state) => appendPilotReview(state, reviewerId, input), { actor: { kind: "operator", userId: reviewerId }, action: "pilotReview" });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Pilot review could not be saved." }, { status: 400 });
  }
}
