import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import type { AppState } from "@/lib/types";
import { initialDemoState } from "@/lib/demo-data";

const mocks = vi.hoisted(() => ({ state: null as AppState | null, extracted: "", user: vi.fn(), load: vi.fn(), upload: vi.fn(), download: vi.fn(), mutate: vi.fn() }));
let pdfBytes = Buffer.alloc(0);
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
const reuseRequest = () => {
  const form = new FormData(); form.set("reuse", "true");
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
describe("resume upload confirmation boundaries", () => {
  it("prefills an editable current location from the resume contact header", async () => {
    const bytes = await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | Boston, MA" });
    expect((await POST(docxRequest(bytes))).status).toBe(200);
    expect(mocks.state!.profile.currentLocation).toEqual({ city: "Boston", region: "MA", country: "United States" });
  });
  it.each([
    ["Location: Almaty, Almaty Region, Kazakhstan", { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" }],
    ["Toronto, ON, Canada", { city: "Toronto", region: "ON", country: "Canada" }],
    ["Paris, France", { city: "Paris", region: "", country: "France" }],
    ["New York, NY 10001, USA", { city: "New York", region: "NY", country: "United States" }],
  ])("imports explicit international or partial residence details: %s", async (location, expected) => {
    expect((await POST(docxRequest(await createDocxSourceFixture({ identityText: `Riley Example | riley@example.com | ${location}` })))).status).toBe(200);
    expect(mocks.state!.profile.currentLocation).toEqual(expected);
    expect(mocks.state!.profile.onboarding?.questionnaire.immigrationStatus).toBeUndefined();
  });
  it("prefills current location from a readable PDF header", async () => {
    pdfBytes = await createPdfSourceFixture({ contactText: "avery@example.com | Seattle, WA" });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.state!.profile.currentLocation).toEqual({ city: "Seattle", region: "WA", country: "United States" });
  });
  it.each(["", "Boston", "Remote", "Boston, MA | Seattle, WA", "Preferred location: Boston, MA", "Tbilisi, Georgia", "Seattle, Georgia", "Seattle, NY", "State University, Boston, MA", "\nWork History\nBoston, MA"]) (
    "does not invent a residence from missing, ambiguous, or non-residential locations: %s", async (location) => {
      const bytes = await createDocxSourceFixture({ identityText: `Riley Example | riley@example.com | ${location}`, longText: "Worked in Boston, MA and studied in Seattle, WA." });
      expect((await POST(docxRequest(bytes))).status).toBe(200);
      expect(mocks.state!.profile.currentLocation).toBeUndefined();
    });
  it("preserves saved and partially entered residence details across replacement and reuse", async () => {
    const bytes = await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | Boston, MA" });
    for (const currentLocation of [{ city: "Almaty", region: "Almaty Region", country: "Kazakhstan" }, { city: "Paris", region: "", country: "" }]) {
      mocks.state!.profile.currentLocation = currentLocation;
      expect((await POST(docxRequest(bytes))).status).toBe(200);
      expect(mocks.state!.profile.currentLocation).toEqual(currentLocation);
      mocks.download.mockResolvedValue({ data: new Blob([Uint8Array.from(bytes)]), error: null });
      expect((await POST(reuseRequest())).status).toBe(200);
      expect(mocks.state!.profile.currentLocation).toEqual(currentLocation);
    }
  });
  it("fills blank location fields when reusing a saved resume", async () => {
    const bytes = await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | Boston, MA" });
    expect((await POST(docxRequest(bytes))).status).toBe(200);
    mocks.state!.profile.currentLocation = { city: "", region: "", country: "" };
    mocks.download.mockResolvedValue({ data: new Blob([Uint8Array.from(bytes)]), error: null });
    expect((await POST(reuseRequest())).status).toBe(200);
    expect(mocks.state!.profile.currentLocation).toEqual({ city: "Boston", region: "MA", country: "United States" });
  });
  it("lets retry replace an interrupted token and prevents an older import overwriting the latest saved resume", async () => {
    mocks.state!.profile.resumeImport = { token: "orphaned-attempt", startedAt: "2026-01-01T00:00:00.000Z" };
    let finishOld!: () => void;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => { oldStarted = resolve; });
    mocks.upload.mockImplementationOnce(() => { oldStarted(); return new Promise((resolve) => { finishOld = () => resolve({ error: null }); }); });
    const first = POST(docxRequest(await createDocxSourceFixture({ identityText: "Earlier Example | earlier@example.com" })));
    await started;
    expect(mocks.state!.profile.resumeImport?.token).not.toBe("orphaned-attempt");
    const second = await POST(docxRequest(await createDocxSourceFixture({ identityText: "Latest Example | latest@example.com" })));
    expect(second.status).toBe(200);
    const latest = structuredClone(mocks.state!.profile);
    expect(latest.resumeImport).toBeUndefined();
    finishOld();
    expect((await first).status).toBe(400);
    expect(mocks.state!.profile).toEqual(latest);
    expect(mocks.state!.profile.name).toBe("Latest Example");
  });
  it("keeps the original usable while a replacement is pending, and clears the pending import after failure", async () => {
    expect((await POST(docxRequest(await createDocxSourceFixture()))).status).toBe(200);
    const saved = structuredClone(mocks.state!.profile);
    let rejectUpload!: (reason: Error) => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
    mocks.upload.mockImplementationOnce(() => { uploadStarted(); return new Promise((_resolve, reject) => { rejectUpload = reject; }); });
    const importing = POST(docxRequest(await createDocxSourceFixture({ identityText: "Jordan Example | jordan@example.com" })));
    await started;
    expect(mocks.state!.profile).toMatchObject({ resumeSource: saved.resumeSource, name: saved.name, resumeImport: { token: expect.any(String), startedAt: expect.any(String) } });
    rejectUpload(new Error("Storage unavailable. Retry import."));
    expect((await importing).status).toBe(400);
    expect(mocks.state!.profile).toEqual(saved);
  });
  it("replaces edited basics while preserving direct answers and confirmed user-authored facts", async () => {
    expect((await POST(docxRequest(await createDocxSourceFixture()))).status).toBe(200);
    mocks.state!.profile.name = "Edited Name";
    mocks.state!.profile.email = "edited@example.com";
    const sharedClaim = mocks.state!.profile.facts.find((fact) => fact.text.includes("Built a recommender"))!;
    const authored = { id: "authored", text: sharedClaim.text, verified: true, source: "user" as const };
    mocks.state!.profile.facts = [structuredClone(authored)];
    const direct = structuredClone({ onboarding: mocks.state!.profile.onboarding, preferredLocations: mocks.state!.profile.preferredLocations, workAuthorization: mocks.state!.profile.workAuthorization, sensitiveAnswers: mocks.state!.profile.sensitiveAnswers });
    expect((await POST(docxRequest(await createDocxSourceFixture({ identityText: "Jordan Example | jordan@example.com | +81 90 1234 5678 | github.com/jordan" })))).status).toBe(200);
    expect(mocks.state!.profile).toMatchObject({ name: "Jordan Example", email: "jordan@example.com", phone: "+81 90 1234 5678", links: ["https://github.com/jordan"], ...direct });
    expect(mocks.state!.profile.facts.find((fact) => fact.id === "authored")).toEqual(authored);
  });
  it("rejects unreadable replacement PDFs, retaining the usable original and all saved progress", async () => {
    expect((await POST(docxRequest(await createDocxSourceFixture()))).status).toBe(200);
    const saved = structuredClone(mocks.state!.profile);
    pdfBytes = await createPdfSourceFixture({ scanned: true });
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/readable text.*retry|readable text.*replace/i);
    expect(mocks.state!.profile).toEqual(saved);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("reuses stored original bytes, preserving saved corrections while filling missing basics", async () => {
    const bytes = await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | +44 20 7946 0958 | linkedin.com/in/riley" });
    expect((await POST(docxRequest(bytes))).status).toBe(200);
    const original = structuredClone(mocks.state!.profile.resumeSource);
    const facts = structuredClone(mocks.state!.profile.facts);
    mocks.state!.profile.name = "Riley Corrected";
    mocks.state!.profile.email = "contact@example.com";
    mocks.state!.profile.phone = "";
    mocks.state!.profile.links = ["https://portfolio.example.com/"];
    mocks.download.mockResolvedValue({ data: new Blob([Uint8Array.from(bytes)]), error: null });
    const response = await POST(reuseRequest());
    expect(response.status).toBe(200);
    expect(mocks.state!.profile).toMatchObject({ name: "Riley Corrected", email: "contact@example.com", phone: "+44 20 7946 0958", links: ["https://portfolio.example.com/"], resumeSource: original, facts });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });
  it("imports editable international contact details from DOCX without inventing missing basics", async () => {
    const bytes = await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | +44 20 7946 0958 | linkedin.com/in/riley | https://riley.example.com" });
    expect((await POST(docxRequest(bytes))).status).toBe(200);
    expect(mocks.state!.profile).toMatchObject({ name: "Riley Example", email: "riley@example.com", phone: "+44 20 7946 0958", links: ["https://linkedin.com/in/riley", "https://riley.example.com/"] });
    expect(mocks.state!.profile.facts.every((fact) => !fact.verified)).toBe(true);
    expect((await POST(docxRequest(await createDocxSourceFixture({ identityText: "Experience" })))).status).toBe(200);
    expect(mocks.state!.profile).toMatchObject({ name: "", email: "", phone: "", links: [] });
  });
  it("retains a parenthesized contact phone and a bare personal-site link without treating the email domain as a link", async () => {
    expect((await POST(docxRequest(await createDocxSourceFixture({ identityText: "Riley Example | riley@example.com | (202) 555-0147 | riley.dev" })))).status).toBe(200);
    expect(mocks.state!.profile).toMatchObject({ phone: "(202) 555-0147", links: ["https://riley.dev/"] });
  });
  it("stores complete contextual suggestions unconfirmed without changing applications or sensitive answers", async () => {
    const applications = structuredClone(mocks.state!.applications);
    const sensitive = structuredClone(mocks.state!.profile.sensitiveAnswers);
    Object.assign(mocks.state!.profile, {
      currentLocation: { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" },
      preferredLocations: ["United States"], workArrangements: ["remote", "hybrid"], willingToRelocate: false,
      onboarding: { questionnaire: { availability: "June 2027" } },
    });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.state!.profile).toMatchObject({ name: "Avery Chen", email: "avery@example.com", phone: "", links: ["https://linkedin.com/in/averychen"] });
    expect(mocks.state!.profile.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Built a search index for 1,200 users."), verified: false, source: "resume", sourceAnchorId: expect.any(String) }),
    ]));
    expect(mocks.state!.applications).toEqual(applications);
    expect(mocks.state!.profile.sensitiveAnswers).toEqual(sensitive);
    expect(mocks.state!.profile).toMatchObject({
      currentLocation: { city: "Almaty", region: "Almaty Region", country: "Kazakhstan" },
      preferredLocations: ["United States"], workArrangements: ["remote", "hybrid"], willingToRelocate: false,
      onboarding: { questionnaire: { availability: "June 2027" } },
    });
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
  it("cannot reuse a source belonging to a different owner", async () => {
    const bytes = await createDocxSourceFixture();
    expect((await POST(docxRequest(bytes))).status).toBe(200);
    mocks.state!.profile.resumeSource!.storageKey = mocks.state!.profile.resumeSource!.storageKey!.replace("synthetic-owner/", "other-owner/");
    const saved = structuredClone(mocks.state!.profile);
    expect((await POST(reuseRequest())).status).toBe(400);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.state!.profile).toEqual(saved);
  });
  it.each([
    { name: "resume.txt", type: "text/plain", size: 1 },
    { name: "resume.pdf", type: "application/pdf", size: 5 * 1024 * 1024 + 1 },
  ])("rejects unsupported or oversized replacements without changing saved information: $name $size", async ({ name, type, size }) => {
    const saved = structuredClone(mocks.state!.profile);
    const form = new FormData(); form.set("file", new File([new Uint8Array(size)], name, { type }));
    expect((await POST(new Request("http://localhost/api/resume", { method: "POST", headers: { Origin: "http://localhost" }, body: form }))).status).toBe(400);
    expect(mocks.state!.profile).toEqual(saved);
    expect(mocks.upload).not.toHaveBeenCalled();
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
  it("requires confirmation for qualifications that look like a name, alone or on a contact row", async () => {
    for (const identityText of [
      "Registered Nurse",
      "Riley Example | Registered Nurse | Six Sigma Black Belt | riley@example.com",
    ]) {
      const bytes = await createDocxSourceFixture({ identityText });
      const response = await POST(docxRequest(bytes));
      const source = mocks.state!.profile.resumeSourceDocument!;
      const credentials = source.anchors.find((anchor) => anchor.text.includes("Registered Nurse"))!;

      expect(response.status).toBe(200);
      expect(credentials.candidateClaim).toBe(true);
      expect(mocks.state!.profile.facts).toContainEqual(expect.objectContaining({ verified: false, source: "resume", sourceAnchorId: credentials.id,
        text: expect.stringContaining("Registered Nurse") }));
    }
  });
});
