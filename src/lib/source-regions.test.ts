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

it("keeps adjacent PDF.js fragments on one line in their single reading lane", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "line-start", pageIndex: 0, bounds: { left: 46, top: 100, right: 110, bottom: 112 } },
    { id: "separator", pageIndex: 0, bounds: { left: 114, top: 100, right: 117, bottom: 112 } },
    { id: "line-tail", pageIndex: 0, bounds: { left: 120, top: 100, right: 270, bottom: 112 } },
    { id: "next-line", pageIndex: 0, bounds: { left: 46, top: 118, right: 220, bottom: 130 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.assignments.map((item) => item.spanId)).toEqual(["line-start", "separator", "line-tail", "next-line"]);
  expect(new Set(result.assignments.map((item) => item.regionId))).toEqual(new Set(["page-1-column-1"]));
});

it("does not let a disconnected pair of text fragments define a new inline lane", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-lane", pageIndex: 0, bounds: { left: 54, top: 200, right: 180, bottom: 212 } },
    { id: "detached-one", pageIndex: 0, bounds: { left: 330, top: 100, right: 342, bottom: 112 } },
    { id: "detached-two", pageIndex: 0, bounds: { left: 350, top: 100, right: 380, bottom: 112 } },
  ]);

  expect(result).toMatchObject({ status: "blocked", reason: expect.stringMatching(/falls between the detected columns/i), regions: [], assignments: [] });
});

it("keeps page-title rows and right-aligned row metadata with a single body lane", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "header", pageIndex: 0, topFurniture: true, bounds: { left: 229, top: 30, right: 370, bottom: 42 } },
    { id: "role", pageIndex: 0, bounds: { left: 61, top: 100, right: 250, bottom: 114 } },
    { id: "bullet-marker", pageIndex: 0, bounds: { left: 61, top: 140, right: 65, bottom: 154 } },
    { id: "bullet-text", pageIndex: 0, bounds: { left: 116, top: 140, right: 270, bottom: 154 } },
    { id: "date", pageIndex: 0, lineMetadata: true, bounds: { left: 479, top: 100, right: 571, bottom: 114 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.regions).toHaveLength(1);
  expect(result.assignments.map((item) => item.spanId)).toEqual(["header", "role", "date", "bullet-marker", "bullet-text"]);
  expect(new Set(result.assignments.map((item) => item.regionId))).toEqual(new Set(["page-1-column-1"]));
});

it("keeps top-of-page contact furniture in its established right column", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "left-name", pageIndex: 0, topFurniture: true, bounds: { left: 50, top: 20, right: 220, bottom: 34 } },
    { id: "right-contact", pageIndex: 0, topFurniture: true, bounds: { left: 340, top: 20, right: 520, bottom: 32 } },
    { id: "left-role", pageIndex: 0, bounds: { left: 50, top: 100, right: 245, bottom: 114 } },
    { id: "left-bullet-one", pageIndex: 0, bounds: { left: 50, top: 130, right: 250, bottom: 144 } },
    { id: "left-bullet-two", pageIndex: 0, bounds: { left: 70, top: 160, right: 255, bottom: 174 } },
    { id: "right-skills", pageIndex: 0, bounds: { left: 340, top: 100, right: 500, bottom: 114 } },
    { id: "right-project", pageIndex: 0, bounds: { left: 340, top: 130, right: 510, bottom: 144 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  const assignments = new Map(result.assignments.map((item) => [item.spanId, item]));
  expect(assignments.get("right-contact")?.regionId).toBe("page-1-column-2");
  expect(result.assignments.map((item) => item.spanId)).toEqual([
    "left-name", "left-role", "left-bullet-one", "left-bullet-two", "right-contact", "right-skills", "right-project",
  ]);
});

it("assigns furniture spans only once when they are the page's only text", () => {
  const result = groupPositionedSpansIntoRegions([
    { id: "header", pageIndex: 0, topFurniture: true, bounds: { left: 229, top: 30, right: 370, bottom: 42 } },
  ]);

  expect(result.status).toBe("supported");
  if (result.status !== "supported") return;
  expect(result.assignments).toEqual([{ spanId: "header", regionId: "page-1-column-1", readingOrder: 0 }]);
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
