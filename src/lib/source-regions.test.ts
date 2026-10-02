import { expect, it } from "vitest";
import { groupPositionedSpansIntoRegions } from "@/lib/source-regions";

it("groups ordinary two-column spans and reads each column top to bottom", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "right-heading", pageIndex: 0, bounds: { left: 330, top: 40, right: 470, bottom: 54 } },
    { id: "left-heading", pageIndex: 0, bounds: { left: 54, top: 60, right: 190, bottom: 74 } },
    { id: "right-skill", pageIndex: 0, bounds: { left: 330, top: 62, right: 500, bottom: 76 } },
    { id: "left-bullet", pageIndex: 0, bounds: { left: 68, top: 82, right: 280, bottom: 96 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.regions).toEqual([
    { id: "page-1-column-1", pageIndex: 0, columnId: "column-1", bounds: { left: 54, top: 60, right: 280, bottom: 96 }, readingOrder: 0 },
    { id: "page-1-column-2", pageIndex: 0, columnId: "column-2", bounds: { left: 330, top: 40, right: 500, bottom: 76 }, readingOrder: 1 },
  ]);
  expect(result.assignments).toEqual([
    { spanId: "left-heading", regionId: "page-1-column-1", readingOrder: 0 },
    { spanId: "left-bullet", regionId: "page-1-column-1", readingOrder: 1 },
    { spanId: "right-heading", regionId: "page-1-column-2", readingOrder: 2 },
    { spanId: "right-skill", regionId: "page-1-column-2", readingOrder: 3 },
  ]);
});

it("keeps deeply indented bullets inside their original column", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-role", pageIndex: 0, bounds: { left: 54, top: 40, right: 250, bottom: 54 } },
    { id: "left-company", pageIndex: 0, bounds: { left: 54, top: 56, right: 245, bottom: 70 } },
    { id: "left-bullet-one", pageIndex: 0, bounds: { left: 96, top: 62, right: 278, bottom: 76 } },
    { id: "left-bullet-two", pageIndex: 0, bounds: { left: 96, top: 80, right: 270, bottom: 94 } },
    { id: "right-heading", pageIndex: 0, bounds: { left: 330, top: 40, right: 450, bottom: 54 } },
    { id: "right-skill-one", pageIndex: 0, bounds: { left: 330, top: 62, right: 488, bottom: 76 } },
    { id: "right-skill-two", pageIndex: 0, bounds: { left: 330, top: 80, right: 480, bottom: 94 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.regions.map((region) => region.columnId)).toEqual(["column-1", "column-2"]);
  expect(result.assignments.filter((item) => item.spanId.startsWith("left-")).map((item) => item.regionId)).toEqual([
    "page-1-column-1", "page-1-column-1", "page-1-column-1", "page-1-column-1",
  ]);
});

it("keeps ordinary indented content in one column and follows its vertical order", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "bullet", pageIndex: 0, bounds: { left: 88, top: 92, right: 280, bottom: 106 } },
    { id: "role", pageIndex: 0, bounds: { left: 72, top: 54, right: 260, bottom: 68 } },
    { id: "heading", pageIndex: 0, bounds: { left: 54, top: 32, right: 170, bottom: 46 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.regions).toMatchObject([{ id: "page-1-column-1", columnId: "column-1", readingOrder: 0 }]);
  expect(result.assignments).toEqual([
    { spanId: "heading", regionId: "page-1-column-1", readingOrder: 0 },
    { spanId: "role", regionId: "page-1-column-1", readingOrder: 1 },
    { spanId: "bullet", regionId: "page-1-column-1", readingOrder: 2 },
  ]);
});

