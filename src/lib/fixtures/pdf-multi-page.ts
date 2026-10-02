import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** A two-page single-column source with a work entry continuing at the page boundary. */
export async function createPdfMultiPageFixture() {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(await readFile(path.join(process.cwd(), "src/assets/fonts/NotoSans-Regular.ttf")), { subset: true });
  const bold = await pdf.embedFont(await readFile(path.join(process.cwd(), "src/assets/fonts/NotoSans-Bold.ttf")), { subset: true });
  const drawText = (page: ReturnType<typeof pdf.addPage>, text: string, x: number, y: number, size = 10, font = regular) =>
    page.drawText(text, { x, y, size, font, color: rgb(0.15, 0.18, 0.22) });

  const first = pdf.addPage([612, 792]);
  drawText(first, "Avery Chen | Résumé", 72, 764, 9, bold);
  drawText(first, "Experience", 72, 718, 12, bold);
  drawText(first, "Orbit Labs · Machine Learning Engineer, 2024–2025", 72, 692, 10, bold);
  drawText(first, "• Built a search index for 1,200 users.", 84, 674);
  drawText(first, "Avery Chen · Confidential", 72, 24, 8);

  const second = pdf.addPage([612, 792]);
  drawText(second, "Avery Chen | Résumé", 72, 764, 9, bold);
  drawText(second, "• Improved retrieval speed by 22%.", 84, 718);
  drawText(second, "Northstar Project · Research Assistant", 72, 686, 10, bold);
  drawText(second, "• Implemented an evaluation pipeline for 4 datasets.", 84, 668);
  drawText(second, "Education", 72, 626, 12, bold);
  drawText(second, "B.S. Computer Science, expected 2026", 72, 604);
  drawText(second, "Avery Chen · Confidential", 72, 24, 8);

  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}
