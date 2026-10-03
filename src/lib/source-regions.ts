export interface SourceBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PositionedSourceSpan {
  id: string;
  pageIndex: number;
  bounds: SourceBounds;
  /** Header spans stay out of column detection and attach to their visual lane. */
  topFurniture?: boolean;
  /** Right-aligned date/location spans follow the unique body lane on the same row. */
  lineMetadata?: boolean;
}

export interface SourceTextRegion {
  id: string;
  pageIndex: number;
  columnId: string;
  bounds: SourceBounds;
  /** Zero-based left-to-right order among regions on this page. */
  readingOrder: number;
}

export interface SourceSpanAssignment {
  spanId: string;
  regionId: string;
  /** Zero-based source reading order across the document. */
  readingOrder: number;
}

export type SourceRegionGrouping =
  | { status: "supported"; regions: SourceTextRegion[]; assignments: SourceSpanAssignment[] }
  | { status: "blocked"; reason: string; regions: []; assignments: [] };

const ALIGNMENT_TOLERANCE_PT = 48;
const COLUMN_SEPARATION_PT = 120;
const MIN_VERTICAL_EVIDENCE_PT = 24;
const MAX_COLUMN_ASSIGNMENT_DISTANCE_PT = 64;
const MIN_COLUMN_ASSIGNMENT_MARGIN_PT = 12;
const OVERLAP_TOLERANCE_PT = 1;

interface StartCluster {
  left: number;
  spans: PositionedSourceSpan[];
}

interface Column {
  left: number;
  spans: PositionedSourceSpan[];
}

function invalid(reason: string): SourceRegionGrouping {
  return { status: "blocked", reason, regions: [], assignments: [] };
}

function validSpan(span: PositionedSourceSpan): boolean {
  const { left, top, right, bottom } = span.bounds;
  return Boolean(span.id.trim())
    && Number.isInteger(span.pageIndex) && span.pageIndex >= 0
    && [left, top, right, bottom].every(Number.isFinite)
    && right > left && bottom > top;
}

function clusterByStart(spans: PositionedSourceSpan[]): StartCluster[] {
  const clusters: StartCluster[] = [];
  for (const span of [...spans].sort((a, b) => a.bounds.left - b.bounds.left || a.id.localeCompare(b.id))) {
    const last = clusters.at(-1);
    if (!last || span.bounds.left - last.left > ALIGNMENT_TOLERANCE_PT) {
      clusters.push({ left: span.bounds.left, spans: [span] });
      continue;
    }
    last.spans.push(span);
    last.left = last.spans.reduce((sum, item) => sum + item.bounds.left, 0) / last.spans.length;
  }
  return clusters;
}

function verticalOverlap(a: StartCluster, b: StartCluster): number {
  const aTop = Math.min(...a.spans.map((span) => span.bounds.top));
  const aBottom = Math.max(...a.spans.map((span) => span.bounds.bottom));
  const bTop = Math.min(...b.spans.map((span) => span.bounds.top));
  const bBottom = Math.max(...b.spans.map((span) => span.bounds.bottom));
  return Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
}

function candidateColumns(spans: PositionedSourceSpan[]): Column[] | undefined {
  const starts = clusterByStart(spans).filter((cluster) => cluster.spans.length >= 2);
  const paired = new Set<StartCluster>();
  for (let first = 0; first < starts.length; first++) {
    for (let second = first + 1; second < starts.length; second++) {
      const a = starts[first];
      const b = starts[second];
      if (b.left - a.left < COLUMN_SEPARATION_PT) continue;
      // Either spatially distinct text lanes across a page, or repeated alignment
      // at the same vertical positions, is enough to establish two columns.
      if (verticalOverlap(a, b) >= MIN_VERTICAL_EVIDENCE_PT || b.left - a.left >= COLUMN_SEPARATION_PT * 1.5) {
        paired.add(a);
        paired.add(b);
      }
    }
  }
  if (!paired.size) return undefined;
  const columns = [...paired]
    .sort((a, b) => a.left - b.left)
    .map((cluster) => ({ left: cluster.left, spans: cluster.spans }));
  return columns;
}

function boundsFor(spans: PositionedSourceSpan[]): SourceBounds {
  return {
    left: Math.min(...spans.map((span) => span.bounds.left)),
    top: Math.min(...spans.map((span) => span.bounds.top)),
    right: Math.max(...spans.map((span) => span.bounds.right)),
    bottom: Math.max(...spans.map((span) => span.bounds.bottom)),
  };
}

function spansOverlap(a: PositionedSourceSpan, b: PositionedSourceSpan): boolean {
  return Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left) > OVERLAP_TOLERANCE_PT
    && Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top) > OVERLAP_TOLERANCE_PT;
}

function inlineContinuationLinkedToLane(span: PositionedSourceSpan, spans: PositionedSourceSpan[], laneLeft: number): boolean {
  const pending = [span];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (Math.abs(current.bounds.left - laneLeft) <= MAX_COLUMN_ASSIGNMENT_DISTANCE_PT) return true;
    for (const candidate of spans) {
      if (visited.has(candidate.id) || Math.abs(candidate.bounds.top - current.bounds.top) > 1.5 || spansOverlap(candidate, current) === false &&
          Math.min(candidate.bounds.bottom, current.bounds.bottom) - Math.max(candidate.bounds.top, current.bounds.top) <= 2) continue;
      const gap = Math.max(0, Math.max(candidate.bounds.left, current.bounds.left) - Math.min(candidate.bounds.right, current.bounds.right));
      if (gap <= 18) pending.push(candidate);
    }
  }
  return false;
}

