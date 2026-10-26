/**
 * Deterministic refactoring: extract a fragment of a process into a collapsed sub-process
 * (drill-down), semantics and DI together. The AI only names the elements and the sub-process;
 * the criteria are checked here (one entry, one exit, no message flow, no data association across
 * the border) and the result is validated before it is saved.
 */
import { moddle } from "./model.js";
import { shiftToOrigin } from "./drilldown.js";
import { slug } from "./filename.js";

export type ExtractResult =
  | { ok: true; xml: string; subProcessId: string; moved: string[]; warnings: string[] }
  | { ok: false; errors: string[] };

interface XY {
  x: number;
  y: number;
}

const is = (el: any, type: string) => typeof el?.$instanceOf === "function" && el.$instanceOf(type);
const remove = <T>(list: T[] | undefined, item: T) => {
  const i = list?.indexOf(item) ?? -1;
  if (list && i >= 0) list.splice(i, 1);
};
const centre = (b: any): XY => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Orthogonal route from p to q (one bend in the middle when they are not aligned). */
function route(p: XY, q: XY): XY[] {
  if (Math.round(p.y) === Math.round(q.y)) return [p, q];
  const mx = Math.round((p.x + q.x) / 2);
  return [p, { x: mx, y: p.y }, { x: mx, y: q.y }, q];
}

