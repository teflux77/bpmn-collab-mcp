/**
 * Auto-layout for XML submitted without any DI: bpmn-auto-layout computes nodes and flows,
 * then a completion pass adds what it leaves out, following the conventions of skill/SKILL.md:
 * label bounds, data object placement and data associations, text annotations and associations.
 * Never applied to a diagram that already has DI (it would overwrite the human's positions).
 */
import { layoutProcess } from "bpmn-auto-layout";
import { moddle } from "./model.js";
import { rectsOverlap, segmentHitsRect, type Point, type Rect } from "./layout-check.js";

export interface LayoutResult {
  xml: string;
  /** What the completion pass could not do, for the AI to fix. */
  notes: string[];
}

const is = (el: any, type: string) => typeof el?.$instanceOf === "function" && el.$instanceOf(type);

/** True if the definitions carry at least one DI element. */
export function hasDi(definitions: any) {
  return (definitions.diagrams ?? []).some((d: any) => (d.plane?.planeElement ?? []).length > 0);
}

/** Clearance (px) between a placed label or artifact and any shape, label or line. */
const CLEAR = 8;
const LINE = 14; // label line height
const CHAR = 6.5; // average character width at bpmn-js default font size

const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });
const centerX = (r: Rect) => r.x + r.width / 2;
const centerY = (r: Rect) => r.y + r.height / 2;
const bottom = (r: Rect) => r.y + r.height;

function labelSize(text: string, maxWidth: number) {
  const width = Math.min(maxWidth, Math.max(20, Math.ceil(text.length * CHAR)));
  const lines = Math.ceil((text.length * CHAR) / width);
  // multi-line or long labels get double clearance (legacy convention)
  return { width, height: LINE * lines, clear: lines > 1 || text.trim().split(/\s+/).length > 3 ? 2 * CLEAR : CLEAR };
}

