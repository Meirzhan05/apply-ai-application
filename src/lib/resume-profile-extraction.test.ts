import { expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { createResumeProfileFixture } from "@/lib/fixtures/resume-profile";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { initialDemoState } from "@/lib/demo-data";
import { extractResumeProfile, applyResumeProfile, type ResumeProfileDetail } from "@/lib/resume-profile-extraction";
import { sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";

async function fixture() {
  const source = await parseDocxSource(await createResumeProfileFixture(), "Riley Example");
  const contact = source.anchors.find(anchor => anchor.text.includes("riley@example.com"))!;
  const github = source.anchors.find(anchor => anchor.text === "GitHub")!;
  const details: ResumeProfileDetail[] = [
    { key: "name", value: "Riley Example", anchorId: contact.id, quote: contact.text },
    { key: "contactEmail", value: "riley@example.com", anchorId: contact.id, quote: contact.text },
    { key: "githubUrl", value: github.links![0].url, anchorId: github.id, quote: github.text },
    { key: "skill", value: "Python", anchorId: source.anchors.find(anchor => anchor.text === "Python, PostgreSQL")!.id, quote: "Python, PostgreSQL" },
  ];
  return { source, details };
}

it("reads embedded DOCX targets and accepts only source-bound, independently checked applicant details", async () => {
  const { source, details } = await fixture();
  expect(source.anchors.find(anchor => anchor.text === "GitHub")!.links).toEqual([{ label: "GitHub", url: "https://github.com/riley-example" }]);
  expect(sourceWithCurrentEvidenceClaims(source, "Riley Example").anchors.find(anchor => anchor.text === "GitHub")!.candidateClaim).toBe(false);
  const result = await extractResumeProfile(source, { userId: "owner", modelCall: async request => request.operation === "resume-profile-extraction" ? { details } : { supported: true, reason: "Applicant's literal contact details and qualification." } });
  const profile = initialDemoState().profile; profile.name = ""; profile.skills = [];
  const email = profile.email;
  applyResumeProfile(profile, source, result);
  expect(profile).toMatchObject({ name: "Riley Example", email, contactEmail: "riley@example.com", githubUrl: "https://github.com/riley-example", skills: ["Python"], resumeDetailsVersion: 1 });
  expect(profile.detailSources!.githubUrl).toMatchObject({ source: "resume", sourceHash: source.sourceHash });
});

it("rejects invented values, unrelated URLs, duplicate fields, and failed semantic ownership checks", async () => {
  const { source, details } = await fixture();
  for (const proposed of [details.map(detail => detail.key === "name" ? { ...detail, value: "Invented Person" } : detail), details.map(detail => detail.key === "githubUrl" ? { ...detail, value: "https://github.com/fabricated" } : detail), [...details, details[0]]]) {
    await expect(extractResumeProfile(source, { userId: "owner", modelCall: async () => ({ details: proposed }) })).rejects.toThrow();
  }
  await expect(extractResumeProfile(source, { userId: "owner", modelCall: async request => request.operation === "resume-profile-extraction" ? { details } : { supported: false, reason: "Employer rather than applicant." } })).rejects.toThrow("reliably grounded");
});

it("updates previous resume-owned values, removes obsolete imported links, and preserves user edits and explicit clears", async () => {
  const { source, details } = await fixture();
  const profile = initialDemoState().profile; profile.skills = []; profile.phone = "";
  applyResumeProfile(profile, source, details);
  profile.githubUrl = "https://github.com/manual";
  profile.detailSources!.contactEmail = { source: "user", value: "" }; profile.contactEmail = "";
  applyResumeProfile(profile, { ...source, sourceHash: "next" }, details.map(detail => detail.key === "githubUrl" ? { ...detail, value: "https://github.com/replacement" } : detail));
  expect(profile.githubUrl).toBe("https://github.com/manual"); expect(profile.contactEmail).toBe("");
  profile.githubUrl = profile.detailSources!.githubUrl!.value;
  applyResumeProfile(profile, { ...source, sourceHash: "third" }, []);
  expect(profile.githubUrl).toBe(""); expect(profile.skills).toEqual([]);
  profile.skillsEdited = true; profile.skills = [];
  applyResumeProfile(profile, source, details); expect(profile.skills).toEqual([]);
});

it("reads header hyperlinks and PDF annotation URLs without fetching external resources", async () => {
  const zip = await JSZip.loadAsync(await createResumeProfileFixture());
  const body = await zip.file("word/document.xml")!.async("string");
  zip.file("word/header1.xml", body.replace(/.*<w:body>/s, '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">').replace(/<w:sectPr>.*$/s, '</w:hdr>'));
  zip.file("word/_rels/header1.xml.rels", await zip.file("word/_rels/document.xml.rels")!.async("string"));
  const docx = await parseDocxSource(await zip.generateAsync({ type: "nodebuffer" }));
  expect(docx.anchors.some(anchor => anchor.repeatedRole === "header" && anchor.links?.some(link => link.url === "https://github.com/riley-example"))).toBe(true);
  const pdf = await PDFDocument.load(await createPdfSourceFixture());
  const annotation = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 700, 400, 713], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://www.linkedin.com/in/averychen") } }));
  pdf.getPage(0).node.set(PDFName.of("Annots"), pdf.context.obj([annotation]));
  const parsed = await parsePdfSource(Buffer.from(await pdf.save()), "Avery Chen");
  expect(parsed.anchors.find(anchor => anchor.text.includes("avery@example.com"))!.links?.[0].url).toBe("https://www.linkedin.com/in/averychen");
});
