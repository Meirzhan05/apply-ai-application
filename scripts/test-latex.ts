import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { PDFParse } from "pdf-parse";
import { fitResume } from "../src/lib/latex-compiler";
import { validateResumeDocument, sealResume } from "../src/lib/resume-document";
import { latexFixture } from "../src/lib/fixtures/latex-resume";

async function main() {
  const { profile, document } = latexFixture();
  validateResumeDocument(profile, document);
  const fitted = await fitResume(profile, document);
  const pdf = await PDFDocument.load(fitted.pdf);
  assert.equal(pdf.getPageCount(), 1);
  const parser = new PDFParse({ data: fitted.pdf });
  let text: string;
  try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  for (const heading of ["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS"]) assert.ok(text.includes(heading));
  const positions = ["EDUCATION", "EXPERIENCE", "PROJECTS", "SKILLS"].map((heading) => text.indexOf(heading));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal((text.match(/State University/g) ?? []).length, 1);
  assert.ok(text.includes("expected")); assert.ok(text.includes("15+")); assert.ok(text.includes("50+"));
  const annotations = pdf.getPage(0).node.Annots();
  assert.ok(annotations?.asArray().some((ref) => {
    const annotation = pdf.context.lookup(ref, PDFDict);
    return annotation.get(PDFName.of("Subtype"))?.toString() === "/Link";
  }), "The PDF must retain a clickable profile link");
  const edge = latexFixture();
  const url = "https://example.com/taylor_profile?progress=50%25&source=resume#projects";
  edge.profile.facts[11].text = `Professional profile: ${url}`;
  edge.document.links[0].text = url;
  const edgeResult = await fitResume(edge.profile, sealResume(edge.profile, edge.document));
  const edgePdf = await PDFDocument.load(edgeResult.pdf);
  const links = edgePdf.getPage(0).node.Annots()!;
  assert.ok(links.asArray().some((ref) => {
    const annotation = edgePdf.context.lookup(ref, PDFDict);
    const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
    const uri = action?.get(PDFName.of("URI"));
    return uri && "decodeText" in uri && (uri as { decodeText(): string }).decodeText() === url;
  }), "LaTeX escaping must preserve the exact URL including underscores, percent encoding, query and fragment");
  await mkdir(".data/latex-check", { recursive: true });
  await writeFile(".data/latex-check/fixture-resume.pdf", fitted.pdf);
  await writeFile(".data/latex-check/fixture-resume.tex", fitted.source);
  console.log("PASS real LaTeX: one page, selectable text, ordered sections, preserved qualifiers/metrics, clickable link");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
