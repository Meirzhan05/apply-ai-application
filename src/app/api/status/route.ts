import { currentUserId, loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { hashJson } from "@/lib/crypto";
import { workspaceVersion } from "@/lib/workspace-version";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  let userId: string;
  try { userId = await currentUserId(); }
  catch { return new Response("Sign in required.", { status: 401 }); }
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      let last = request.headers.get("last-event-id") || "";
      const deadline = Date.now() + 50_000;
      const close = () => { if (closed) return; closed = true; clearTimeout(timer); controller.close(); };
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) { close(); return; }
      const poll = async () => {
        if (closed) return;
        try {
          const version = await workspaceVersion(userId);
          if (closed) return;
          if (version && version === last) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } else {
            const state = publicState(await loadState(userId));
            // Demo mode has no database revisions. Ignore local assessment
            // timestamps when comparing its in-memory state.
            const digest = version || hashJson({ ...state, matches: state.matches.map((item) => ({ ...item, assessment: { ...item.assessment, evaluatedAt: "" } })) });
            if (closed) return;
            if (digest !== last) { controller.enqueue(encoder.encode(`id: ${digest}\nevent: state\ndata: ${JSON.stringify(state)}\n\n`)); last = digest; }
            else controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
        } catch { if (!closed) controller.enqueue(encoder.encode('event: error\ndata: {"error":"Status update unavailable."}\n\n')); }
        if (closed) return;
        if (Date.now() >= deadline) { close(); return; }
        timer = setTimeout(poll, 3000);
      };
      await poll();
    },
    cancel() { closed = true; clearTimeout(timer); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
