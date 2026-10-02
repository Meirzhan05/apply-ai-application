import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";

const mocks = vi.hoisted(() => ({ state: null as AppState | null, extracted: "", user: vi.fn(), upload: vi.fn(), mutate: vi.fn() }));
let pdfBytes = Buffer.alloc(0);
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, isDemo: () => false,
  mutateState: async (owner: string, change: (state: AppState) => unknown) => { mocks.mutate(owner); return change(mocks.state!); } }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ storage: { from: () => ({ upload: mocks.upload }) } }) }));
vi.mock("pdf-parse", () => ({ PDFParse: class { async getText() { return { text: mocks.extracted }; } async destroy() {} } }));
import { POST } from "@/app/api/resume/route";

const request = () => {
  const form = new FormData(); form.append("file", new File([new Uint8Array(pdfBytes)], "resume.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/resume", { method: "POST", headers: { Origin: "http://localhost" }, body: form });
};
const docxRequest = (bytes: Buffer) => {
  const form = new FormData(); form.append("file", new File([Uint8Array.from(bytes).buffer], "resume.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  return new Request("http://localhost/api/resume", { method: "POST", headers: { Origin: "http://localhost" }, body: form });
};
beforeEach(async () => {
  vi.clearAllMocks(); mocks.state = initialDemoState(); mocks.state.profile.facts = [];
  pdfBytes = await createPdfSourceFixture();
  mocks.user.mockResolvedValue("synthetic-owner"); mocks.upload.mockResolvedValue({ error: null });
  mocks.extracted = "WORK EXPERIENCE\nOrbit Labs\nML Intern June 2026 – August 2026\n• Built a recommender with explainable\nfeature-level predictions.";
});
describe("resume upload confirmation boundaries", () => {
  it("stores complete contextual suggestions unconfirmed without changing applications or sensitive answers", async () => {
    const applications = structuredClone(mocks.state!.applications);
    const sensitive = structuredClone(mocks.state!.profile.sensitiveAnswers);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.state!.profile.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Built a search index for 1,200 users."), verified: false, source: "resume", sourceAnchorId: expect.any(String) }),
    ]));
    expect(mocks.state!.applications).toEqual(applications);
    expect(mocks.state!.profile.sensitiveAnswers).toEqual(sensitive);
    expect(mocks.state!.profile.automationVersion).toBeGreaterThan(1);
    expect(mocks.upload.mock.calls[0][0]).toMatch(/^synthetic-owner\//);
    expect(mocks.mutate).toHaveBeenCalledWith("synthetic-owner");
  });
  it("retains existing confirmations and respects the profile's 80-fact bound across uploads", async () => {
    mocks.state!.profile.facts = Array.from({ length: 79 }, (_, i) => ({ id: `fact-${i}`, text: `Confirmed prior fact ${i}`, verified: true, source: "user" as const }));
    const confirmed = structuredClone(mocks.state!.profile.facts);
    mocks.extracted += "\n• Integrated database migrations and rollback support.";
    expect((await POST(request())).status).toBe(200);
    expect(mocks.state!.profile.facts).toHaveLength(80);
    expect(mocks.state!.profile.facts.slice(0, 79)).toEqual(confirmed);
    expect(mocks.state!.profile.facts.at(-1)!.verified).toBe(false);
    expect((await POST(request())).status).toBe(200);
    expect(mocks.state!.profile.facts).toHaveLength(80);
  });
  it("rejects unauthenticated uploads before reading or storing the file", async () => {
    mocks.user.mockRejectedValue(new Error("AUTH_REQUIRED"));
    expect((await POST(request())).status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("stores the complete structured DOCX representation and anchored unconfirmed facts", async () => {
    const bytes = await createDocxSourceFixture();
    const response = await POST(docxRequest(bytes));
    const result = await response.json();
    const bullet = mocks.state!.profile.resumeSourceDocument?.anchors.find((anchor) => anchor.kind === "bullet");

    expect(response.status).toBe(200);
    expect(result.extracted).toContain("Built a recommender with 92% precision.");
    expect(mocks.state!.profile.resumeText).toBe(mocks.state!.profile.resumeSourceDocument?.text);
    expect(mocks.state!.profile.resumeSourceDocument).toMatchObject({ version: 1, format: "docx", support: { status: "candidate" }, layout: { columns: 1 } });
    expect(mocks.state!.profile.facts).toContainEqual(expect.objectContaining({ verified: false, source: "resume", sourceAnchorId: bullet!.id, text: expect.stringContaining("Built a recommender with 92% precision.") }));
    expect(mocks.upload.mock.calls[0][1]).toEqual(bytes);
  });
});
