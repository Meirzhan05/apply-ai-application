import { beforeEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ currentUserId: vi.fn() }));
const service = vi.hoisted(() => ({ costReport: vi.fn(), costReportCsv: vi.fn(), recordServiceCost: vi.fn() }));
vi.mock("@/lib/repository", () => auth);
vi.mock("@/lib/service-costs", () => service);
import { GET, POST } from "@/app/api/costs/route";

beforeEach(() => { auth.currentUserId.mockReset(); service.costReport.mockReset(); service.costReportCsv.mockReset(); service.recordServiceCost.mockReset(); vi.unstubAllEnvs(); });
it("requires the server signed-in operator for service totals and ignores client role claims", async () => {
  auth.currentUserId.mockResolvedValue("owner");
  expect((await GET(new Request("https://apply.example/api/costs?scope=service&operator=true"))).status).toBe(403);
  expect((await POST(new Request("https://apply.example/api/costs", { method: "POST", body: "{}" }))).status).toBe(403);
});
it("keeps owner reads isolated and allows configured operator CSV export", async () => {
  auth.currentUserId.mockResolvedValue("operator");
  vi.stubEnv("USAGE_OPERATOR_USER_IDS", "operator");
  service.costReport.mockResolvedValue({ scope: "owner", ownerId: "owner", evidence: [] });
  service.costReportCsv.mockReturnValue("scope,ownerId\n");
  const response = await GET(new Request("https://apply.example/api/costs?userId=owner&format=csv"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/csv");
  expect(service.costReport).toHaveBeenCalledWith("owner", { service: false, period: undefined });
  auth.currentUserId.mockResolvedValue("owner");
  expect((await GET(new Request("https://apply.example/api/costs?userId=other"))).status).toBe(403);
});
it("lets only the configured operator import a validated server record", async () => {
  auth.currentUserId.mockResolvedValue("operator");
  vi.stubEnv("USAGE_OPERATOR_USER_IDS", "operator");
  service.recordServiceCost.mockResolvedValue({ id: "line" });
  const response = await POST(new Request("https://apply.example/api/costs", { method: "POST", body: JSON.stringify({ id: "line" }), headers: { "content-type": "application/json" } }));
  expect(response.status).toBe(201);
  expect(service.recordServiceCost).toHaveBeenCalledWith({ id: "line" });
});
it("rejects cross-origin invoice mutations before reading credentials", async () => {
  vi.stubEnv("USAGE_OPERATOR_USER_IDS", "operator");
  const response = await POST(new Request("https://apply.example/api/costs", { method: "POST", body: "{}", headers: { origin: "https://attacker.example" } }));
  expect(response.status).toBe(403);
  expect(auth.currentUserId).not.toHaveBeenCalled();
  expect(service.recordServiceCost).not.toHaveBeenCalled();
});
