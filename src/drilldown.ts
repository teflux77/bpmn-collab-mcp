/**
 * Drill-down planes (collapsed sub-processes) drawn from the origin.
 * bpmn-js, and every tool built on it (Camunda Modeler, Camunda web modeler, our canvas), opens a
 * sub-process plane at (0, 0): content drawn elsewhere (e.g. stacked below the main diagram) looks
 * empty. Translating a plane is a DI-only change: semantics, ids and relative positions are kept.
 * Works on moddle objects; no Node dependency, so the canvas uses it too (with bpmn-js's moddle).
 */

export const PLANE_ORIGIN = 100;
/** A plane already starting within this distance of the origin is left as it is. */
const TOLERANCE = 300;

interface XY {
  x: number;
  y: number;
}

const is = (el: any, type: string) => typeof el?.$instanceOf === "function" && el.$instanceOf(type);

/** Shifts plane elements so the top-left of their content is at (origin, origin). Returns true if moved. */
export function shiftToOrigin(planeElements: any[], origin = PLANE_ORIGIN, tolerance = 0): boolean {
  const boxes: XY[] = planeElements.flatMap((pe) => [pe.bounds, pe.label?.bounds].filter(Boolean));
  const points: XY[] = planeElements.flatMap((pe) => pe.waypoint ?? []);
  const all = [...boxes, ...points];
  if (!all.length) return false;
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const dx = origin - minX;
  const dy = origin - minY;
  if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) return false;
  for (const p of all) {
    p.x = Math.round(p.x + dx);
    p.y = Math.round(p.y + dy);
  }
  return true;
}

/** Moves every sub-process plane that starts far from the origin. Returns the ids of the moved sub-processes. */
export function normalizeDrilldownPlanes(definitions: any): string[] {
  const moved: string[] = [];
  for (const diagram of definitions?.diagrams ?? []) {
    const plane = diagram.plane;
    if (!is(plane?.bpmnElement, "bpmn:SubProcess")) continue; // the main plane is left as drawn
    if (shiftToOrigin(plane.planeElement ?? [], PLANE_ORIGIN, TOLERANCE)) moved.push(plane.bpmnElement.id);
  }
  return moved;
}

/** Parses, normalizes and re-serializes only when a plane moved (the XML is otherwise returned untouched). */
export async function normalizeDrilldownXml(
  xml: string,
  moddle: { fromXML(xml: string): Promise<{ rootElement: any }>; toXML(el: any, o?: object): Promise<{ xml: string }> },
): Promise<{ xml: string; moved: string[] }> {
  let definitions;
  try {
    ({ rootElement: definitions } = await moddle.fromXML(xml));
  } catch {
    return { xml, moved: [] }; // validation reports the parse error
  }
  const moved = normalizeDrilldownPlanes(definitions);
  if (!moved.length) return { xml, moved };
  return { xml: (await moddle.toXML(definitions, { format: true })).xml, moved };
}
