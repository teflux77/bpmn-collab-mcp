import { parse, flatten, metaOf } from "./model.js";

interface Snap {
  type: string;
  name?: string;
  container: string;
  source?: string;
  target?: string;
  meta: Record<string, string>;
}

async function snapshot(xml: string) {
  const { definitions } = await parse(xml);
  const m = new Map<string, Snap>();
  for (const { el, container } of flatten(definitions)) {
    m.set(el.id, {
      type: el.$type,
      name: el.name,
      container,
      source: el.sourceRef?.id,
      target: el.targetRef?.id,
      meta: metaOf(el),
    });
  }
  return m;
}

/** Semantic (not textual) diff between two BPMN XML revisions, keyed by element id. */
export async function diffXml(oldXml: string, newXml: string) {
  const a = await snapshot(oldXml);
  const b = await snapshot(newXml);
  const added: any[] = [];
  const removed: any[] = [];
  const modified: any[] = [];
  for (const [id, s] of b) {
    const o = a.get(id);
    if (!o) added.push({ id, ...s });
    else if (JSON.stringify(o) !== JSON.stringify(s)) modified.push({ id, before: o, after: s });
  }
  for (const [id, s] of a) if (!b.has(id)) removed.push({ id, ...s });
  return { added, removed, modified };
}
