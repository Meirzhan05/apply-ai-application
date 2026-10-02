import { currentUserId, loadState } from "@/lib/repository";
import { originalResumeManifest, readOriginalResume } from "@/lib/original-resume";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import { validatePacket } from "@/lib/drafting";
import { historicalPacketFile, reviewedPacketFile, reviewedResumeComparisonFiles, reviewedResumeSource } from "@/lib/packet-files";
import { sourceJobHash } from "@/lib/resume-source-draft";

const comparisonKinds = new Set(["resume-original-preview", "resume-tailored-preview", "resume-comparison-status"]);
const sourceKinds = new Set(["resume-original"]);
function originalResumeMimeType(format: string) {
  return format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function fileResponse(file: { bytes: Buffer; filename: string; mimeType: string }, download: boolean) {
  const dispositionFilename = /^[a-zA-Z0-9_.-]+$/.test(file.filename) ? `filename="${file.filename}"` : `filename*=UTF-8''${encodeURIComponent(file.filename)}`;
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `${download ? "attachment" : "inline"}; ${dispositionFilename}`,
      "Cache-Control": "no-store",
    },
  });
}

export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  try {
    const { id, kind } = await params;
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !["resume", "cover-letter", "resume-source", ...comparisonKinds, ...sourceKinds].includes(kind)
    )
      return new Response("Not found", { status: 404 });
    const userId = await currentUserId();
    const state = await loadState(userId);
    const app = state.applications.find(
      (item) => item.id === id && item.userId === userId,
    );
    if (!app) return new Response("Not found", { status: 404 });

    if (comparisonKinds.has(kind)) {
      if (!app.packet) return new Response("Not found", { status: 404 });
      const comparison = await reviewedResumeComparisonFiles(state.profile, app.packet);
      const currentJob = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
      const normalizedJob = currentJob ? importedAutonomyJob(app, currentJob) : undefined;
      const jobIsStale = !normalizedJob || app.packet.resumeSourcePlan?.jobHash !== sourceJobHash(normalizedJob);
      const staleReasons = [...new Set([...(comparison.staleReasons ?? []), ...(jobIsStale ? ["job"] : [])])];
      const stale = comparison.stale || jobIsStale;
      if (kind === "resume-comparison-status") {
        return Response.json({ stale, staleReasons }, { headers: { "Cache-Control": "no-store" } });
      }
      if (stale) return new Response("This saved résumé comparison no longer matches the current application. Rebuild the résumé before viewing its previews.", {
        status: 409,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
      });
      const file = kind === "resume-original-preview" ? comparison.baseline : comparison.tailored;
      const download = new URL(request.url).searchParams.get("download") === "1";
      return fileResponse(file, download);
    }

    if (sourceKinds.has(kind)) {
      const packet = app.packet;
      const plan = packet?.resumeSourcePlan;
      if (!packet || !plan) return new Response("Not found", { status: 404 });
      await reviewedResumeComparisonFiles(state.profile, packet);
      const source = state.profile.resumeSourceDocument;
      if (!source || source.sourceHash !== plan.sourceHash || source.format !== plan.format || state.profile.resumeSource?.sha256 !== plan.sourceHash)
        return new Response("Not found", { status: 404 });
      const original = originalResumeManifest(state.profile);
      const expectedMime = originalResumeMimeType(plan.format);
      if (original.mimeType !== expectedMime) return new Response("Not found", { status: 404 });
      const file = { bytes: await readOriginalResume(userId, original), filename: original.filename, mimeType: original.mimeType };
      return fileResponse(file, new URL(request.url).searchParams.get("download") === "1" || file.mimeType !== "application/pdf");
    }

    const historical = app.submissionAttemptedAt ? app.submissionMaterials?.files.find((file) => file.kind === kind) : undefined;
    if (!historical && !app.packet) return new Response("Not found", { status: 404 });
    if (!historical) validatePacket(state.profile, app.packet!);
    if (!historical && kind === "cover-letter" && !app.packet!.coverLetter)
      return new Response("Not found", { status: 404 });
    const file = historical ? await historicalPacketFile(userId, historical) : kind === "resume-source" ? await reviewedResumeSource(state.profile, app.packet!) : await reviewedPacketFile(state.profile, app.packet!, kind as "resume" | "cover-letter");
    const download = file.mimeType !== "application/pdf" || kind === "resume-source" || new URL(request.url).searchParams.get("download") === "1";
    return fileResponse(file, download);
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
