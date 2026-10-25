/**
 * Layout checks on BPMN DI, in bpmnlint rule format (registered as pm/<name>).
 * Only what bpmnlint and @miragon/bpmnlint-plugin-rules do not cover:
 * - missing DI: bpmnlint no-bpmndi; shape/shape overlap: no-overlapping-elements;
 * - flow through a shape, docking side, orthogonal routes: @miragon/rules/*.
 * Conventions from docs/legacy/SKILL.md (label placement, distinct attachment points).
 */

interface Reporter {
  report(id: string, message: string): void;
}
type RuleFactory = () => { check(node: any, reporter: Reporter): boolean | void };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}

const is = (el: any, type: string) => typeof el?.$instanceOf === "function" && el.$instanceOf(type);

/** Containers: a label may sit inside them, but must not cross their border. */
const isContainer = (s: { el: any; expanded: boolean }) =>
  is(s.el, "bpmn:Participant") || is(s.el, "bpmn:Lane") || is(s.el, "bpmn:Group") || (is(s.el, "bpmn:SubProcess") && s.expanded);

/** Contacts closer than this (px) count as touching, not overlapping: avoids flagging labels that only touch. */
const EPS = 1;

const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, width: r.width - 2 * d, height: r.height - 2 * d });

export function rectsOverlap(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

const inside = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point) {
  const d = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True if the segment p-q passes through the interior of r. */
export function segmentHitsRect(p: Point, q: Point, r: Rect) {
  if (r.width <= 0 || r.height <= 0) return false;
  if (inside(p, r) || inside(q, r)) return true;
  const c = [
    { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height },
  ];
  if (c.some((_, i) => segmentsCross(p, q, c[i], c[(i + 1) % 4]))) return true;
  // segment lying strictly inside along its whole length, between two sides
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  return inside(mid, r);
}

interface Di {
  shapes: { el: any; bounds: Rect; label?: Rect; expanded: boolean }[];
  edges: { el: any; points: Point[]; label?: Rect }[];
}

function collectDi(definitions: any): Di {
  const di: Di = { shapes: [], edges: [] };
  for (const diagram of definitions.diagrams ?? []) {
    for (const pe of diagram.plane?.planeElement ?? []) {
      const el = pe.bpmnElement;
      if (!el) continue;
      const label = pe.label?.bounds as Rect | undefined;
      if (is(pe, "bpmndi:BPMNShape") && pe.bounds) di.shapes.push({ el, bounds: pe.bounds, label, expanded: !!pe.isExpanded });
      if (is(pe, "bpmndi:BPMNEdge") && pe.waypoint?.length) di.edges.push({ el, points: pe.waypoint, label });
    }
  }
  return di;
}

const segments = (points: Point[]) => points.slice(1).map((q, i) => [points[i], q] as const);

/** Distinct attachment points: no two flows start or end at the same point of a shape. */
const sharedAttachmentPoint: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Definitions")) return;
    const ends = new Map<string, Map<string, string[]>>(); // shape id -> "x,y" -> flow ids
    const add = (shapeId: string | undefined, p: Point, flowId: string) => {
      if (!shapeId) return;
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      const byPoint = ends.get(shapeId) ?? new Map<string, string[]>();
      byPoint.set(key, [...(byPoint.get(key) ?? []), flowId]);
      ends.set(shapeId, byPoint);
    };
    for (const e of collectDi(node).edges) {
      if (!is(e.el, "bpmn:SequenceFlow") && !is(e.el, "bpmn:MessageFlow")) continue;
      add(e.el.sourceRef?.id, e.points[0], e.el.id);
      add(e.el.targetRef?.id, e.points[e.points.length - 1], e.el.id);
    }
    for (const [shapeId, byPoint] of ends) {
      for (const [point, flows] of byPoint) {
        if (flows.length > 1)
          reporter.report(shapeId, `Flows ${flows.join(", ")} share the attachment point (${point}); use distinct points (left/right for the main path, top/bottom for branches)`);
      }
    }
  },
});

/** Labels must not overlap shapes, other labels or flow lines, nor cross a pool/lane/sub-process border. */
const labelOverlap: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Definitions")) return;
    const { shapes, edges } = collectDi(node);
    const labels = [
      ...shapes.filter((s) => s.label).map((s) => ({ el: s.el, box: s.label! })),
      ...edges.filter((e) => e.label).map((e) => ({ el: e.el, box: e.label! })),
    ];
    for (const { el, box } of labels) {
      const b = inset(box, EPS);
      const hits: string[] = [];
      for (const s of shapes) {
        if (isContainer(s)) {
          if (rectsOverlap(b, s.bounds) && !contains(s.bounds, box)) hits.push(`crosses the border of ${s.el.id}`);
        } else if (rectsOverlap(b, s.bounds)) hits.push(`overlaps shape ${s.el.id}`);
      }
      for (const o of labels) if (o.el !== el && rectsOverlap(b, o.box)) hits.push(`overlaps the label of ${o.el.id}`);
      for (const e of edges) {
        if (segments(e.points).some(([p, q]) => segmentHitsRect(p, q, b)))
          hits.push(e.el === el ? "sits on its own flow line" : `is crossed by flow ${e.el.id}`);
      }
      if (hits.length) reporter.report(el.id, `Label ${hits.join("; ")}`);
    }
  },
});

/** Named gateways need explicit label bounds: bpmn-js default placement overlaps neighbours. */
const gatewayLabelBounds: RuleFactory = () => ({
  check(node, reporter) {
    if (!is(node, "bpmn:Definitions")) return;
    for (const s of collectDi(node).shapes) {
      if (is(s.el, "bpmn:Gateway") && s.el.name?.trim() && !s.label)
        reporter.report(s.el.id, "Named gateway has no explicit BPMNLabel bounds (place the label centred, 8-12 px above the diamond)");
    }
  },
});

export const layoutRules: Record<string, RuleFactory> = {
  "shared-attachment-point": sharedAttachmentPoint,
  "label-overlap": labelOverlap,
  "gateway-label-bounds": gatewayLabelBounds,
};
