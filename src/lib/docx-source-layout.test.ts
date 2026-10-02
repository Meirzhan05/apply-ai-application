import { expect, it } from "vitest";
import type { DocxSourceAnchor, DocxSourceRepresentation, PdfSourceAnchor, PdfSourceRepresentation } from "@/lib/types";
import { mapDocxSourceToPdfLayout } from "@/lib/docx-source-layout";

interface ParagraphSeed {
  text: string;
  kind: DocxSourceAnchor["kind"];
  section: string;
  sectionGroup?: string;
  entry: string;
  entryGroup?: string;
  pageNumber: number;
  regionId: string;
  readingOrder: number;
}

function docxAnchor(seed: ParagraphSeed, paragraphIndex: number, partName = "word/document.xml"): DocxSourceAnchor {
  return {
    id: `docx-anchor-${partName}-${paragraphIndex}`,
    partName,
    paragraphIndex,
    text: seed.text,
    sectionId: `docx-section-${seed.sectionGroup ?? seed.section}`,
    sectionHeading: seed.section,
    entryId: `docx-entry-${seed.entryGroup ?? seed.entry}`,
    entryHeading: seed.entry,
    kind: seed.kind,
    candidateClaim: seed.kind === "bullet",
    editable: seed.kind === "bullet",
    styleHash: `docx-style-${paragraphIndex}`,
    paragraphStyle: { numbered: seed.kind === "bullet" },
  };
}

function pdfAnchor(seed: ParagraphSeed, id = `pdf-anchor-${seed.readingOrder}`): PdfSourceAnchor & { regionId: string; readingOrder: number; repeatedRole?: "header" | "footer" } {
  return Object.assign({
    id,
    text: seed.text,
    sectionId: `pdf-section-${seed.sectionGroup ?? seed.section}`,
    sectionHeading: seed.section,
    entryId: `pdf-entry-${seed.entryGroup ?? seed.entry}`,
    entryHeading: seed.entry,
    kind: seed.kind,
    candidateClaim: seed.kind === "bullet",
    editable: seed.kind === "bullet",
    pageNumber: seed.pageNumber,
    sourceText: seed.kind === "bullet" ? `• ${seed.text}` : seed.text,
    bulletPrefix: seed.kind === "bullet" ? "• " : "",
    boundsPt: { left: 54, top: 40 + seed.readingOrder * 5, right: 200, bottom: 52 + seed.readingOrder * 5 },
    operatorFingerprint: `operator-${seed.readingOrder}`,
    fontResourceName: "NotoSans-Regular",
    font: { family: "Noto Sans", sizePt: 10, bold: false, italic: false },
    styleHash: `pdf-style-${seed.readingOrder}`,
  }, { regionId: seed.regionId, readingOrder: seed.readingOrder });
}

const multiPageSeeds: ParagraphSeed[] = [
  { text: "Work Experience", kind: "section", section: "Work Experience", entry: "Work Experience", pageNumber: 1, regionId: "page-1-column-1", readingOrder: 0 },
  { text: "Orbit Labs — Search Engineer, 2023–2024", kind: "entry", section: "Work Experience", entry: "Orbit Labs — Search Engineer, 2023–2024", pageNumber: 1, regionId: "page-1-column-1", readingOrder: 1 },
  { text: "Built ranking service for 1,200 users.", kind: "bullet", section: "Work Experience", entry: "Orbit Labs — Search Engineer, 2023–2024", pageNumber: 1, regionId: "page-1-column-1", readingOrder: 2 },
  { text: "Projects", kind: "section", section: "Projects", entry: "Projects", pageNumber: 1, regionId: "page-1-column-2", readingOrder: 3 },
  { text: "Campus Access Checker", kind: "entry", section: "Projects", entry: "Campus Access Checker", pageNumber: 1, regionId: "page-1-column-2", readingOrder: 4 },
  { text: "Created accessibility scanner for 40 students.", kind: "bullet", section: "Projects", entry: "Campus Access Checker", pageNumber: 1, regionId: "page-1-column-2", readingOrder: 5 },
  { text: "Improved keyboard navigation coverage to 96%.", kind: "bullet", section: "Projects", entry: "Campus Access Checker", pageNumber: 2, regionId: "page-2-column-1", readingOrder: 6 },
  { text: "Work Experience", kind: "section", section: "Work Experience", sectionGroup: "Work Experience continued", entry: "Work Experience", entryGroup: "Work Experience continued intro", pageNumber: 2, regionId: "page-2-column-1", readingOrder: 7 },
  { text: "Aster Systems — Software Intern, 2021–2022", kind: "entry", section: "Work Experience", sectionGroup: "Work Experience continued", entry: "Aster Systems — Software Intern, 2021–2022", pageNumber: 2, regionId: "page-2-column-1", readingOrder: 8 },
  { text: "Automated 18 release checks.", kind: "bullet", section: "Work Experience", sectionGroup: "Work Experience continued", entry: "Aster Systems — Software Intern, 2021–2022", pageNumber: 2, regionId: "page-2-column-1", readingOrder: 9 },
  { text: "Languages", kind: "section", section: "Languages", entry: "Languages", pageNumber: 2, regionId: "page-2-column-2", readingOrder: 10 },
  { text: "English and Spanish.", kind: "bullet", section: "Languages", entry: "Languages", pageNumber: 2, regionId: "page-2-column-2", readingOrder: 11 },
];

