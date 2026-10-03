import { expect, it } from "vitest";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { parsePdfSource, suggestPdfFacts } from "@/lib/pdf-source";

it("inspects complete readable PDF content into stable source-bound anchors", async () => {
  const bytes = await createPdfSourceFixture();
  const source = await parsePdfSource(bytes);
  const repeated = await parsePdfSource(bytes);

  expect(source).toMatchObject({ format: "pdf", parser: "pdfjs-text-3", version: 3, support: { status: "candidate" }, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(source.text).toContain("avery@example.com");
  expect(source.text).toContain("linkedin.com/in/averychen");
  expect(source.text).toContain("Work Experience");
  expect(source.text).toContain("2024–2025");
  expect(source.text).toContain("expected 2026");
  expect(source.layout).toMatchObject({ pageCount: 1, columns: 1, pageSizePt: { width: 612, height: 792 } });
  expect(source.layout.pages).toHaveLength(1);
  expect(source.sections.map((section) => section.heading)).toEqual(["Résumé", "Work Experience", "Education"]);
  const bullet = source.anchors.find((anchor) => anchor.text === "Built a search index for 1,200 users.");
  expect(bullet).toMatchObject({ kind: "bullet", candidateClaim: true, editable: true, sourceText: "• Built a search index for 1,200 users.", pageNumber: 1,
    regionId: "page-1-column-1", readingOrder: expect.any(Number),
    boundsPt: { left: 84, top: expect.any(Number), right: expect.any(Number), bottom: expect.any(Number) },
    font: { family: expect.stringMatching(/noto sans/i), sizePt: 10, bold: false, italic: false } });
  expect(bullet?.operatorFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(repeated.anchors.map((anchor) => anchor.id)).toEqual(source.anchors.map((anchor) => anchor.id));
  expect(suggestPdfFacts(source)).toContainEqual(expect.objectContaining({ sourceAnchorId: bullet?.id }));
});

it("blocks image-only PDFs and maps every page and text column for readable sources", async () => {
  const [scanned, multipage, columns] = await Promise.all([
    parsePdfSource(await createPdfSourceFixture({ scanned: true })),
    parsePdfSource(await createPdfSourceFixture({ pages: 2 })),
    parsePdfSource(await createPdfSourceFixture({ columns: true })),
  ]);
  expect(scanned.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/scanned|image-only/i) });
  expect(scanned.text).toBe("");
  expect(multipage.support).toEqual({ status: "candidate" });
  expect(multipage.layout.pageCount).toBe(2);
  expect(multipage.layout.pages).toHaveLength(2);
  expect(multipage.anchors.every((anchor) => anchor.regionId && anchor.readingOrder !== undefined)).toBe(true);
  expect(columns.support).toEqual({ status: "candidate" });
  expect(columns.layout.columns).toBe(2);
  expect(columns.layout.pages?.[0].regions.map((region) => region.columnId)).toEqual(["column-1", "column-2"]);
});

it("keeps a second-page right-column section in its original column near the top edge", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ pages: 2, pageTwoRightTop: true }));
  const heading = source.anchors.find((anchor) => anchor.text === "Technical Skills");
  const skill = source.anchors.find((anchor) => anchor.text === "Updated tooling");

  expect(source.support).toEqual({ status: "candidate" });
  expect(heading).toMatchObject({ pageNumber: 2, regionId: "page-2-column-2" });
  expect(skill).toMatchObject({ pageNumber: 2, regionId: "page-2-column-2" });
  expect(new Set(source.anchors.map((anchor) => anchor.id)).size).toBe(source.anchors.length);
});

it("keeps complete long source text but blocks bullets too long to safely edit", async () => {
  const longBullet = `• Built a search index for 1,200 users. ${"Relevant detail. ".repeat(35)}`;
  const source = await parsePdfSource(await createPdfSourceFixture({ longBullet }));
  const bullet = source.anchors.find((anchor) => anchor.sourceText === longBullet);
  expect(source.text).toContain(longBullet);
  expect(bullet).toMatchObject({ candidateClaim: true, editable: false });
  expect(source.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/extends outside|too long|source font\/layout/i) });
});

it("suggests confirmation for unbulleted skills and recognizes shared Languages section semantics", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ qualificationText: "Python, scikit-learn, and PostgreSQL", languages: true }));
  const skills = source.anchors.find((anchor) => anchor.text === "Python, scikit-learn, and PostgreSQL");
  const heading = source.anchors.find((anchor) => anchor.text === "Languages");
  const proficiency = source.anchors.find((anchor) => anchor.text === "English and Spanish");

  expect(skills?.candidateClaim).toBe(true);
  expect(heading).toMatchObject({ kind: "section", candidateClaim: false });
  expect(proficiency?.candidateClaim).toBe(true);
  expect(suggestPdfFacts(source).map((suggestion) => suggestion.sourceAnchorId)).toEqual(expect.arrayContaining([skills!.id, proficiency!.id]));
});

it("pairs a separate typographic bullet marker with the nearest same-line text in its original column", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ separateBulletMarker: "same-column" }));
  const bullet = source.anchors.find((anchor) => anchor.text === "Built a search index for 1,200 users.");

  expect(source.support).toMatchObject({ status: "candidate" });
  expect(bullet).toMatchObject({ kind: "bullet", candidateClaim: true, editable: true, bulletPrefix: "", sourceText: "Built a search index for 1,200 users." });
  expect(source.anchors.some((anchor) => anchor.text === "")).toBe(false);
  expect(source.text).toContain("• Built a search index for 1,200 users.");
});

it("does not pair a standalone bullet marker with text in another column", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ columns: true, separateBulletMarker: "cross-column" }));

  expect(source.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/same page and column/i) });
});

it("blocks duplicate bullet text whose PDF operator cannot be uniquely mapped", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ duplicateBullet: true }));
  const bullets = source.anchors.filter((anchor) => anchor.sourceText === "• Built a search index for 1,200 users.");
  expect(bullets).toHaveLength(2);
  expect(bullets.every((anchor) => !anchor.editable)).toBe(true);
  expect(source.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/repeats identical/i) });
});

it("blocks oversized pages before the renderer allocates large comparison images", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ pageSize: [1200, 1800] }));

  expect(source.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/bounded page-size profile/i) });
});
