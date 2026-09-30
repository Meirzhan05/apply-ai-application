import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentUserId, isDemo, loadState } from "@/lib/repository";
import { adminSupabase } from "@/lib/supabase-admin";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!/^[a-f0-9-]{36}$/.test(id))
      return new Response("Not found", { status: 404 });
    const userId = await currentUserId();
    const confirmation = new URL(request.url).searchParams.get("phase") === "confirmation";
    const fileName = `${id}${confirmation ? "-confirmation" : ""}.png`;
    const state = await loadState(userId);
    if (
      !state.applications.some(
        (app) =>
          app.id === id && app.userId === userId && (confirmation ? app.submissionReceipt?.screenshotPath : app.form?.screenshotPath),
      )
    )
      return new Response("Not found", { status: 404 });
    let bytes: Buffer;
    if (isDemo())
      bytes = await readFile(
        path.join(process.cwd(), ".data", "screenshots", fileName),
      );
    else {
      const { data, error } = await adminSupabase()
        .storage.from("form-shots")
        .download(`${userId}/${fileName}`);
      if (error || !data) throw error || new Error("Screenshot unavailable.");
      bytes = Buffer.from(await data.arrayBuffer());
    }
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
