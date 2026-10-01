import { currentUserId } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { costReport, costReportCsv, recordServiceCost, type ServiceCostRecord } from "@/lib/service-costs";

export const runtime = "nodejs";
function isOperator(userId: string): boolean {
  return (process.env.USAGE_OPERATOR_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean).includes(userId);
}

export async function GET(request: Request) {
  let current: string;
  try { current = await currentUserId(); }
  catch { return Response.json({ error: "Sign in to inspect service costs." }, { status: 401, headers: { "Cache-Control": "no-store" } }); }
  const params = new URL(request.url).searchParams;
  const requestedOwner = params.get("userId") || current;
  const service = params.get("scope") === "service";
  if ((service || requestedOwner !== current) && !isOperator(current)) return Response.json({ error: "Service cost access requires operator authorization." }, { status: 403 });
  try {
    const report = await costReport(requestedOwner, { service, period: params.get("period") || undefined });
    if (params.get("format") === "csv") return new Response(costReportCsv(report), { headers: { "Cache-Control": "no-store", "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="service-costs-${report.scope}.csv"` } });
    return Response.json({ ...report, operator: isOperator(current) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Service costs could not be loaded. Try again." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  let current: string;
  try { current = await currentUserId(); }
  catch { return Response.json({ error: "Sign in to import service costs." }, { status: 401 }); }
  if (!isOperator(current)) return Response.json({ error: "Operator authorization is required." }, { status: 403 });
  try {
    const record = await request.json() as ServiceCostRecord;
    const saved = await recordServiceCost(record);
    return Response.json({ record: saved }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Service cost could not be imported." }, { status: 400 }); }
}