export async function autoLayout(xml: string): Promise<LayoutResult> {
  const m = moddle();
  const { rootElement: defs } = await m.fromXML(await layoutProcess(xml));
  const notes: string[] = [];
  const plane = defs.diagrams?.[0]?.plane;
  if (!plane) return { xml, notes: ["bpmn-auto-layout produced no diagram"] };

  const participants = (defs.rootElements ?? []).flatMap((r: any) => (is(r, "bpmn:Collaboration") ? (r.participants ?? []) : []));
  if (participants.length > 1)
    notes.push(`Only the first pool was laid out (${participants.length} participants): provide DI for multi-pool diagrams.`);

  // bpmn-auto-layout draws a shape for bpmn:DataObject, which has no visual representation.
  plane.planeElement = (plane.planeElement ?? []).filter((pe: any) => !is(pe.bpmnElement, "bpmn:DataObject"));

  const shapes = new Map<string, any>();
  const edges = new Map<string, any>();
  for (const pe of plane.planeElement) {
    if (is(pe, "bpmndi:BPMNShape")) shapes.set(pe.bpmnElement.id, pe);
    if (is(pe, "bpmndi:BPMNEdge")) edges.set(pe.bpmnElement.id, pe);
  }
  const labels: Rect[] = [];

  const bounds = (r: Rect) => m.create("dc:Bounds", { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
  const addShape = (el: any, r: Rect) => {
    const pe = m.create("bpmndi:BPMNShape", { id: `${el.id}_di`, bpmnElement: el, bounds: bounds(r) });
    plane.planeElement.push(pe);
    shapes.set(el.id, pe);
    return pe;
  };
  const addEdge = (el: any, points: Point[]) => {
    const pe = m.create("bpmndi:BPMNEdge", {
      id: `${el.id}_di`,
      bpmnElement: el,
      waypoint: points.map((p) => m.create("dc:Point", { x: Math.round(p.x), y: Math.round(p.y) })),
    });
    plane.planeElement.push(pe);
    edges.set(el.id, pe);
  };

  /** Free = no overlap with shapes or placed labels, and no flow line through it, with clearance. */
  const free = (r: Rect, clear = CLEAR, ignore?: any) => {
    const g = grow(r, clear);
    for (const [, s] of shapes) if (s !== ignore && rectsOverlap(g, s.bounds)) return false;
    if (labels.some((l) => rectsOverlap(g, l))) return false;
    for (const [, e] of edges) {
      const pts: Point[] = e.waypoint ?? [];
      if (pts.slice(1).some((q, i) => segmentHitsRect(pts[i], q, g))) return false;
    }
    return true;
  };
  const pick = (candidates: Rect[], clear = CLEAR, ignore?: any) => candidates.find((r) => free(r, clear, ignore));

  // ---- Data object / data store references: next to the activity that uses them ----
  const process = (defs.rootElements ?? []).find((r: any) => is(r, "bpmn:Process"));
  const placedData = new Set<string>();
  for (const act of process?.flowElements ?? []) {
    if (!is(act, "bpmn:Activity") || !shapes.has(act.id)) continue;
    const a = shapes.get(act.id).bounds as Rect;
    const assocs = [
      ...(act.dataOutputAssociations ?? []).map((d: any) => ({ assoc: d, data: d.targetRef, out: true })),
      ...(act.dataInputAssociations ?? []).map((d: any) => ({ assoc: d, data: d.sourceRef?.[0], out: false })),
    ];
    for (const { assoc, data, out } of assocs) {
      if (!data || !shapes.has(data.id)) continue;
      const pe = shapes.get(data.id);
      const d = pe.bounds;
      if (!placedData.has(data.id)) {
        const below = (dy: number, dx = 0) => ({ x: centerX(a) - d.width / 2 + dx, y: bottom(a) + dy, width: d.width, height: d.height });
        const above = (dy: number, dx = 0) => ({ x: centerX(a) - d.width / 2 + dx, y: a.y - dy - d.height, width: d.width, height: d.height });
        const spot = pick([below(40), above(40), below(40, -60), below(40, 60), below(100), above(100)], 20, pe);
        if (spot) pe.bounds = bounds(spot);
        else notes.push(`No free spot found near ${act.id} for ${data.id}; kept the auto-layout position.`);
        placedData.add(data.id);
      }
      if (!edges.has(assoc.id)) {
        const d = pe.bounds as Rect; // possibly moved above
        const dataAbove = centerY(d) < centerY(a);
        const actPt = { x: centerX(a), y: dataAbove ? a.y : bottom(a) };
        const dataPt = { x: centerX(d), y: dataAbove ? bottom(d) : d.y };
        const pts = actPt.x === dataPt.x ? [actPt, dataPt] : [actPt, { x: actPt.x, y: (actPt.y + dataPt.y) / 2 }, { x: dataPt.x, y: (actPt.y + dataPt.y) / 2 }, dataPt];
        addEdge(assoc, out ? pts : [...pts].reverse());
      }
    }
  }

  // ---- Text annotations and their associations ----
  const artifacts = process?.artifacts ?? [];
  for (const assoc of artifacts.filter((x: any) => is(x, "bpmn:Association"))) {
    const [ann, other] = is(assoc.targetRef, "bpmn:TextAnnotation") ? [assoc.targetRef, assoc.sourceRef] : [assoc.sourceRef, assoc.targetRef];
    if (!is(ann, "bpmn:TextAnnotation") || !other || !shapes.has(other.id)) continue;
    const o = shapes.get(other.id).bounds as Rect;
    if (!shapes.has(ann.id)) {
      const h = Math.max(30, LINE * Math.ceil(((ann.text ?? "").length * CHAR) / 120) + 12);
      const at = (x: number, y: number) => ({ x, y, width: 120, height: h });
      const spot = pick([at(o.x, o.y - 50 - h), at(o.x + o.width + 30, o.y - 50 - h), at(o.x - 150, o.y - 50 - h), at(o.x, bottom(o) + 50), at(o.x, o.y - 120 - h)], 20);
      addShape(ann, spot ?? at(o.x, o.y - 50 - h));
      if (!spot) notes.push(`Annotation ${ann.id} placed above ${other.id} without enough free space: check overlaps.`);
    }
    if (!edges.has(assoc.id)) {
      const t = shapes.get(ann.id).bounds as Rect;
      const annAbove = bottom(t) <= o.y;
      const x = Math.min(Math.max(centerX(o), t.x + 10), t.x + t.width - 10);
      const from = { x, y: annAbove ? o.y : bottom(o) };
      const to = { x, y: annAbove ? bottom(t) : t.y };
      addEdge(assoc, assoc.sourceRef === ann ? [to, from] : [from, to]);
    }
  }
  for (const a of artifacts) {
    if (shapes.has(a.id) || edges.has(a.id)) continue;
    if (is(a, "bpmn:TextAnnotation") || is(a, "bpmn:Group"))
      notes.push(`${a.$type.replace("bpmn:", "")} ${a.id} was not laid out (no association to a laid-out element): provide its DI.`);
  }

  // ---- Labels (explicit bounds, never bpmn-js default placement) ----
  const setLabel = (pe: any, r: Rect) => {
    pe.label = m.create("bpmndi:BPMNLabel", { bounds: bounds(r) });
    labels.push(r);
  };
  for (const [, pe] of shapes) {
    const el = pe.bpmnElement;
    const name: string | undefined = el.name?.trim();
    if (!name || pe.label) continue;
    const isGateway = is(el, "bpmn:Gateway");
    const external = isGateway || is(el, "bpmn:Event") || is(el, "bpmn:DataObjectReference") || is(el, "bpmn:DataStoreReference");
    if (!external) continue;
    const b = pe.bounds as Rect;
    const { width, height, clear } = labelSize(name, 90);
    const at = (y: number, dx = 0) => ({ x: centerX(b) - width / 2 + dx, y, width, height });
    const gapEvent = is(el, "bpmn:EndEvent") ? 11 : 10;
    const candidates = isGateway
      ? [at(b.y - 10 - height), at(bottom(b) + 10, width / 2 + 10), at(bottom(b) + 10, -width / 2 - 10), at(bottom(b) + 10)]
      : is(el, "bpmn:Event")
        ? [at(bottom(b) + gapEvent), at(b.y - gapEvent - height), at(bottom(b) + gapEvent, width / 2 + 10)]
        : [at(bottom(b) + 8), at(b.y - 8 - height)];
    const spot = pick(candidates, clear) ?? pick(candidates, 2);
    setLabel(pe, spot ?? candidates[0]);
    if (!spot) notes.push(`Label of ${el.id} could not avoid every neighbour: check pm/label-overlap.`);
  }
  for (const [, pe] of edges) {
    const el = pe.bpmnElement;
    const name: string | undefined = el.name?.trim();
    if (!name || pe.label || (!is(el, "bpmn:SequenceFlow") && !is(el, "bpmn:MessageFlow"))) continue;
    const pts: Point[] = pe.waypoint ?? [];
    if (pts.length < 2) continue;
    const { width, height, clear } = labelSize(name, 90);
    const [p, q] = [pts[0], pts[1]];
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    const gap = is(el, "bpmn:MessageFlow") ? 15 : CLEAR;
    const candidates =
      p.y === q.y
        ? [
            { x: mid.x - width / 2, y: p.y - gap - height, width, height },
            { x: Math.min(p.x, q.x) + 6, y: p.y - gap - height, width, height },
            { x: mid.x - width / 2, y: p.y + gap, width, height },
          ]
        : [
            { x: p.x + 12, y: mid.y - height / 2, width, height },
            { x: p.x - 12 - width, y: mid.y - height / 2, width, height },
          ];
    const spot = pick(candidates, Math.min(clear, gap)) ?? pick(candidates, 2);
    setLabel(pe, spot ?? candidates[0]);
    if (!spot) notes.push(`Label of ${el.id} could not avoid every neighbour: check pm/label-overlap.`);
  }

  const { xml: out } = await m.toXML(defs, { format: true });
  return { xml: out, notes };
}
