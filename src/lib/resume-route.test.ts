import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";

const mocks = vi.hoisted(() => ({ state: null as AppState | null, extracted: "", user: vi.fn(), load: vi.fn(), upload: vi.fn(), mutate: vi.fn() }));
let pdfBytes = Buffer.alloc(0);
vi.mock("@/lib/resume-extraction-jobs", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/resume-extraction-jobs")>();
  return { ...actual, dispatchResumeExtraction: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, isDemo: () => false,
  loadState: mocks.load,
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
  mocks.load.mockResolvedValue(mocks.state);
  mocks.extracted = "WORK EXPERIENCE\nOrbit Labs\nML Intern June 2026 – August 2026\n• Built a recommender with explainable\nfeature-level predictions.";
});
describe("resume upload automatic extraction", () => {
  it("queues complete source text without changing the active snapshot, applications or sensitive answers", async () => {
    const applications = structuredClone(mocks.state!.applications);
    const sensitive = structuredClone(mocks.state!.profile.sensitiveAnswers);
    expect((await POST(request())).status).toBe(202);
    expect(mocks.state!.profile.facts).toEqual([]);
    expect(mocks.state!.profile.resumeExtraction).toMatchObject({ status: "queued", pending: { document: { text: expect.stringContaining("Built a search index for 1,200 users.") } } });
    expect(mocks.state!.applications).toEqual(applications);
    expect(mocks.state!.profile.sensitiveAnswers).toEqual(sensitive);

    expect(mocks.upload.mock.calls[0][0]).toMatch(/^synthetic-owner\//);
    expect(mocks.mutate).toHaveBeenCalledWith("synthetic-owner");
  });
  it("retains active facts across uploads while replacement extraction is pending", async () => {
    mocks.state!.profile.facts = Array.from({ length: 79 }, (_, i) => ({ id: `fact-${i}`, text: `Confirmed prior fact ${i}`, verified: true, source: "user" as const }));
    const confirmed = structuredClone(mocks.state!.profile.facts);
    mocks.extracted += "\n• Integrated database migrations and rollback support.";
    expect((await POST(request())).status).toBe(202);
    expect(mocks.state!.profile.facts).toHaveLength(79);
    expect(mocks.state!.profile.facts.slice(0, 79)).toEqual(confirmed);
    expect(mocks.state!.profile.facts.every(fact => fact.verified)).toBe(true);
    expect((await POST(request())).status).toBe(202);
    expect(mocks.state!.profile.facts).toHaveLength(79);
  });
  it("does not supersede a valid queued extraction when replacement parsing fails", async () => {
    await POST(docxRequest(await createDocxSourceFixture()));
    const activeJob = structuredClone(mocks.state!.profile.resumeExtraction);
    const response = await POST(docxRequest(Buffer.from("not a DOCX")));
    expect(response.status).toBe(400);
    expect(mocks.state!.profile.resumeExtraction).toEqual(activeJob);
  });
  it("rejects unauthenticated uploads before reading or storing the file", async () => {
    mocks.user.mockRejectedValue(new Error("AUTH_REQUIRED"));
    expect((await POST(request())).status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("queues the complete structured DOCX representation without accepting facts prematurely", async () => {
    const bytes = await createDocxSourceFixture();
    const response = await POST(docxRequest(bytes));
    const result = await response.json();
    const document = mocks.state!.profile.resumeExtraction!.pending!.document!;

    expect(response.status).toBe(202);
    expect(result.status).toBe("queued");
    expect(document.text).toContain("Built a recommender with 92% precision.");
    expect(mocks.state!.profile.resumeText).toBeUndefined();
    expect(document).toMatchObject({ version: 1, format: "docx", support: { status: "candidate" }, layout: { columns: 1 } });
    expect(mocks.state!.profile.facts).toEqual([]);
    expect(mocks.upload.mock.calls[0][1]).toEqual(bytes);
  });
  it("includes qualifications that look like a name in the source queued for extraction", async () => {
    for (const identityText of [
      "Registered Nurse",
      "Riley Example | Registered Nurse | Six Sigma Black Belt | riley@example.com",
    ]) {
      const bytes = await createDocxSourceFixture({ identityText });
      const response = await POST(docxRequest(bytes));
      const source = mocks.state!.profile.resumeExtraction!.pending!.document!;
      const credentials = source.anchors.find((anchor) => anchor.text.includes("Registered Nurse"))!;

      expect(response.status).toBe(202);
      expect(credentials.candidateClaim).toBe(true);
      expect(mocks.state!.profile.facts).toEqual([]);
    }
  });
});
