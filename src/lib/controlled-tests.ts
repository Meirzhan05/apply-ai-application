import { createHmac, timingSafeEqual } from "node:crypto";

interface TestGrant { userId: string; applicationId: string; expiresAt: number }

export function issueControlledTestGrant(userId: string, applicationId: string): { token: string; grant: TestGrant } {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret) throw new Error("Configure INTERNAL_TASK_SECRET before running controlled cloud tests.");
  const grant = { userId, applicationId, expiresAt: Date.now() + 15 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`controlled-form:${payload}`).digest("base64url");
  return { token: `${payload}.${signature}`, grant };
}

export function verifyControlledTestGrant(token: string): TestGrant | null {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || token.length > 1000) return null;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret).update(`controlled-form:${payload}`).digest("base64url");
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TestGrant;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return typeof grant.userId === "string" && uuid.test(grant.userId) && typeof grant.applicationId === "string" && uuid.test(grant.applicationId) && Number.isFinite(grant.expiresAt) && grant.expiresAt > Date.now() ? grant : null;
  } catch { return null; }
}