it("keeps page regions distinct while maintaining document-wide reading order", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "p2-right-a", pageIndex: 1, bounds: { left: 330, top: 36, right: 470, bottom: 50 } },
    { id: "p1-left-a", pageIndex: 0, bounds: { left: 54, top: 36, right: 230, bottom: 50 } },
    { id: "p2-left-a", pageIndex: 1, bounds: { left: 54, top: 36, right: 230, bottom: 50 } },
    { id: "p1-right-a", pageIndex: 0, bounds: { left: 330, top: 36, right: 470, bottom: 50 } },
    { id: "p2-left-b", pageIndex: 1, bounds: { left: 54, top: 58, right: 230, bottom: 72 } },
    { id: "p2-right-b", pageIndex: 1, bounds: { left: 330, top: 58, right: 470, bottom: 72 } },
    { id: "p1-left-b", pageIndex: 0, bounds: { left: 54, top: 58, right: 230, bottom: 72 } },
    { id: "p1-right-b", pageIndex: 0, bounds: { left: 330, top: 58, right: 470, bottom: 72 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.regions.map(({ id, readingOrder }) => [id, readingOrder])).toEqual([
    ["page-1-column-1", 0], ["page-1-column-2", 1], ["page-2-column-1", 0], ["page-2-column-2", 1],
  ]);
  expect(result.assignments.map(({ spanId, readingOrder }) => [spanId, readingOrder])).toEqual([
    ["p1-left-a", 0], ["p1-left-b", 1], ["p1-right-a", 2], ["p1-right-b", 3],
    ["p2-left-a", 4], ["p2-left-b", 5], ["p2-right-a", 6], ["p2-right-b", 7],
  ]);
});

it("blocks text that physically overlaps across detected columns", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-one", pageIndex: 0, bounds: { left: 54, top: 40, right: 350, bottom: 54 } },
    { id: "left-two", pageIndex: 0, bounds: { left: 54, top: 62, right: 250, bottom: 76 } },
    { id: "right-one", pageIndex: 0, bounds: { left: 330, top: 40, right: 500, bottom: 54 } },
    { id: "right-two", pageIndex: 0, bounds: { left: 330, top: 62, right: 500, bottom: 76 } },
  ]);

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/overlaps on the page/i), regions: [], assignments: [] });
});

it("blocks an anchor whose position is equally compatible with either column", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-one", pageIndex: 0, bounds: { left: 54, top: 40, right: 180, bottom: 54 } },
    { id: "left-two", pageIndex: 0, bounds: { left: 54, top: 62, right: 180, bottom: 76 } },
    { id: "ambiguous", pageIndex: 0, bounds: { left: 192, top: 82, right: 300, bottom: 96 } },
    { id: "right-one", pageIndex: 0, bounds: { left: 330, top: 40, right: 470, bottom: 54 } },
    { id: "right-two", pageIndex: 0, bounds: { left: 330, top: 62, right: 470, bottom: 76 } },
  ]);

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/between the detected columns/i), regions: [], assignments: [] });
});

it("blocks an anchor tied between columns even when both distances are within tolerance", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-one", pageIndex: 0, bounds: { left: 50, top: 40, right: 105, bottom: 54 } },
    { id: "left-two", pageIndex: 0, bounds: { left: 50, top: 62, right: 105, bottom: 76 } },
    { id: "right-one", pageIndex: 0, bounds: { left: 170, top: 40, right: 225, bottom: 54 } },
    { id: "right-two", pageIndex: 0, bounds: { left: 170, top: 62, right: 225, bottom: 76 } },
    { id: "ambiguous", pageIndex: 0, bounds: { left: 110, top: 84, right: 160, bottom: 98 } },
  ]);

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/between the detected columns/i), regions: [], assignments: [] });
});

it("blocks three substantial text columns instead of flattening them into one", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-one", pageIndex: 0, bounds: { left: 50, top: 40, right: 175, bottom: 54 } },
    { id: "left-two", pageIndex: 0, bounds: { left: 50, top: 62, right: 175, bottom: 76 } },
    { id: "middle-one", pageIndex: 0, bounds: { left: 260, top: 40, right: 385, bottom: 54 } },
    { id: "middle-two", pageIndex: 0, bounds: { left: 260, top: 62, right: 385, bottom: 76 } },
    { id: "right-one", pageIndex: 0, bounds: { left: 470, top: 40, right: 590, bottom: 54 } },
    { id: "right-two", pageIndex: 0, bounds: { left: 470, top: 62, right: 590, bottom: 76 } },
  ]);

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/more than two distinct text columns/i), regions: [], assignments: [] });
});
