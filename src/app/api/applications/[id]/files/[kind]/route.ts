import { currentUserId, loadState } from "@/lib/repository";
import { validatePacket } from "@/lib/drafting";
import { reviewedPacketFile, reviewedResumeSource } from "@/lib/packet-files";

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
    if (!app?.packet) return new Response("Not found", { status: 404 });
    validatePacket(state.profile, app.packet);
    if (kind === "cover-letter" && !app.packet.coverLetter)
      return new Response("Not found", { status: 404 });
    const file = kind === "resume-source" ? await reviewedResumeSource(state.profile, app.packet) : await reviewedPacketFile(state.profile, app.packet, kind as "resume" | "cover-letter");
    const download = kind === "resume-source" || new URL(_request.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