function docxSource(seeds: ParagraphSeed[] = multiPageSeeds): DocxSourceRepresentation {
  const anchors = seeds.map((seed, index) => docxAnchor(seed, index));
  const sections = [...new Map(anchors.map((anchor) => [anchor.sectionId, { id: anchor.sectionId, heading: anchor.sectionHeading, anchorIds: [] as string[] }])).values()];
  for (const anchor of anchors) sections.find((section) => section.id === anchor.sectionId)?.anchorIds.push(anchor.id);
  return {
    version: 1, parser: "docx-ooxml-1", format: "docx", sourceHash: "d".repeat(64), text: seeds.map((seed) => seed.text).join("\n"),
    support: { status: "candidate" }, layout: { columns: 2, sectionCount: 1, pageSizePt: { width: 612, height: 792 }, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 }, fontFamilies: ["Noto Sans"] },
    sections, anchors,
  };
}

function page(pageNumber: number) {
  const makeRegion = (column: number) => ({ id: `page-${pageNumber}-column-${column}`, pageIndex: pageNumber - 1, columnId: `column-${column}`, bounds: { left: column === 1 ? 36 : 306, top: 36, right: column === 1 ? 288 : 576, bottom: 756 }, readingOrder: column - 1 });
  const header = { id: `page-${pageNumber}-header`, pageIndex: pageNumber - 1, columnId: "header", bounds: { left: 36, top: 12, right: 576, bottom: 30 }, readingOrder: 0 };
  return { pageNumber, widthPt: 612, heightPt: 792, rotation: 0, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 }, regions: [header, { ...makeRegion(1), readingOrder: 1 }, { ...makeRegion(2), readingOrder: 2 }] };
}

function pdfBaseline(seeds: ParagraphSeed[] = multiPageSeeds, options: { pageCount?: number; anchors?: Array<PdfSourceAnchor & { regionId: string; readingOrder: number; repeatedRole?: "header" | "footer" }> } = {}): PdfSourceRepresentation {
  const pageCount = options.pageCount ?? 2;
  const layout = Object.assign({ columns: 2, pageCount, pageSizePt: { width: 612, height: 792 }, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 }, fontFamilies: ["Noto Sans"] }, { pages: Array.from({ length: pageCount }, (_, index) => page(index + 1)) });
  return {
    version: 1, parser: "pdfjs-text-1", format: "pdf", sourceHash: "p".repeat(64), text: seeds.map((seed) => seed.text).join("\n"), support: { status: "candidate" }, layout,
    sections: [], anchors: options.anchors ?? seeds.map((seed) => pdfAnchor(seed)),
  };
}

