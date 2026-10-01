import { currentUserId, loadState } from "@/lib/repository";
import { validatePacket } from "@/lib/drafting";
import { historicalPacketFile, reviewedPacketFile, reviewedResumeSource } from "@/lib/packet-files";

export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  try {
    const { id, kind } = await params;
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !["resume", "cover-letter", "resume-source"].includes(kind)
    )
      return new Response("Not found", { status: 404 });
    const userId = await currentUserId();
    const state = await loadState(userId);
    const app = state.applications.find(
      (item) => item.id === id && item.userId === userId,
    );
    if (!app) return new Response("Not found", { status: 404 });
    const historical = app.submissionAttemptedAt ? app.submissionMaterials?.files.find((file) => file.kind === kind) : undefined;
    if (!historical && !app.packet) return new Response("Not found", { status: 404 });
    if (!historical) validatePacket(state.profile, app.packet!);
    if (!historical && kind === "cover-letter" && !app.packet!.coverLetter)
      return new Response("Not found", { status: 404 });
    const file = historical ? await historicalPacketFile(userId, historical) : kind === "resume-source" ? await reviewedResumeSource(state.profile, app.packet!) : await reviewedPacketFile(state.profile, app.packet!, kind as "resume" | "cover-letter");
    const download = file.mimeType !== "application/pdf" || kind === "resume-source" || new URL(_request.url).searchParams.get("download") === "1";
    const dispositionFilename = /^[a-zA-Z0-9_.-]+$/.test(file.filename) ? `filename="${file.filename}"` : `filename*=UTF-8''${encodeURIComponent(file.filename)}`;
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${download ? "attachment" : "inline"}; ${dispositionFilename}`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
