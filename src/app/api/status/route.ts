import { currentUserId, loadState } from "@/lib/repository";
import { publicState } from "@/lib/public-state";
import { hashJson } from "@/lib/crypto";

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
      let last = "";
      const deadline = Date.now() + 50_000;
      const close = () => { if (closed) return; closed = true; clearTimeout(timer); controller.close(); };
      request.signal.addEventListener("abort", close, { once: true });
      const poll = async () => {
        if (closed) return;
        try {
          const state = publicState(await loadState(userId));
          // Avoid time-dependent local assessment timestamps causing a stream
          // event when no persisted application or catalog data changed.
          const digest = hashJson({ ...state, matches: state.matches.map((item) => ({ ...item, assessment: { ...item.assessment, evaluatedAt: "" } })) });
          if (digest !== last) { controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(state)}\n\n`)); last = digest; }
          else controller.enqueue(encoder.encode(": keepalive\n\n"));
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
