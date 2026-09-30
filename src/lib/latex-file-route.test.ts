import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication } from "@/lib/workflow";
const mocks = vi.hoisted(() => ({ user: vi.fn(), state: vi.fn(), validate: vi.fn(), pdf: vi.fn(), source: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, loadState: mocks.state }));
vi.mock("@/lib/drafting", () => ({ validatePacket: mocks.validate }));
vi.mock("@/lib/packet-files", () => ({ reviewedPacketFile: mocks.pdf, reviewedResumeSource: mocks.source }));
import { GET } from "@/app/api/applications/[id]/files/[kind]/route";
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue("demo-user"); mocks.validate.mockImplementation(() => {}); });
function setup() {
  const state = initialDemoState(); const app = selectApplication(state, state.jobs[0].id, state.profile.id);
  app.packet = { schemaVersion: 2, version: 1, summary: "fixture", model: "fixture", createdAt: new Date().toISOString(), resumeLines: [], answers: [] };
  mocks.state.mockResolvedValue(state);
  mocks.source.mockResolvedValue({ bytes: Buffer.from("LaTeX source"), filename: "tailored-resume.tex", mimeType: "text/plain; charset=utf-8" });
  mocks.pdf.mockResolvedValue({ bytes: Buffer.from("saved PDF"), filename: "tailored-resume.pdf", mimeType: "application/pdf" });
  return app;
}
describe("private LaTeX/PDF downloads", () => {
  it("serves the source as a private attachment with correct content type", async () => {
    const app = setup();
    const response = await GET(new Request("https://example.com/source"), { params: Promise.resolve({ id: app.id, kind: "resume-source" }) });
    expect(response.status).toBe(200); expect(await response.text()).toBe("LaTeX source");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="tailored-resume.tex"');
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
  it("uses the saved PDF for both inline preview and explicit download", async () => {
    const app = setup(); const params = { params: Promise.resolve({ id: app.id, kind: "resume" }) };
    const preview = await GET(new Request("https://example.com/resume"), params);
    const download = await GET(new Request("https://example.com/resume?download=1"), params);
    expect(await preview.text()).toBe(await download.text());
    expect(preview.headers.get("Content-Disposition")).toContain("inline"); expect(download.headers.get("Content-Disposition")).toContain("attachment");
  });
  it("denies other owners, unauthenticated requests and stale packets before reading artifacts", async () => {
    const app = setup(); const params = { params: Promise.resolve({ id: app.id, kind: "resume-source" }) };
    mocks.user.mockResolvedValueOnce("another-owner");
    expect((await GET(new Request("https://example.com/source"), params)).status).toBe(404); expect(mocks.source).not.toHaveBeenCalled();
    mocks.user.mockRejectedValueOnce(new Error("AUTH_REQUIRED"));
    expect((await GET(new Request("https://example.com/source"), params)).status).toBe(404);
    mocks.validate.mockImplementationOnce(() => { throw new Error("stale profile"); });
    expect((await GET(new Request("https://example.com/source"), params)).status).toBe(404); expect(mocks.source).not.toHaveBeenCalled();
  });
});