export async function extractSubProcess(xml: string, elementIds: string[], name: string): Promise<ExtractResult> {
  const m = moddle();
  const { rootElement: defs, elementsById } = await m.fromXML(xml);
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- selection ----
  const ids = [...new Set(elementIds)];
  const missing = ids.filter((id) => !elementsById[id]);
  if (missing.length) return { ok: false, errors: [`Unknown element id(s): ${missing.join(", ")}`] };
  const picked = ids.map((id) => elementsById[id]);
  const notNodes = picked.filter((e) => !is(e, "bpmn:FlowNode") || is(e, "bpmn:BoundaryEvent"));
  if (notNodes.length)
    return { ok: false, errors: [`Select flow nodes (activities, events, gateways); boundary events follow their activity: ${notNodes.map((e) => e.id).join(", ")}`] };
  const container = picked[0].$parent;
  if (picked.some((e) => e.$parent !== container)) return { ok: false, errors: ["All elements must be in the same process or sub-process"] };
  const edgeEvents = picked.filter((e) => is(e, "bpmn:StartEvent") || is(e, "bpmn:EndEvent"));
  if (edgeEvents.length)
    errors.push(`Start and end events of the parent level cannot move into the sub-process: ${edgeEvents.map((e) => e.id).join(", ")}`);

  // boundary events follow their host activity
  const boundary = (container.flowElements ?? []).filter((e: any) => is(e, "bpmn:BoundaryEvent") && picked.includes(e.attachedToRef));
  const nodes = new Set<any>([...picked, ...boundary]);
  const flows = (container.flowElements ?? []).filter((e: any) => is(e, "bpmn:SequenceFlow"));
  const internal = flows.filter((f: any) => nodes.has(f.sourceRef) && nodes.has(f.targetRef));
  const entries = flows.filter((f: any) => !nodes.has(f.sourceRef) && nodes.has(f.targetRef));
  const exits = flows.filter((f: any) => nodes.has(f.sourceRef) && !nodes.has(f.targetRef));
  if (entries.length !== 1) errors.push(`The fragment needs exactly one entry flow, it has ${entries.length}${entries.length ? ` (${entries.map((f: any) => f.id).join(", ")})` : ""}`);
  if (exits.length !== 1) errors.push(`The fragment needs exactly one exit flow, it has ${exits.length}${exits.length ? ` (${exits.map((f: any) => f.id).join(", ")})` : ""}`);

  // message flows on the fragment would cross the border
  const messageFlows = (defs.rootElements ?? [])
    .filter((r: any) => is(r, "bpmn:Collaboration"))
    .flatMap((c: any) => c.messageFlows ?? [])
    .filter((mf: any) => nodes.has(mf.sourceRef) || nodes.has(mf.targetRef));
  if (messageFlows.length) errors.push(`Message flows touch the fragment and would cross the sub-process border: ${messageFlows.map((mf: any) => mf.id).join(", ")}`);

  // data associations: the data reference must move with the fragment, and be used only by it
  const dataRefs = new Set<any>();
  for (const n of nodes) {
    for (const a of [...(n.dataInputAssociations ?? []), ...(n.dataOutputAssociations ?? [])]) {
      for (const ref of [...(a.sourceRef ?? []), a.targetRef].filter(Boolean)) {
        if (is(ref, "bpmn:DataObjectReference") || is(ref, "bpmn:DataStoreReference")) dataRefs.add(ref);
      }
    }
  }
  const outsideUse = (ref: any) =>
    (container.flowElements ?? []).some(
      (e: any) =>
        !nodes.has(e) &&
        [...(e.dataInputAssociations ?? []), ...(e.dataOutputAssociations ?? [])].some((a: any) => a.targetRef === ref || (a.sourceRef ?? []).includes(ref)),
    );
  const shared = [...dataRefs].filter(outsideUse);
  if (shared.length) errors.push(`Data used inside and outside the fragment would cross the border: ${shared.map((d) => d.id).join(", ")}`);

  // annotations move when all their associations attach to the fragment
  const associations = (container.artifacts ?? []).filter((a: any) => is(a, "bpmn:Association"));
  const annotations = new Set<any>();
  for (const ann of (container.artifacts ?? []).filter((a: any) => is(a, "bpmn:TextAnnotation"))) {
    const links = associations.filter((a: any) => a.sourceRef === ann || a.targetRef === ann);
    const others = links.map((a: any) => (a.sourceRef === ann ? a.targetRef : a.sourceRef));
    if (links.length && others.every((o: any) => nodes.has(o))) annotations.add(ann);
    else if (others.some((o: any) => nodes.has(o))) errors.push(`Annotation ${ann.id} is linked inside and outside the fragment`);
  }
  if (errors.length) return { ok: false, errors };

  // ---- semantics ----
  const base = `Sub_${slug(name).replace(/-/g, "_").slice(0, 40) || "fragment"}`;
  let subId = base;
  for (let i = 2; elementsById[subId]; i++) subId = `${base}_${i}`;
  const entry = entries[0];
  const exit = exits[0];
  const firstInside = entry.targetRef;
  const lastInside = exit.sourceRef;

  const sub = m.create("bpmn:SubProcess", { id: subId, name });
  sub.$parent = container;
  const startEv = m.create("bpmn:StartEvent", { id: `${subId}_Start`, name: "Start" });
  const endEv = m.create("bpmn:EndEvent", { id: `${subId}_End`, name: "Done" });
  const fIn = m.create("bpmn:SequenceFlow", { id: `${subId}_FlowIn`, sourceRef: startEv, targetRef: firstInside });
  const fOut = m.create("bpmn:SequenceFlow", { id: `${subId}_FlowOut`, sourceRef: lastInside, targetRef: endEv });

  const movedDataObjects = (container.flowElements ?? []).filter(
    (e: any) => is(e, "bpmn:DataObject") && [...dataRefs].some((r: any) => r.dataObjectRef === e) && !(container.flowElements ?? []).some(
      (o: any) => is(o, "bpmn:DataObjectReference") && o.dataObjectRef === e && !dataRefs.has(o),
    ),
  );
  const movedFlowElements = [...nodes, ...internal, ...dataRefs, ...movedDataObjects];
  container.flowElements = (container.flowElements ?? []).filter((e: any) => !movedFlowElements.includes(e));
  const movedArtifacts = [...annotations, ...associations.filter((a: any) => annotations.has(a.sourceRef) || annotations.has(a.targetRef))];
  container.artifacts = (container.artifacts ?? []).filter((a: any) => !movedArtifacts.includes(a));
  for (const e of [startEv, endEv, fIn, fOut, ...movedFlowElements, ...movedArtifacts]) e.$parent = sub;
  sub.flowElements = [startEv, ...movedFlowElements, endEv, fIn, fOut];
  if (movedArtifacts.length) sub.artifacts = movedArtifacts;
  container.flowElements.push(sub);

  // rewire the entry and exit through the sub-process
  remove(firstInside.incoming, entry);
  remove(lastInside.outgoing, exit);
  entry.targetRef = sub;
  exit.sourceRef = sub;
  sub.incoming = [entry];
  sub.outgoing = [exit];
  startEv.outgoing = [fIn];
  endEv.incoming = [fOut];
  (firstInside.incoming ??= []).push(fIn);
  (lastInside.outgoing ??= []).push(fOut);

  // lanes: the sub-process takes the lane of its first element; children leave the parent's lanes
  const lanes: any[] = [];
  const collect = (ls: any[]) => ls?.forEach((l) => (l.childLaneSet?.lanes?.length ? collect(l.childLaneSet.lanes) : lanes.push(l)));
  for (const set of container.laneSets ?? []) collect(set.lanes);
  const laneOf = (n: any) => lanes.find((l) => (l.flowNodeRef ?? []).includes(n));
  const usedLanes = new Set([...nodes].map(laneOf).filter(Boolean));
  if (usedLanes.size > 1) warnings.push(`The fragment spans ${usedLanes.size} lanes; the sub-process is placed in the lane of ${firstInside.id}`);
  const hostLane = laneOf(firstInside);
  for (const l of lanes) l.flowNodeRef = (l.flowNodeRef ?? []).filter((n: any) => !nodes.has(n));
  if (hostLane) hostLane.flowNodeRef.push(sub);

  // ---- DI ----
  const moved = new Set<any>([...movedFlowElements, ...movedArtifacts]);
  const plane = (defs.diagrams ?? []).map((d: any) => d.plane).find((p: any) => (p.planeElement ?? []).some((pe: any) => pe.bpmnElement === firstInside));
  if (!plane) return { ok: false, errors: ["The fragment has no DI: draw it before extracting it"] };
  const shapeOf = (el: any) => plane.planeElement.find((pe: any) => pe.bpmnElement === el);
  const movedDi = plane.planeElement.filter((pe: any) => moved.has(pe.bpmnElement));
  plane.planeElement = plane.planeElement.filter((pe: any) => !moved.has(pe.bpmnElement));

  // sub-process shape where the fragment was: centred on the bounding box of its shapes
  const shapeBounds = movedDi.filter((pe: any) => pe.bounds && nodes.has(pe.bpmnElement)).map((pe: any) => pe.bounds);
  const minX = Math.min(...shapeBounds.map((b: any) => b.x));
  const maxX = Math.max(...shapeBounds.map((b: any) => b.x + b.width));
  const minY = Math.min(...shapeBounds.map((b: any) => b.y));
  const maxY = Math.max(...shapeBounds.map((b: any) => b.y + b.height));
  const sb = { x: Math.round((minX + maxX) / 2 - 50), y: Math.round((minY + maxY) / 2 - 40), width: 100, height: 80 };
  const pt = (x: number, y: number) => m.create("dc:Point", { x: Math.round(x), y: Math.round(y) });
  plane.planeElement.push(
    m.create("bpmndi:BPMNShape", { id: `${subId}_di`, bpmnElement: sub, isExpanded: false, bounds: m.create("dc:Bounds", sb) }),
  );
  // entry and exit: keep the outside attachment point, end on the sub-process sides
  const reroute = (flow: any, toSub: boolean) => {
    const edge = shapeOf(flow);
    if (!edge?.waypoint?.length) return;
    const w = edge.waypoint;
    const outside = toSub ? w[0] : w[w.length - 1];
    const side = toSub ? { x: sb.x, y: sb.y + sb.height / 2 } : { x: sb.x + sb.width, y: sb.y + sb.height / 2 };
    const pts = toSub ? route(outside, side) : route(side, outside);
    edge.waypoint = pts.map((p) => pt(p.x, p.y));
    if (edge.label?.bounds) {
      // label above the middle of the first segment, as the layout conventions require
      const { width, height } = edge.label.bounds;
      const midX = (pts[0].x + pts[1].x) / 2;
      edge.label.bounds = m.create("dc:Bounds", { x: Math.round(midX - width / 2), y: Math.round(pts[0].y - 8 - height), width, height });
    }
  };
  reroute(entry, true);
  reroute(exit, false);

  // inner plane: moved DI + start and end events beside the first and last elements
  const fb = movedDi.find((pe: any) => pe.bpmnElement === firstInside)?.bounds;
  const lb = movedDi.find((pe: any) => pe.bpmnElement === lastInside)?.bounds;
  const inner = [...movedDi];
  if (fb && lb) {
    const s = { x: fb.x - 86, y: centre(fb).y - 18, width: 36, height: 36 };
    const e = { x: lb.x + lb.width + 50, y: centre(lb).y - 18, width: 36, height: 36 };
    // explicit labels, centred 10 px below the event (layout conventions)
    const label = (b: { x: number; y: number }, text: string) =>
      m.create("bpmndi:BPMNLabel", { bounds: m.create("dc:Bounds", { x: b.x + 18 - Math.ceil(text.length * 3.5), y: b.y + 46, width: Math.ceil(text.length * 7), height: 14 }) });
    inner.push(
      m.create("bpmndi:BPMNShape", { id: `${startEv.id}_di`, bpmnElement: startEv, bounds: m.create("dc:Bounds", s), label: label(s, "Start") }),
      m.create("bpmndi:BPMNShape", { id: `${endEv.id}_di`, bpmnElement: endEv, bounds: m.create("dc:Bounds", e), label: label(e, "Done") }),
      m.create("bpmndi:BPMNEdge", { id: `${fIn.id}_di`, bpmnElement: fIn, waypoint: route({ x: s.x + 36, y: s.y + 18 }, { x: fb.x, y: centre(fb).y }).map((p) => pt(p.x, p.y)) }),
      m.create("bpmndi:BPMNEdge", { id: `${fOut.id}_di`, bpmnElement: fOut, waypoint: route({ x: lb.x + lb.width, y: centre(lb).y }, { x: e.x, y: e.y + 18 }).map((p) => pt(p.x, p.y)) }),
    );
  }
  shiftToOrigin(inner); // bpmn-js based tools open a plane at the origin
  defs.diagrams.push(
    m.create("bpmndi:BPMNDiagram", { id: `${subId}_diagram`, plane: m.create("bpmndi:BPMNPlane", { id: `${subId}_plane`, bpmnElement: sub, planeElement: inner }) }),
  );

  const { xml: out } = await m.toXML(defs, { format: true });
  return { ok: true, xml: out, subProcessId: subId, moved: [...moved].map((e: any) => e.id), warnings };
}
