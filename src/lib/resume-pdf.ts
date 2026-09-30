import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ApplicationPacket, Profile } from "@/lib/types";

async function fonts(doc: PDFDocument) {
  doc.registerFontkit(fontkit);
  const weights = ["Regular", "Bold"];
  const bytes = await Promise.all(weights.map((weight) => readFile(path.join(process.cwd(), "src", "assets", "fonts", `NotoSans-${weight}.ttf`))));
  // PDF object references must be allocated in a fixed order, regardless of
  // which font read finishes first.
  const regular = await doc.embedFont(bytes[0], { subset: true, customName: "NotoSans-Regular" });
  const bold = await doc.embedFont(bytes[1], { subset: true, customName: "NotoSans-Bold" });
  return { regular, bold };
}

function wrapped(text: string, font: PDFFont, size: number, width = 492): string[] {
  const supported = new Set(font.getCharacterSet());
  if ([...text].some((character) => !/\s/.test(character) && !supported.has(character.codePointAt(0)!))) throw new Error("The PDF font does not support a character in this packet. Edit the spelling or use a supported resume before filling.");
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    for (const character of word) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) { lines.push(line); line = ""; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function resumePdf(
  profile: Profile,
  packet: ApplicationPacket,
): Promise<Buffer> {
  // Avoid clock-dependent metadata so the reviewed and uploaded bytes agree.
  const doc = await PDFDocument.create({ updateMetadata: false });
  const { regular: font, bold } = await fonts(doc);
  let page = doc.addPage([612, 792]);
  let y = 735;
  const ink = rgb(0.06, 0.2, 0.19);
  const draw = (text: string, size = 11, heading = false) => {
    const activeFont = heading ? bold : font;
    for (const line of wrapped(text, activeFont, size)) {
        if (y < 70) {
          page = doc.addPage([612, 792]);
          y = 735;
        }
        page.drawText(line, { x: 60, y, size, font: activeFont, color: ink });
        y -= size + 6;
    }
    y -= 3;
  };

  draw(profile.name || "Applicant", 22, true);
  draw([profile.email, profile.phone].filter(Boolean).join("  |  "), 10);
  y -= 18;
  if (profile.school) {
    draw("EDUCATION", 11, true);
    draw(
      `${profile.school}${profile.graduationYear ? ` | Class of ${profile.graduationYear}` : ""}`,
      11,
    );
    y -= 12;
  }
  if (profile.skills.length) {
    draw("SKILLS", 11, true);
    draw(profile.skills.join(" | "), 11);
    y -= 12;
  }
  draw("SELECTED EXPERIENCE & PROJECTS", 11, true);
  packet.resumeLines.forEach((line) => draw(`- ${line.text}`, 11));
  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export async function coverLetterPdf(letter: string): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const { regular: font } = await fonts(doc);
  let page = doc.addPage([612, 792]);
  let y = 735;
  for (const paragraph of letter.split("\n")) {
    if (!paragraph) {
      y -= 11;
      continue;
    }
    for (const line of wrapped(paragraph, font, 11)) {
        if (y < 70) {
          page = doc.addPage([612, 792]);
          y = 735;
        }
        page.drawText(line, { x: 60, y, size: 11, font });
        y -= 17;
    }
  }
  return Buffer.from(await doc.save());
}
