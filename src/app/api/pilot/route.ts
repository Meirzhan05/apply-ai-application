import { z } from "zod";
import { currentUserId, isDemo, loadState } from "@/lib/repository";
import { adminSupabase } from "@/lib/supabase-admin";
import { readAllAppStateOwners } from "@/lib/app-state-owners";
import { sameOrigin } from "@/lib/request-security";
import { attachPilotCostEvidence, buildPilotReportSnapshot, pilotReportCsv, pilotReportDigest, pilotReportIdentity } from "@/lib/pilot-report";
import type { PilotReportSnapshot } from "@/lib/types";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";

export const runtime = "nodejs";

function operator(userId: string): boolean {
  return (process.env.USAGE_OPERATOR_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean).includes(userId);
}

function safeOwner(requested: string | null, userId: string): string | undefined {
  if (requested && requested !== userId && !operator(userId)) throw new Error("Pilot reports belong to the signed-in account.");
  return requested || (operator(userId) ? undefined : userId);
}

function reportRow(row: { snapshot?: unknown; data?: unknown }): PilotReportSnapshot {
  const snapshot = row.snapshot ?? row.data;
  if (!snapshot || typeof snapshot !== "object") throw new Error("Pilot report is unavailable.");
  return snapshot as PilotReportSnapshot;
}

async function operatorState(ownerId?: string): Promise<{ state: AppState; ownerIds: string[]; rows: Array<{ ownerId: string; revision?: number; readAt: string }> }> {
  if (isDemo()) return { state: await loadState(ownerId || "demo-user"), ownerIds: [ownerId || "demo-user"], rows: [{ ownerId: ownerId || "demo-user", readAt: new Date().toISOString() }] };
  if (ownerId) return { state: await loadState(ownerId), ownerIds: [ownerId], rows: [{ ownerId, readAt: new Date().toISOString() }] };
  const applications: AppState["applications"] = [];
  const ownerIds: string[] = [];
  const rowsManifest: Array<{ ownerId: string; revision?: number; readAt: string }> = [];
  let template: AppState | undefined;
  const rows = await readAllAppStateOwners<{ user_id: string; revision?: number; updated_at?: string; data?: unknown }>("user_id,revision,updated_at,data", 500);
  {
    for (const row of rows) {
      ownerIds.push(String(row.user_id));
      rowsManifest.push({ ownerId: String(row.user_id), revision: Number(row.revision), readAt: String(row.updated_at || new Date().toISOString()) });
      const stored = row.data as Partial<AppState> | undefined;
      if (!template) template = { ...initialDemoState(), ...stored, applications: [] };
      applications.push(...(stored?.applications ?? []));
    }
  }
  return { state: { ...(template ?? initialDemoState()), applications }, ownerIds, rows: rowsManifest };
}

export async function GET(request: Request) {
  let userId: string;
  try { userId = await currentUserId(); } catch { return Response.json({ error: "Sign in to inspect the pilot." }, { status: 401 }); }
  try {
    const url = new URL(request.url);
    const ownerId = safeOwner(url.searchParams.get("userId"), userId);
    if (isDemo()) {
      const report = await attachPilotCostEvidence(buildPilotReportSnapshot(await loadState(userId), { kind: operator(userId) ? "operator" : "owner", userId }, ownerId === userId ? {} : ownerId ? { ownerId } : {}), { ownerId: ownerId || userId, service: false });
      report.id = pilotReportIdentity(report);
      if (url.searchParams.get("format") === "csv") return new Response(pilotReportCsv(report), { headers: { "Cache-Control": "no-store", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=pilot-report.csv" } });
      return Response.json(report, { headers: { "Cache-Control": "no-store" } });
    }
    let reportQuery = adminSupabase().from("pilot_reports").select("snapshot").order("created_at", { ascending: false }).limit(1);
    reportQuery = ownerId ? reportQuery.eq("owner_id", ownerId) : reportQuery.is("owner_id", null);
    const { data, error } = await reportQuery.maybeSingle();
    if (error) throw error;
    if (!data) {
      if (ownerId !== userId) return Response.json({ error: "No pilot report has been captured yet." }, { status: 404, headers: { "Cache-Control": "no-store" } });
      const live = await attachPilotCostEvidence(buildPilotReportSnapshot(await loadState(userId), { kind: "owner", userId }), { ownerId: userId, service: false });
      live.id = pilotReportIdentity(live);
      if (url.searchParams.get("format") === "csv") return new Response(pilotReportCsv(live), { headers: { "Cache-Control": "no-store", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=pilot-report.csv" } });
      return Response.json(live, { headers: { "Cache-Control": "no-store", "X-Pilot-Report": "live-state" } });
    }
    const report = reportRow(data);
    if (url.searchParams.get("format") === "csv") return new Response(pilotReportCsv(report), { headers: { "Cache-Control": "no-store", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=pilot-report.csv" } });
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Pilot report could not be loaded." }, { status: 403 });
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  let userId: string;
  try { userId = await currentUserId(); } catch { return Response.json({ error: "Sign in to create a pilot report." }, { status: 401 }); }
  if (!operator(userId)) return Response.json({ error: "Only a configured pilot operator may capture a cross-owner report." }, { status: 403 });
  try {
    const input = z.object({ ownerId: z.string().min(1).optional(), cutoffAt: z.string().datetime().optional() }).default({}).parse(await request.json());
    const loaded = await operatorState(input.ownerId);
    const report = await attachPilotCostEvidence(buildPilotReportSnapshot(loaded.state, { kind: "operator", userId }, input.ownerId ? { ownerId: input.ownerId, cutoffAt: input.cutoffAt } : { cutoffAt: input.cutoffAt, stateOwnerIds: loaded.ownerIds }), { ownerId: input.ownerId, service: !input.ownerId });
    report.sourceManifest.stateRows = loaded.rows;
    report.id = pilotReportIdentity(report);
    if (isDemo()) return Response.json(report, { status: 201 });
    const { error } = await adminSupabase().from("pilot_reports").insert({ id: report.id, owner_id: input.ownerId ?? null, created_by: userId, created_at: report.createdAt, cutoff_at: report.cutoffAt, gate_version: report.gateVersion, status: report.status, snapshot_hash: pilotReportDigest(report), snapshot: report });
    if (error?.code === "23505") {
      const existing = await adminSupabase().from("pilot_reports").select("snapshot").eq("id", report.id).maybeSingle();
      if (existing.error) throw existing.error;
      const saved = existing.data ? reportRow(existing.data) : undefined;
      if (!saved || pilotReportDigest(saved) !== pilotReportDigest(report)) return Response.json({ error: "A pilot report with this identity has different evidence." }, { status: 409 });
      return Response.json(saved, { status: 200 });
    }
    if (error) throw error;
    return Response.json(report, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Pilot report could not be captured." }, { status: 400 });
  }
}
