import JSZip from "jszip";

const wordNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";

export async function createDocxSourceFixture(options: { table?: boolean; columns?: number; longText?: string; font?: string; externalResource?: boolean; expandedPayload?: string; headerText?: string; multiPage?: boolean; secondExperience?: boolean; languages?: boolean; skillsText?: string; skillsAsHeading?: boolean } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>${options.headerText ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}</Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${relationships}"><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${options.headerText ? '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ""}${options.externalResource ? '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.invalid/image.png" TargetMode="External"/>' : ""}</Relationships>`);
  zip.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering xmlns:w="${wordNs}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  const font = options.font ?? "Noto Sans";
  zip.file("word/styles.xml", `<w:styles xmlns:w="${wordNs}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="20"/><w:color w:val="222222"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`);
  const p = (text: string, style = "Normal", bullet = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${bullet ? "<w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr>" : ""}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const body = [
    p("Riley Example | riley@example.com"),
    p("Experience", "Heading1"),
    p("Orbit Labs — ML Intern | June–August 2026"),
    p(options.longText ?? "Built a recommender with 92% precision.", "Normal", true),
    ...(options.multiPage ? [pageBreak, p("Improved model recall to 94%.", "Normal", true)] : []),
    ...(options.secondExperience ? [p("Aster Research — Data Assistant | 2024–2025"), p("Maintained campaign data quality checks.", "Normal", true)] : []),
    p("Education", "Heading1"),
    p("State University — B.S. Computer Science"),
    ...(options.skillsText ? [p("Technical Skills", "Heading1"), p(options.skillsText, options.skillsAsHeading ? "Heading1" : "Normal")] : []),
    ...(options.languages ? [p("Languages", "Heading1"), p("English and Spanish")] : []),
  ];
  const content = options.table ? `<w:tbl><w:tr><w:tc>${body[0]}</w:tc></w:tr></w:tbl>${body.slice(1).join("")}` : body.join("");
  const cols = options.columns ? `<w:cols w:num="${options.columns}"/>` : '<w:cols w:num="1"/>';
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="${wordNs}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${content}<w:sectPr>${options.headerText ? '<w:headerReference w:type="default" r:id="rIdHeader"/>' : ""}<w:pgSz w:w="12240" w:h="15840"/>${cols}<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`);
  if (options.headerText) zip.file("word/header1.xml", `<?xml version="1.0"?><w:hdr xmlns:w="${wordNs}">${p(options.headerText)}</w:hdr>`);
  zip.file("customXml/item1.xml", "<custom>keep these package bytes</custom>");
  if (options.expandedPayload) zip.file("customXml/large.bin", options.expandedPayload);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
