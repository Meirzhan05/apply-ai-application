import { currentUserId, loadState } from "@/lib/repository";
import { historicalPacketFile } from "@/lib/packet-files";

export const runtime = "nodejs";

function isOperator(userId: string): boolean {
  return (process.env.USAGE_OPERATOR_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean).includes(userId);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ownerId: string; applicationId: string; kind: string }> },
) {
  try {
    const reviewerId = await currentUserId();
    if (!isOperator(reviewerId)) return new Response("Not found", { status: 404 });
    const { ownerId, applicationId, kind } = await params;
    if (!ownerId || !applicationId || !["resume", "cover-letter"].includes(kind)) return new Response("Not found", { status: 404 });
    const state = await loadState(ownerId);
    const app = state.applications.find((item) => item.id === applicationId && item.userId === ownerId);
    const file = app?.submissionAttemptedAt ? app.submissionMaterials?.files.find((item) => item.kind === kind) : undefined;
    if (!file) return new Response("Not found", { status: 404 });
    const material = await historicalPacketFile(ownerId, file);
    return new Response(new Uint8Array(material.bytes), { headers: { "Content-Type": material.mimeType, "Content-Disposition": `attachment; filename="${kind}.pdf"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