it("maps stable DOCX anchors onto actual pages and columns while preserving section and entry continuity", () => {
  const source = docxSource();
  const result = mapDocxSourceToPdfLayout(source, pdfBaseline());

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.layout.pages).toHaveLength(2);
  expect(result.layout.anchors).toHaveLength(source.anchors.length);
  expect(result.layout.anchors.map((anchor) => anchor.anchorId)).toEqual(source.anchors.map((anchor) => anchor.id));
  const campusIndex = source.anchors.findIndex((anchor) => anchor.text === "Campus Access Checker");
  const campus = result.layout.anchors[campusIndex];
  const continuation = result.layout.anchors[campusIndex + 1];
  expect(campus).toMatchObject({ pageNumber: 1, regionId: "page-1-column-2" });
  expect(continuation).toMatchObject({ pageNumber: 1, regionId: "page-1-column-2" });
  const continuationClaim = source.anchors.find((anchor) => anchor.text.startsWith("Improved keyboard"))!;
  const continuationLayout = result.layout.anchors.find((anchor) => anchor.anchorId === continuationClaim.id)!;
  expect(continuationLayout).toMatchObject({ pageNumber: 2, regionId: "page-2-column-1" });
  expect(continuationLayout.readingOrder).toBeGreaterThan(continuation.readingOrder);
  expect(source.anchors[5].entryId).toBe(source.anchors[6].entryId);
  expect(result.layout.anchors[5].anchorId).toBe(source.anchors[5].id);
});

it("maps a repeated DOCX header only when the matching PDF furniture is present on every page", () => {
  const source = docxSource(multiPageSeeds.slice(0, 1));
  const header = Object.assign(docxAnchor({ ...multiPageSeeds[0], text: "Casey Rivera", kind: "paragraph", section: "word/header1.xml", entry: "word/header1.xml" }, 0, "word/header1.xml"), { repeatedRole: "header" as const });
  source.anchors.push(header);
  const body = pdfAnchor(multiPageSeeds[0]);
  const repeated = [1, 2].map((pageNumber, index) => Object.assign(pdfAnchor({ ...multiPageSeeds[0], text: "Casey Rivera", kind: "paragraph", section: "word/header1.xml", entry: "word/header1.xml", pageNumber,
    regionId: `page-${pageNumber}-header`, readingOrder: 1 + index }, `header-${pageNumber}`), { repeatedRole: "header" as const }));
  const baseline = pdfBaseline(multiPageSeeds.slice(0, 1), { pageCount: 2, anchors: [body, ...repeated] });

  const result = mapDocxSourceToPdfLayout(source, baseline);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.layout.anchors).toHaveLength(3);
  expect(result.layout.anchors.filter((anchor) => anchor.anchorId === header.id).map((anchor) => [anchor.pageNumber, anchor.regionId])).toEqual([
    [1, "page-1-header"], [2, "page-2-header"],
  ]);
  const firstPageOnly = mapDocxSourceToPdfLayout(source, pdfBaseline(multiPageSeeds.slice(0, 1), { pageCount: 2, anchors: [body, repeated[0]] }));
  expect(firstPageOnly).toMatchObject({ status: "blocked", reason: expect.stringMatching(/missing or duplicated on a page/i) });
});

it("maps a one-page header without confusing its rendered heading text with the body identity row", () => {
  const bodySeeds = [{ ...multiPageSeeds[0], text: "Riley Example | riley@example.com", kind: "entry" as const, section: "Résumé", entry: "Riley Example | riley@example.com", pageNumber: 1, regionId: "page-1-column-1", readingOrder: 1 }];
  const source = docxSource(bodySeeds);
  source.anchors[0].entryHeading = "Riley Example | riley@example.com";
  const header = Object.assign(docxAnchor({ ...bodySeeds[0], text: "Confidential candidate record", kind: "paragraph", section: "word/header1.xml", entry: "word/header1.xml" }, 0, "word/header1.xml"), { repeatedRole: "header" as const });
  source.anchors.push(header);
  const body = pdfAnchor({ ...bodySeeds[0], entry: "Confidential candidate record · Riley Example | riley@example.com" });
  const renderedHeader = pdfAnchor({ ...bodySeeds[0], text: "Confidential candidate record", section: "word/header1.xml", entry: "word/header1.xml", kind: "paragraph", regionId: "page-1-header", readingOrder: 0 }, "rendered-header");
  const baseline = pdfBaseline(bodySeeds, { pageCount: 1, anchors: [renderedHeader, body] });

  expect(mapDocxSourceToPdfLayout(source, baseline).status).toBe("supported");
});

