import JSZip from "jszip";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";

export async function createResumeProfileFixture() {
  const zip = await JSZip.loadAsync(await createDocxSourceFixture({ skillsText: "Python, PostgreSQL", identityText: "Riley Example | riley@example.com | +1 (206) 555-0123" }));
  const document = await zip.file("word/document.xml")!.async("string");
  const links = [ ["LinkedIn", "https://www.linkedin.com/in/riley-example"], ["GitHub", "https://github.com/riley-example"], ["Portfolio", "https://riley.example.com"] ];
  const paragraphs = links.map(([label], index) => `<w:p><w:hyperlink r:id="profile${index}"><w:r><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans"/><w:sz w:val="20"/></w:rPr><w:t>${label}</w:t></w:r></w:hyperlink></w:p>`).join("");
  zip.file("word/document.xml", document.replace("<w:sectPr>", `${paragraphs}<w:p><w:r><w:t>Current location: Seattle, WA</w:t></w:r></w:p><w:sectPr>`));
  const relationships = await zip.file("word/_rels/document.xml.rels")!.async("string");
  zip.file("word/_rels/document.xml.rels", relationships.replace("</Relationships>", links.map(([, url], index) => `<Relationship Id="profile${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="${url}"/>`).join("") + "</Relationships>"));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
