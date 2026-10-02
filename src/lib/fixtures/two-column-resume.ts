import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const wordNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";

const pdfText = {
  pageOneLeft: [
    ["Work Experience", 12, true, 690],
    ["Orbit Labs — Search Engineer, 2023–2024", 10, true, 666],
    ["• Built ranking service for 1,200 users.", 9, false, 648],
    ["• Cut p95 search latency by 22%.", 9, false, 632],
    ["Harbor Analytics — Research Intern, 2022–2023", 10, true, 598],
    ["• Evaluated 4 retrieval models at 91% recall.", 9, false, 580],
  ] as const,
  pageOneRight: [
    ["Technical Skills", 12, true, 690],
    ["• Python, Java, TypeScript.", 9, false, 670],
    ["• Accessibility testing.", 9, false, 654],
    ["Projects", 12, true, 614],
    ["Campus Access Checker", 10, true, 590],
    ["• Created accessibility scanner for 40 students.", 9, false, 572],
    ["• Documented 18 keyboard-only issues.", 9, false, 556],
  ] as const,
  pageTwoLeft: [
    ["• Improved keyboard navigation coverage to 96%.", 9, false, 730],
    ["Aster Systems — Software Intern, 2021–2022", 10, true, 692],
    ["• Automated 18 release checks.", 9, false, 674],
  ] as const,
  pageTwoRight: [
    ["Languages", 12, true, 730],
    ["• English and Spanish.", 9, false, 710],
  ] as const,
};

export async function createTwoColumnPdfFixture(options: { pages?: 1 | 2 } = {}): Promise<Buffer> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(await readFile(path.join(process.cwd(), "src/assets/fonts/NotoSans-Regular.ttf")), { subset: true });
  const bold = await pdf.embedFont(await readFile(path.join(process.cwd(), "src/assets/fonts/NotoSans-Bold.ttf")), { subset: true });
  const draw = (page: ReturnType<typeof pdf.addPage>, entries: ReadonlyArray<readonly [string, number, boolean, number]>, x: number) => {
    for (const [text, size, isBold, y] of entries) page.drawText(text, { x, y, size, font: isBold ? bold : regular, color: rgb(0.12, 0.17, 0.24) });
  };

  const firstPage = pdf.addPage([612, 792]);
  firstPage.drawText("Casey Rivera", { x: 54, y: 756, size: 18, font: bold, color: rgb(0.12, 0.17, 0.24) });
  firstPage.drawText("Software Engineer", { x: 54, y: 734, size: 10, font: regular, color: rgb(0.12, 0.17, 0.24) });
  firstPage.drawText("casey@example.com · linkedin.com/in/caseyrivera", { x: 330, y: 756, size: 8, font: regular, color: rgb(0.2, 0.2, 0.2) });
  draw(firstPage, pdfText.pageOneLeft, 54);
  draw(firstPage, pdfText.pageOneRight, 330);

  if (options.pages === 2) {
    const secondPage = pdf.addPage([612, 792]);
    secondPage.drawText("Casey Rivera", { x: 54, y: 756, size: 16, font: bold, color: rgb(0.12, 0.17, 0.24) });
    secondPage.drawText("casey@example.com", { x: 330, y: 756, size: 8, font: regular, color: rgb(0.2, 0.2, 0.2) });
    draw(secondPage, pdfText.pageTwoLeft, 54);
    draw(secondPage, pdfText.pageTwoRight, 330);
  }

  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}

function xmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function paragraph(text: string, options: { heading?: boolean; bullet?: boolean } = {}) {
  const style = options.heading ? "<w:pStyle w:val=\"Heading1\"/>" : "";
  const numbered = options.bullet ? "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>" : "";
  const rendered = options.bullet ? `• ${text}` : text;
  return `<w:p><w:pPr>${style}${numbered}<w:spacing w:after=\"80\"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii=\"Noto Sans\" w:hAnsi=\"Noto Sans\"/><w:sz w:val=\"20\"/><w:color w:val=\"222222\"/></w:rPr><w:t xml:space=\"preserve\">${xmlText(rendered)}</w:t></w:r></w:p>`;
}

function breakParagraph(type: "column" | "page") {
  return `<w:p><w:r><w:br w:type=\"${type}\"/></w:r></w:p>`;
}

function docxBody(pages: 1 | 2) {
  const left = [
    paragraph("Casey Rivera | Software Engineer"),
    paragraph("Work Experience", { heading: true }),
    paragraph("Orbit Labs — Search Engineer, 2023–2024"),
    paragraph("Built ranking service for 1,200 users.", { bullet: true }),
    paragraph("Cut p95 search latency by 22%.", { bullet: true }),
    paragraph("Harbor Analytics — Research Intern, 2022–2023"),
    paragraph("Evaluated 4 retrieval models at 91% recall.", { bullet: true }),
  ];
  const right = [
    paragraph("casey@example.com · linkedin.com/in/caseyrivera"),
    paragraph("Technical Skills", { heading: true }),
    paragraph("Python, Java, TypeScript.", { bullet: true }),
    paragraph("Accessibility testing.", { bullet: true }),
    paragraph("Projects", { heading: true }),
    paragraph("Campus Access Checker"),
    paragraph("Created accessibility scanner for 40 students.", { bullet: true }),
    paragraph("Documented 18 keyboard-only issues.", { bullet: true }),
  ];
  const body = [...left, breakParagraph("column"), ...right];
  if (pages === 2) {
    body.push(breakParagraph("page"));
    body.push(
      paragraph("Improved keyboard navigation coverage to 96%.", { bullet: true }),
      paragraph("Aster Systems — Software Intern, 2021–2022"),
      paragraph("Automated 18 release checks.", { bullet: true }),
      breakParagraph("column"),
      paragraph("Languages", { heading: true }),
      paragraph("English and Spanish.", { bullet: true }),
    );
  }
  return `${body.join("")}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"720\" w:right=\"720\" w:bottom=\"720\" w:left=\"720\"/><w:cols w:num=\"2\" w:space=\"540\" w:equalWidth=\"1\"/></w:sectPr>`;
}

export async function createTwoColumnDocxFixture(options: { pages?: 1 | 2 } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0"?><w:styles xmlns:w="${wordNs}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="20"/><w:color w:val="222222"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="24"/></w:rPr></w:style></w:styles>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="${wordNs}"><w:body>${docxBody(options.pages ?? 1)}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
