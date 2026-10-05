import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";

const mocks = vi.hoisted(() => ({ state: null as AppState | null, extracted: "", user: vi.fn(), load: vi.fn(), upload: vi.fn(), download: vi.fn(), mutate: vi.fn() }));
let pdfBytes = Buffer.alloc(0);
vi.mock("@/lib/resume-extraction-jobs", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/resume-extraction-jobs")>();
  return { ...actual, dispatchResumeExtraction: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, isDemo: () => false,
  loadState: mocks.load,
  mutateState: async (owner: string, change: (state: AppState) => unknown) => { mocks.mutate(owner); return change(mocks.state!); } }));
vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ rpc: async () => ({ data: true, error: null }), storage: { from: () => ({ upload: mocks.upload, download: mocks.download }) } }) }));
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
const reuseRequest = (reextract = false) => {
  const form = new FormData(); form.set("reuse", "true");
  if (reextract) form.set("reextract", "true");
  return new Request("http://localhost/api/resume", { method: "POST", headers: { Origin: "http://localhost" }, body: form });
};
beforeEach(async () => {
  vi.clearAllMocks(); mocks.state = initialDemoState(); mocks.state.profile.facts = [];
  mocks.state.profile.id = "synthetic-owner";
  pdfBytes = await createPdfSourceFixture();
  mocks.user.mockResolvedValue("synthetic-owner"); mocks.upload.mockResolvedValue({ error: null });
  mocks.load.mockResolvedValue(mocks.state);
  mocks.extracted = "WORK EXPERIENCE\nOrbit Labs\nML Intern June 2026 – August 2026\n• Built a recommender with explainable\nfeature-level predictions.";
});
describe("resume upload automatic extraction", () => {
  it("explicitly re-extracts a ready saved resume without replacing the active profile before success", async () => {
    const bytes = await createDocxSourceFixture();
    await POST(docxRequest(bytes));
    const profile = mocks.state!.profile;
    const pending = profile.resumeExtraction!.pending!;
    profile.resumeSource = pending.source; profile.resumeSourceDocument = pending.document;
    profile.resumeFileName = "resume.docx"; profile.resumeDetailsVersion = 1;
    profile.resumeExtraction!.status = "ready"; profile.resumeExtraction!.pending = undefined;
    profile.facts = [{ id: "legacy", text: "Corrected work history", verified: true, source: "resume" }, { id: "manual", text: "A manually added project", verified: true, source: "user" }];
    profile.resumeSourceDocument!.text = "Legacy cached parser text";
    const before = structuredClone(profile);
    mocks.download.mockImplementation(async () => {
      expect(profile.resumeImport?.reusedSourceHash).toBe(before.resumeSource!.sha256);
      return { data: new Blob([Uint8Array.from(bytes)]), error: null };
    });

    const response = await POST(reuseRequest(true));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued", reused: true });
    expect(profile.resumeExtraction!.id).not.toBe(before.resumeExtraction!.id);
    expect(profile.resumeExtraction!.pending!.onboardingImport?.reused).toBe(true);
    expect(profile.resumeExtraction!.pending!.document!.text).not.toBe("Legacy cached parser text");
    expect(profile.facts).toEqual(before.facts);
    expect(profile.name).toBe(before.name); expect(profile.contactEmail).toBe(before.contactEmail);
    expect(profile.resumeSource).toEqual(before.resumeSource);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("keeps account email and active details unchanged while queuing onboarding basic import", async () => {
    const saved = structuredClone(mocks.state!.profile);
    expect((await POST(docxRequest(await createDocxSourceFixture()))).status).toBe(202);
    expect(mocks.state!.profile).toMatchObject({ name: saved.name, email: saved.email, phone: saved.phone });
    expect(mocks.state!.profile.resumeExtraction!.pending!.onboardingImport).toMatchObject({ reused: false, baseline: { name: saved.name, phone: saved.phone } });
    expect(mocks.state!.profile.resumeImport).toBeUndefined();
  });
  it("reuses a current grounded original without replacing edited facts or requeuing extraction", async () => {
    const bytes = await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | Boston, MA" });
    await POST(docxRequest(bytes));
    const pending = mocks.state!.profile.resumeExtraction!.pending!;
    mocks.state!.profile.resumeSource = pending.source;
    mocks.state!.profile.resumeSourceDocument = pending.document;
    mocks.state!.profile.resumeFileName = "resume.docx";
    mocks.state!.profile.resumeDetailsVersion = 1;
    mocks.state!.profile.resumeExtraction!.status = "ready";
    mocks.state!.profile.resumeExtraction!.pending = undefined;
    const contact = pending.document!.anchors.find(anchor => anchor.text.includes("Boston"))!;
    mocks.state!.profile.detailSources = {
      location: { source: "resume", value: "Boston, MA", sourceHash: pending.source.sha256, anchorId: contact.id, quote: contact.text },
      contactEmail: { source: "resume", value: "riley@example.com", sourceHash: pending.source.sha256, anchorId: contact.id, quote: contact.text },
      phone: { source: "user", value: "" },
    };
    mocks.state!.profile.contactEmail = "";
    mocks.state!.profile.phone = "";
    mocks.state!.profile.facts = [{ id: "edited", text: "Corrected source wording.", source: "resume", sourceAnchorId: contact.id, verified: false }];
    const facts = structuredClone(mocks.state!.profile.facts);
    const jobId = mocks.state!.profile.resumeExtraction!.id;
    mocks.download.mockResolvedValue({ data: new Blob([Uint8Array.from(bytes)]), error: null });
    const response = await POST(reuseRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "ready", requestId: jobId, reused: true });
    expect(mocks.state!.profile.facts).toEqual(facts);
    expect(mocks.state!.profile.currentLocation).toEqual({ city: "Boston", region: "MA", country: "United States" });
    expect(mocks.state!.profile.contactEmail).toBe("riley@example.com");
    expect(mocks.state!.profile.phone).toBe("");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("rejects reuse belonging to a different owner without reading their original", async () => {
    await POST(docxRequest(await createDocxSourceFixture()));
    const pending = mocks.state!.profile.resumeExtraction!.pending!;
    mocks.state!.profile.resumeSource = { ...pending.source, storageKey: "other-owner/resume.docx" };
    mocks.state!.profile.resumeFileName = "resume.docx";
    expect((await POST(reuseRequest())).status).toBe(400);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.state!.profile.resumeImport).toBeUndefined();
  });
  it("does not let a slow older parsing request displace a newer queued original", async () => {
    let finishOld!: () => void;
    let oldStarted!: () => void;
    const started = new Promise<void>(resolve => { oldStarted = resolve; });
    mocks.upload.mockImplementationOnce(() => { oldStarted(); return new Promise(resolve => { finishOld = () => resolve({ error: null }); }); });
    const first = POST(docxRequest(await createDocxSourceFixture()));
    await started;
    expect((await POST(docxRequest(await createDocxSourceFixture({ secondExperience: true })))).status).toBe(202);
    const latest = structuredClone(mocks.state!.profile.resumeExtraction);
    finishOld();
    const superseded = await first;
    expect(superseded.status).toBe(202);
    expect(await superseded.json()).toMatchObject({ status: "superseded" });
    expect(mocks.state!.profile.resumeExtraction).toEqual(latest);
    expect(mocks.state!.profile.resumeImport).toBeUndefined();
  });
  it.each([
    { name: "resume.txt", type: "text/plain", size: 1 },
    { name: "resume.pdf", type: "application/pdf", size: 5 * 1024 * 1024 + 1 },
  ])("rejects invalid replacements before changing saved information: $name", async ({ name, type, size }) => {
    const saved = structuredClone(mocks.state!.profile);
    const form = new FormData(); form.set("file", new File([new Uint8Array(size)], name, { type }));
    expect((await POST(new Request("http://localhost/api/resume", { method: "POST", headers: { Origin: "http://localhost" }, body: form }))).status).toBe(400);
    expect(mocks.state!.profile).toEqual(saved);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
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
