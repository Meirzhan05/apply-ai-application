import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, lineTo, moveTo, rgb, setFontAndSize, setLineWidth, setTextMatrix, stroke } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export async function createPdfSourceFixture(options: { pages?: number; pageSize?: [number, number]; columns?: boolean; scanned?: boolean; duplicateBullet?: boolean; longBullet?: string; separateBulletMarker?: "same-column" | "cross-column"; qualificationText?: string; languages?: boolean; fragmentedSkillCategories?: boolean; positionedWordSpacing?: boolean; sectionDivider?: boolean; pageTwoRightTop?: boolean; characterSpacing?: number; wordSpacing?: number; horizontalScaling?: number; graphicsStateRestore?: boolean } = {}) {
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
  if (options.sectionDivider) {
    page.pushOperators(setLineWidth(0.75), moveTo(72, 658), lineTo(540, 658), stroke());
  }
  page.drawText("Orbit Labs · Machine Learning Engineer, 2024–2025", { x: 72, y: 646, size: 10, font: bold, color: rgb(0.12, 0.17, 0.24) });
  const firstBullet = options.longBullet ?? "Built a search index for 1,200 users.";
  if (options.separateBulletMarker === "same-column") {
    page.drawText("•", { x: 84, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(firstBullet, { x: 102, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  } else if (options.separateBulletMarker === "cross-column") {
    page.drawText("•", { x: 84, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(firstBullet, { x: 400, y: 598, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  } else if (options.positionedWordSpacing) {
    const fontName = PDFName.of(regular.name);
    const tailFontName = PDFName.of(bold.name);
    page.node.setFontDictionary(fontName, regular.ref);
    page.node.setFontDictionary(tailFontName, bold.ref);
    const parts = ["•", "Built", "a", "search", "index", "for", "1,200", "users."];
    const text = PDFArray.withContext(pdf.context);
    const spaceAdjustment = -(regular.widthOfTextAtSize(" ", 10) * 1000) / 10;
    const textSpacing: PDFOperator[] = [];
    if (options.characterSpacing !== undefined && !options.graphicsStateRestore) textSpacing.push(PDFOperator.of(PDFOperatorNames.SetCharacterSpacing, [PDFNumber.of(options.characterSpacing)]));
    if (options.wordSpacing !== undefined) textSpacing.push(PDFOperator.of(PDFOperatorNames.SetWordSpacing, [PDFNumber.of(options.wordSpacing)]));
    if (options.horizontalScaling !== undefined) textSpacing.push(PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(options.horizontalScaling)]));
    const spacingStateRestore = options.graphicsStateRestore && options.characterSpacing !== undefined
      ? [PDFOperator.of(PDFOperatorNames.BeginText), PDFOperator.of(PDFOperatorNames.SetCharacterSpacing, [PDFNumber.of(options.characterSpacing)]), PDFOperator.of(PDFOperatorNames.EndText),
        PDFOperator.of(PDFOperatorNames.PushGraphicsState), PDFOperator.of(PDFOperatorNames.BeginText), PDFOperator.of(PDFOperatorNames.SetCharacterSpacing, [PDFNumber.of(0)]),
        PDFOperator.of(PDFOperatorNames.EndText), PDFOperator.of(PDFOperatorNames.PopGraphicsState)]
      : [];
    parts.forEach((part, index) => {
      text.push(regular.encodeText(part));
      if (index < parts.length - 1) text.push(PDFNumber.of(spaceAdjustment));
    });
    page.pushOperators(
      ...spacingStateRestore, PDFOperator.of(PDFOperatorNames.BeginText), ...textSpacing, setFontAndSize(fontName, 10), setTextMatrix(1, 0, 0, 1, 84, 630),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [text]),
      setFontAndSize(tailFontName, 10), PDFOperator.of(PDFOperatorNames.ShowText, [bold.encodeText("kept")]), PDFOperator.of(PDFOperatorNames.EndText),
    );
  } else page.drawText(options.longBullet ?? "• Built a search index for 1,200 users.", { x: 84, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  page.drawText("• Improved retrieval speed by 22%.", { x: 84, y: 614, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  page.drawText("Education", { x: 72, y: 578, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
  page.drawText("B.S. Computer Science, expected 2026", { x: 72, y: 556, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  if (options.qualificationText) page.drawText(options.qualificationText, { x: 72, y: 536, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  if (options.languages) {
    page.drawText("Languages", { x: 72, y: 512, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
    page.drawText("English and Spanish", { x: 72, y: 490, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  }
  if (options.fragmentedSkillCategories) {
    page.drawText("Technical Skills", { x: 72, y: 474, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
    const categories = [["Languages", ": Python, Java, SQL"], ["Frameworks", ": React, FastAPI"], ["Tools", ": Git, Docker"], ["Libraries", ": NumPy, pandas"]] as const;
    categories.forEach(([label, value], index) => {
      const y = 452 - index * 16;
      page.drawText(label, { x: 72, y, size: 9, font: bold, color: rgb(0.2, 0.2, 0.2) });
      page.drawText(value, { x: 72 + bold.widthOfTextAtSize(label, 9) + 3, y, size: 9, font: regular, color: rgb(0.2, 0.2, 0.2) });
    });
    page.drawText("|", { x: 84, y: 336, size: 9, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText("Projects", { x: 72, y: 382, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
    page.drawText("Tools", { x: 72, y: 360, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  }
  if (options.duplicateBullet) page.drawText("• Built a search index for 1,200 users.", { x: 320, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  if (options.columns) {
    page.drawText("Technical Skills", { x: 400, y: 668, size: 12, font: bold, color: rgb(0.12, 0.17, 0.24) });
    page.drawText("Created scalable services", { x: 400, y: 646, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
    page.drawText("Implemented API tests", { x: 400, y: 630, size: 10, font: regular, color: rgb(0.2, 0.2, 0.2) });
  }
  for (let index = 1; index < (options.pages ?? 1); index++) {
    const extra = pdf.addPage(options.pageSize ?? [612, 792]);
    extra.drawText(`Additional page ${index + 1}`, { x: 72, y: 744, size: 20, font: bold });
    if (options.pageTwoRightTop && index === 1) {
      extra.drawText("Experience continuation", { x: 72, y: 716, size: 10, font: regular });
      extra.drawText("Technical Skills", { x: 400, y: 744, size: 12, font: bold });
      extra.drawText("Updated tooling", { x: 400, y: 716, size: 10, font: regular });
    }
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}