it("blocks a missing or extra rendered paragraph instead of producing an incomplete anchor map", () => {
  const source = docxSource(multiPageSeeds.slice(0, 3));
  const missing = mapDocxSourceToPdfLayout(source, pdfBaseline(multiPageSeeds.slice(0, 2), { pageCount: 1 }));
  const extra = mapDocxSourceToPdfLayout(docxSource(multiPageSeeds.slice(0, 2)), pdfBaseline(multiPageSeeds.slice(0, 3), { pageCount: 1 }));

  expect(missing).toMatchObject({ status: "blocked", reason: expect.stringMatching(/anchors.*baseline/i) });
  expect(extra).toMatchObject({ status: "blocked", reason: expect.stringMatching(/anchors.*baseline/i) });
});

it("blocks duplicate text candidates rather than choosing one by accident", () => {
  const source = docxSource(multiPageSeeds.slice(0, 2));
  const duplicate = pdfAnchor({ ...multiPageSeeds[1], readingOrder: 2 }, "duplicate-orbit-title");
  const baseline = pdfBaseline(multiPageSeeds.slice(0, 2), { pageCount: 1, anchors: [...multiPageSeeds.slice(0, 2).map((seed) => pdfAnchor({ ...seed, pageNumber: 1, regionId: "page-1-column-1" })), duplicate] });

  const result = mapDocxSourceToPdfLayout(source, baseline);

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/anchors.*baseline/i) });
});

it("blocks a baseline that changes the employer or project association", () => {
  const source = docxSource(multiPageSeeds.slice(0, 3));
  const wrongSeeds = multiPageSeeds.slice(0, 3).map((seed) => ({ ...seed }));
  wrongSeeds[2].entry = "Campus Access Checker";
  wrongSeeds[2].section = "Projects";

  const result = mapDocxSourceToPdfLayout(source, pdfBaseline(wrongSeeds, { pageCount: 1, anchors: wrongSeeds.map((seed) => pdfAnchor({ ...seed, pageNumber: 1, regionId: "page-1-column-1" })) }));

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/section or employer\/project association|section or entry grouping/i) });
});

it("blocks mismatched repeated header text and an incomplete page region", () => {
  const source = docxSource(multiPageSeeds.slice(0, 1));
  const header = Object.assign(docxAnchor({ ...multiPageSeeds[0], text: "Casey Rivera", kind: "paragraph", section: "word/header1.xml", entry: "word/header1.xml" }, 0, "word/header1.xml"), { repeatedRole: "header" as const });
  source.anchors.push(header);
  const body = pdfAnchor(multiPageSeeds[0]);
  const wrongHeader = Object.assign(pdfAnchor({ ...multiPageSeeds[0], text: "Casey Riveira", kind: "paragraph", section: "word/header1.xml", entry: "word/header1.xml", pageNumber: 1,
    regionId: "page-1-header", readingOrder: 1 }, "wrong-header"), { repeatedRole: "header" as const });
  const mismatch = mapDocxSourceToPdfLayout(source, pdfBaseline(multiPageSeeds.slice(0, 1), { pageCount: 1, anchors: [body, wrongHeader] }));

  const sourceWithoutHeader = docxSource(multiPageSeeds.slice(0, 1));
  const invalidBaseline = pdfBaseline(multiPageSeeds.slice(0, 1), { pageCount: 1 });
  invalidBaseline.anchors[0] = Object.assign({ ...invalidBaseline.anchors[0] }, { regionId: "missing-region", readingOrder: 0 });

  expect(mismatch).toMatchObject({ status: "blocked", reason: expect.stringMatching(/header text/i) });
  expect(mapDocxSourceToPdfLayout(sourceWithoutHeader, invalidBaseline)).toMatchObject({ status: "blocked", reason: expect.stringMatching(/complete page, region/i) });
});
