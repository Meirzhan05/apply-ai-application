import { adminSupabase } from "@/lib/supabase-admin";
import { mutateState, loadState, isDemo } from "@/lib/repository";
import { newId } from "@/lib/crypto";
import { sendActionNeeded } from "@/lib/email";
import { recoverStaleRuns } from "@/lib/run-recovery";
import { cancelBrowser } from "@/lib/browser-runner";
import { dispatchUserQueue } from "@/lib/application-queue";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  const { data, error } = isDemo() ? { data: [{ user_id: "demo-user" }], error: null } : await adminSupabase().from("app_states").select("user_id").limit(1000);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  let marked = 0;
  for (const row of data ?? []) {
    const closed = await mutateState(row.user_id, (current) => {
      const recovered = recoverStaleRuns(current);
      for (const app of recovered) current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Run needs review", detail: current.applications.find((item) => item.id === app.id)!.error! });
      return recovered;
    });
    marked += closed.length;
    for (const app of closed) await cancelBrowser(app).catch(() => undefined);
    if (closed.length) {
      if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) await sendActionNeeded(await loadState(row.user_id), "An application run needs your review").catch(() => undefined);
      await dispatchUserQueue(row.user_id);
    }
  }
  return Response.json({ marked });
}
