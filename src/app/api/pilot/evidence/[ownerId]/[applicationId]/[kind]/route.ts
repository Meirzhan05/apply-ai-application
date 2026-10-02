import { currentUserId, loadState } from "@/lib/repository";
import { historicalPacketFile } from "@/lib/packet-files";
import { isConfiguredOperator } from "@/lib/pilot-authorization";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ownerId: string; applicationId: string; kind: string }> },
) {
  try {
    const reviewerId = await currentUserId();
    const { ownerId, applicationId, kind } = await params;
    if (!ownerId || !applicationId || !["resume", "cover-letter", "application"].includes(kind)) return new Response("Not found", { status: 404 });
    if (!isConfiguredOperator(reviewerId) && reviewerId !== ownerId) return new Response("Not found", { status: 404 });
    const state = await loadState(ownerId);
    const app = state.applications.find((item) => item.id === applicationId && item.userId === ownerId);
    if (kind === "application") {
      if (!app?.pilotAttempt) return new Response("Not found", { status: 404 });
      const safeValue = (field: { kind: string; value: string }) => /password|token|secret|auth|credit|card/i.test(field.kind) ? "[redacted]" : field.value.slice(0, 1000);
      const body = {
        ownerId,
        applicationId,
        attemptId: app.pilotAttempt.id,
        origin: app.pilotAttempt.origin,
        cohort: app.pilotAttempt.cohort,
        posting: { title: app.pilotAttempt.postingSnapshot.title, company: app.pilotAttempt.postingSnapshot.company, canonicalUrl: app.pilotAttempt.postingSnapshot.canonicalUrl, evidenceHash: app.pilotAttempt.postingSnapshot.evidenceHash },
        profile: { initial: { hash: app.pilotAttempt.profileHash, facts: app.pilotAttempt.profileSnapshot.facts, questionnaire: app.pilotAttempt.profileSnapshot.questionnaire }, atSubmission: app.pilotAttempt.submissionProfileSnapshot ? { facts: app.pilotAttempt.submissionProfileSnapshot.facts, questionnaire: app.pilotAttempt.submissionProfileSnapshot.questionnaire, hash: app.pilotAttempt.submissionEvidenceHash } : undefined },
        answers: (app.packet?.answers ?? []).slice(0, 30).map((answer) => ({ question: answer.question.slice(0, 500), answer: answer.answer.slice(0, 4000), factIds: answer.factIds.slice(0, 40), author: answer.author })),
        form: app.form ? { hash: app.form.hash, capturedAt: app.form.capturedAt, fields: app.form.fields.slice(0, 100).map((field) => ({ identifier: field.identifier, label: field.label.slice(0, 500), kind: field.kind, value: safeValue(field), optionValue: field.optionValue, checked: field.checked, options: field.options?.slice(0, 100) })) } : undefined,
        materials: app.submissionMaterials?.files.map((file) => ({ kind: file.kind, filename: file.filename, mimeType: file.mimeType, size: file.size, sha256: file.sha256, factIds: file.factIds.slice(0, 40) })),
        receipt: app.submissionReceipt ? { text: app.submissionReceipt.text.slice(0, 3000), capturedAt: app.submissionReceipt.capturedAt, screenshotAvailable: Boolean(app.submissionReceipt.screenshotPath) } : undefined,
      };
      return Response.json(body, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const file = app?.submissionAttemptedAt ? app.submissionMaterials?.files.find((item) => item.kind === kind) : undefined;
    if (!file) return new Response("Not found", { status: 404 });
    const material = await historicalPacketFile(ownerId, file);
    return new Response(new Uint8Array(material.bytes), { headers: { "Content-Type": material.mimeType, "Content-Disposition": `attachment; filename="${kind}.pdf"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
