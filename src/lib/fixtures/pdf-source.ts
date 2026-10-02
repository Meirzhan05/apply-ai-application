import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export async function createPdfSourceFixture(options: { pages?: number; pageSize?: [number, number]; columns?: boolean; scanned?: boolean; duplicateBullet?: boolean; longBullet?: string; separateBulletMarker?: "same-column" | "cross-column" } = {}) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(await readFile(path.join(process.cwd(), "src/assets/fonts/NotoSans-Regular.ttf")), { subset: true });
  const bold = await pdf.embedFont(await readFile(path.join(process.cwd(), "src/assets/fonts/NotoSans-Bold.ttf")), { subset: true });
  const page = pdf.addPage(options.pageSize ?? [612, 792]);
  if (options.scanned) {
    const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b9sAAAAASUVORK5CYII=", "base64");
    const image = await pdf.embedPng(pixel);
    page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
  }
  page.drawText("Avery Chen", { x: 72, y: 744, size: 20, font: bold, color: rgb(0.12, 0.17, 0.24) });
  page.drawText("Machine Learning Engineer", { x: 72, y: 720, size: 11, font: regular, color: rgb(0.12, 0.17, 0.24) });
  page.drawText("avery@example.com · linkedin.com/in/averychen", { x: 72, y: 702, size: 9, font: regular, color: rgb(0.2, 0.2, 0.2) });
  page.drawText("Work Experience", { x: 72, y: 668, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
  page.drawText("Orbit Labs · Machine Learning Engineer, 2024–2025", { x: 72, y: 646, size: 10, font: bold, color: rgb(0.12, 0.17, 0.24) });
  const firstBullet = options.longBullet ?? "Built a search index for 1,200 users.";
  if (options.separateBulletMarker === "same-column") {
    page.drawText("•", { x: 84, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(firstBullet, { x: 102, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  } else if (options.separateBulletMarker === "cross-column") {
    page.drawText("•", { x: 84, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(firstBullet, { x: 400, y: 598, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  } else page.drawText(options.longBullet ?? "• Built a search index for 1,200 users.", { x: 84, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  page.drawText("• Improved retrieval speed by 22%.", { x: 84, y: 614, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  page.drawText("Education", { x: 72, y: 578, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
  page.drawText("B.S. Computer Science, expected 2026", { x: 72, y: 556, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  if (options.duplicateBullet) page.drawText("• Built a search index for 1,200 users.", { x: 320, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  if (options.columns) {
    page.drawText("Technical Skills", { x: 400, y: 668, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
    page.drawText("Created scalable services", { x: 400, y: 646, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText("Implemented API tests", { x: 400, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  }
  for (let index = 1; index < (options.pages ?? 1); index++) {
    const extra = pdf.addPage(options.pageSize ?? [612, 792]);
    extra.drawText(`Additional page ${index + 1}`, { x: 72, y: 744, size: 20, font: bold });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}