/**
 * Assigns positioned text to deterministic page columns and reconstructs
 * reading order as top-to-bottom within each column, then left-to-right.
 * It intentionally blocks uncertain assignments instead of merging unrelated
 * entries or guessing at a third column.
 */
export function groupPositionedSpansIntoRegions(spans: PositionedSourceSpan[]): SourceRegionGrouping {
  if (spans.some((span) => !validSpan(span))) return invalid("Text geometry is incomplete or invalid, so its source region cannot be identified safely.");
  if (new Set(spans.map((span) => span.id)).size !== spans.length) return invalid("Text anchors have duplicate identities, so their source regions cannot be mapped unambiguously.");

  const pages = [...new Set(spans.map((span) => span.pageIndex))].sort((a, b) => a - b);
  const regions: SourceTextRegion[] = [];
  const assignments: SourceSpanAssignment[] = [];

  for (const pageIndex of pages) {
    const pageSpans = spans.filter((span) => span.pageIndex === pageIndex);
    const laneSpans = pageSpans.filter((span) => !span.topFurniture && !span.lineMetadata);
    const columnEvidence = laneSpans.length ? laneSpans : pageSpans;
    const columns = candidateColumns(columnEvidence) ?? [{ left: Math.min(...columnEvidence.map((span) => span.bounds.left)), spans: columnEvidence }];
    if (columns.length > 2) return invalid("This page has more than two distinct text columns. Upload a simpler one- or two-column résumé layout.");

    const assignedByColumn = columns.map(() => [] as PositionedSourceSpan[]);
    for (const span of columnEvidence) {
      const distances = columns.map((column) => Math.abs(span.bounds.left - column.left));
      const closestDistance = Math.min(...distances);
      if (distances.length === 2 && Math.abs(distances[0] - distances[1]) <= MIN_COLUMN_ASSIGNMENT_MARGIN_PT) {
        return invalid("A text span falls between the detected columns, so its original reading region is ambiguous.");
      }
      const closestColumn = distances.indexOf(closestDistance);
      if (closestDistance > MAX_COLUMN_ASSIGNMENT_DISTANCE_PT) {
        const inlineContinuation = columns.length === 1 && inlineContinuationLinkedToLane(span, columnEvidence, columns[0].left);
        if (!inlineContinuation) return invalid("A text span falls between the detected columns, so its original reading region is ambiguous.");
      }
      assignedByColumn[closestColumn].push(span);
    }

    for (const span of pageSpans.filter((item) => (item.topFurniture || item.lineMetadata) && !columnEvidence.includes(item))) {
      if (columns.length === 1) {
        assignedByColumn[0].push(span);
        continue;
      }
      if (span.topFurniture) {
        const distances = columns.map((column) => Math.abs(span.bounds.left - column.left));
        const closestDistance = Math.min(...distances);
        const closestColumn = distances.indexOf(closestDistance);
        if (closestDistance > MAX_COLUMN_ASSIGNMENT_DISTANCE_PT) {
          // A centered or full-width page heading can sit in the gutter; keep it
          // with the first lane without letting it create or reorder columns.
          assignedByColumn[0].push(span);
          continue;
        }
        const otherDistance = distances[1 - closestColumn];
        if (otherDistance - closestDistance <= MIN_COLUMN_ASSIGNMENT_MARGIN_PT)
          return invalid("A top-of-page text span falls between the detected columns, so its reading lane is ambiguous.");
        assignedByColumn[closestColumn].push(span);
        continue;
      }
      const matchingColumns = assignedByColumn.flatMap((columnSpans, columnIndex) =>
        columnSpans.some((candidate) => verticalOverlap({ left: span.bounds.left, spans: [span] }, { left: candidate.bounds.left, spans: [candidate] }) > 0)
          ? [columnIndex] : []);
      if (matchingColumns.length !== 1) return invalid("A right-aligned date or location does not align with one unique text row, so its entry cannot be identified safely.");
      assignedByColumn[matchingColumns[0]].push(span);
    }

    if (columns.length === 2) {
      for (const left of assignedByColumn[0].filter((span) => !span.topFurniture)) {
        for (const right of assignedByColumn[1].filter((span) => !span.topFurniture)) {
          if (spansOverlap(left, right)) return invalid("Text from separate columns overlaps on the page, so it cannot be edited without risking cross-column flow.");
        }
      }
    }

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const columnSpans = assignedByColumn[columnIndex].sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left || a.id.localeCompare(b.id));
      const id = `page-${pageIndex + 1}-column-${columnIndex + 1}`;
      const region: SourceTextRegion = {
        id,
        pageIndex,
        columnId: `column-${columnIndex + 1}`,
        bounds: boundsFor(columnSpans),
        readingOrder: columnIndex,
      };
      regions.push(region);
      for (const span of columnSpans) assignments.push({ spanId: span.id, regionId: id, readingOrder: assignments.length });
    }
  }

  return { status: "supported", regions, assignments };
}
