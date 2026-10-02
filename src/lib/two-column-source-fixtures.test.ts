import { expect, it } from "vitest";
import { createTwoColumnDocxFixture, createTwoColumnPdfFixture } from "@/lib/fixtures/two-column-resume";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";

it("builds a text PDF with sidebar content and a continuation on its second page", async () => {
  const source = await parsePdfSource(await createTwoColumnPdfFixture({ pages: 2 }));

  expect(source.text).toContain("Orbit Labs — Search Engineer, 2023–2024");
  expect(source.text).toContain("Campus Access Checker");
  expect(source.text).toContain("Technical Skills");
  expect(source.text).toContain("Improved keyboard navigation coverage to 96%.");
  expect(source.layout).toMatchObject({ columns: 2, pageCount: 2 });
  expect(source.support.status).toBe("candidate");

  const positioned = source as unknown as { anchors: Array<{ text: string; entryId: string; pageNumber: number; regionId: string; readingOrder: number }>;
    layout: { pages: Array<{ pageNumber: number; regions: Array<{ id: string; columnId: string }> }> } };
  expect(positioned.layout.pages.map((page) => [page.pageNumber, page.regions.map((region) => region.columnId)])).toEqual([
    [1, ["column-1", "column-2"]], [2, ["column-1", "column-2"]],
  ]);
  const orbit = positioned.anchors.find((anchor) => anchor.text.includes("Built ranking service for 1,200 users."));
  const campus = positioned.anchors.find((anchor) => anchor.text.includes("Created accessibility scanner for 40 students."));
  const continuation = positioned.anchors.find((anchor) => anchor.text.includes("Improved keyboard navigation coverage to 96%."));
  expect(orbit).toMatchObject({ pageNumber: 1, regionId: "page-1-column-1" });
  expect(campus).toMatchObject({ pageNumber: 1, regionId: "page-1-column-2" });
  expect(continuation).toMatchObject({ pageNumber: 2, regionId: "page-2-column-1" });
  expect(orbit!.entryId).not.toBe(campus!.entryId);
  expect(continuation!.entryId).toBe(campus!.entryId);
  expect(orbit!.readingOrder).toBeLessThan(campus!.readingOrder);
});

it("builds an ordinary two-column DOCX with distinct entries and the same continuation", async () => {
  const source = await parseDocxSource(await createTwoColumnDocxFixture({ pages: 2 }));

  expect(source.text).toContain("Orbit Labs — Search Engineer, 2023–2024");
  expect(source.text).toContain("Campus Access Checker");
  expect(source.text).toContain("Technical Skills");
  expect(source.text).toContain("Improved keyboard navigation coverage to 96%.");
  expect(source.layout).toMatchObject({ columns: 2 });
  expect(source.support.status).toBe("candidate");
  const orbit = source.anchors.find((anchor) => anchor.text.includes("Built ranking service for 1,200 users."));
  const campus = source.anchors.find((anchor) => anchor.text.includes("Created accessibility scanner for 40 students."));
  const continuation = source.anchors.find((anchor) => anchor.text.includes("Improved keyboard navigation coverage to 96%."));
  expect(orbit?.entryId).toBeTruthy();
  expect(campus?.entryId).toBeTruthy();
  expect(orbit!.entryId).not.toBe(campus!.entryId);
  expect(continuation?.entryId).toBe(campus?.entryId);
  // Browser intake cannot know pagination; the worker supplies the rendered map.
  expect(source.anchors.every((anchor) => !("pageNumber" in anchor) && !("regionId" in anchor))).toBe(true);
});
