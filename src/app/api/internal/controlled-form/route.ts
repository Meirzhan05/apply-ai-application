import { createHash } from "node:crypto";
import { verifyControlledTestGrant } from "@/lib/controlled-tests";
import { loadState, mutateState } from "@/lib/repository";
import { hasSubmissionApproval } from "@/lib/workflow";
import { sameOrigin } from "@/lib/request-security";
import { hasBoundSubmissionAttempt } from "@/lib/autonomous-policy";
import type { AppState, Application } from "@/lib/types";

function authorizedAttempt(state: AppState, app: Application) {
  if (app.autonomousAuthorization) return hasBoundSubmissionAttempt(app, state.profile, state.jobs.find((job) => job.id === app.jobId));
  // Existing review approvals remain required. The durable attempt marker does
  // not invalidate the receiver's check of the approvals that authorized it.
  return hasSubmissionApproval({ ...app, submissionAttemptedAt: undefined }) && app.status === "submitting" && Boolean(app.submissionWorkerClaimedAt);
}

export const runtime = "nodejs";

async function authorized(token: string) {
  const grant = verifyControlledTestGrant(token);
  if (!grant) return null;
  const state = await loadState(grant.userId);
  const app = state.applications.find((item) => item.id === grant.applicationId && item.userId === grant.userId);
  // Only server-created synthetic fixtures can use this receiver. It cannot
  // turn an ordinary user's application into a production demo submission.
  if (!app?.controlledTest || app.controlledTest.expiresAt !== grant.expiresAt || !/^cloud-submit-[a-f0-9-]+@example\.com$/i.test(state.profile.email)) return null;
  return { grant, state, app };
}

const html = (body: string, frame = false) => new Response(`<!doctype html><html><body style="max-width:700px;margin:40px auto;font-family:Arial;padding:24px">${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-src 'self'; frame-ancestors ${frame ? "'self'" : "'none'"}` } });

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const context = await authorized(token);
  if (!context) return new Response("Not found", { status: 404 });
  if (new URL(request.url).searchParams.get("frame") === "challenge") {
    if (!context.app.controlledTest?.verification || context.app.controlledTest.submissions !== 1) return new Response("Not found", { status: 404 });
    return html("<h1>Synthetic verification challenge</h1><p>This is a controlled test, not a CAPTCHA provider.</p>", true);
  }
  const factualQuestions = context.app.controlledTest?.factualOnly ? '<fieldset><legend>Will you now or in the future require visa sponsorship?</legend><label><input type="radio" name="sponsorship" value="Yes" required>Yes</label><label><input type="radio" name="sponsorship" value="No" required>No</label></fieldset><label>Favorite snack<select name="snack" required><option value="">Choose an option</option><option>Chips</option><option>Fruit</option></select></label>' : "";
  const questions = factualQuestions || (context.app.controlledTest?.questions ? '<fieldset><legend>Will you now or in the future require visa sponsorship?</legend><label><input type="radio" name="sponsorship" value="Yes" required>Yes</label><label><input type="radio" name="sponsorship" value="No" required>No</label></fieldset><label>Favorite snack<select name="snack" required><option value="">Choose an option</option><option>Chips</option><option>Fruit</option></select></label><label>Why are you excited to join us?<textarea name="why" required></textarea></label>' : "");
  const automaticEssay = context.app.controlledTest?.essayOnly && !context.app.controlledTest.questions ? '<label>Why this role?<textarea name="why" required></textarea></label>' : "";
  // Token characters are restricted to base64url and a separator by signing.
  return html(`<p>Controlled cloud test · no employer receives this application</p><h1>Synthetic test application</h1><form action="/api/internal/controlled-form?token=${token}" method="post" enctype="multipart/form-data" style="display:grid;gap:18px"><label>First name<input name="firstName" required></label><label>Last name<input name="lastName" required></label><label>Email<input name="email" type="email" required></label><label>Resume<input name="resume" type="file" accept=".pdf" required></label>${questions}${automaticEssay}<button type="submit">Submit application</button></form>`);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response("Cross-origin request rejected", { status: 403 });
  const context = await authorized(new URL(request.url).searchParams.get("token") || "");
  if (new URL(request.url).searchParams.get("verification") === "complete") {
    if (!context?.app.controlledTest?.verification || context.app.controlledTest.submissions !== 1 || context.app.status !== "awaiting_verification" || !context.app.submissionVerification || !context.app.submissionAttemptedAt || context.app.controlledTest.verified)
      return new Response("Existing verification required", { status: 403 });
    const verified = await mutateState(context.grant.userId, (state) => {
      const app = state.applications.find(item => item.id === context.grant.applicationId);
      if (app?.status !== "awaiting_verification" || !app.controlledTest || app.controlledTest.verified || app.controlledTest.submissions !== 1) return false;
      app.controlledTest.verified = true;
      return true;
    });
    return verified ? html("<h1>Application received</h1><p>The existing synthetic attempt was verified. No employer was contacted.</p>") : new Response("Verification already handled", { status: 409 });
  }
  if (!context || !authorizedAttempt(context.state, context.app)) return new Response("Authorized test attempt required", { status: 403 });
  const size = Number(request.headers.get("content-length") || "0");
  if (size > 2_000_000) return new Response("Test file too large", { status: 413 });
  const data = await request.formData();
  const resume = data.get("resume");
  if (!(resume instanceof File) || !resume.size || resume.size > 1_000_000) return new Response("Test resume required", { status: 400 });
  const bytes = Buffer.from(await resume.arrayBuffer());
  const fileHash = `${resume.name}:${resume.size}:${createHash("sha256").update(bytes).digest("hex")}`;
  if (!context.app.form?.fields.find((field) => field.identifier === "resume")?.fileHashes?.includes(fileHash)) return new Response("The reviewed attachment changed", { status: 409 });
  const factualIdentifiers = context.app.controlledTest?.factualOnly ? ["sponsorship", "snack"] : context.app.controlledTest?.questions ? ["sponsorship", "snack", "why"] : context.app.controlledTest?.essayOnly ? ["why"] : [];
  for (const identifier of ["firstName", "lastName", "email", ...factualIdentifiers]) {
    const reviewed = context.app.form.fields.find((field) => field.identifier === identifier && (field.kind !== "radio" || field.checked));
    if (!reviewed?.value || reviewed.value !== String(data.get(identifier) || "")) return new Response("The reviewed fields changed", { status: 409 });
  }
  const accepted = await mutateState(context.grant.userId, (state) => {
    const app = state.applications.find((item) => item.id === context.grant.applicationId);
    if (!app?.controlledTest || app.controlledTest.submissions !== 0 || !authorizedAttempt(state, app)) return false;
    app.controlledTest.submissions = 1;
    return true;
  });
  if (!accepted) return new Response("Test submission already handled", { status: 409 });
  if (context.app.controlledTest?.verification) {
    const token = new URL(request.url).searchParams.get("token")!;
    return html(`<h1>Complete synthetic verification</h1><iframe title="Synthetic security challenge" src="/api/internal/controlled-form?token=${token}&frame=challenge" style="width:400px;height:250px"></iframe><form method="post" action="/api/internal/controlled-form?token=${token}&verification=complete"><button>Complete synthetic verification</button></form>`);
  }
  return html("<p>Controlled cloud test confirmation</p><h1>Application received</h1><p>The synthetic application was received once. No employer was contacted.</p>");
}
