import { diff } from "bpmn-js-differ";
import { parse, metaOf } from "./model.js";

export interface ElementRef {
  id: string;
  type: string;
  name?: string;
}

export interface FieldChange {
  before: unknown;
  after: unknown;
}

export interface ElementChange extends ElementRef {
  /** Changed properties; nested paths (e.g. "processRef.artifacts[0]") come from bpmn-js-differ. */
  fields: Record<string, FieldChange>;
}

export interface DiagramDiff {
  added: ElementRef[];
  removed: ElementRef[];
  modified: ElementChange[];
  /** Elements whose DI (bounds, waypoints, label) changed: moved, resized, re-routed. */
  moved: ElementRef[];
  /** Set when bpmn-js-differ failed (e.g. DI pointing to a deleted element): only ids, pm: and artifacts were compared. */
  partial?: string;
}

/** Artifact properties compared here because bpmn-js-differ does not track artifacts outside collaborations. */
const ARTIFACT_PROPS = ["text", "name", "sourceRef", "targetRef", "categoryValueRef", "associationDirection"];

const ref = (el: any): ElementRef => ({ id: el.id, type: el.$type, ...(el.name ? { name: el.name } : {}) });

/** Semantic (non-DI) elements: DI and pm: extension elements are reported through their owner. */
const isSemantic = (el: any) => typeof el?.$type === "string" && el.$type.startsWith("bpmn:") && el.$type !== "bpmn:Definitions";

/** JSON-safe view of a moddle value: references become ids. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(plain);
  const o = v as any;
  if (o.id) return o.id;
  if (o.$type) return o.$type;
  return String(v);
}

/** "a.b[0].c" -> ["a", "b", "0", "c"] */
const segments = (path: string): string[] => path.match(/[^.[\]]+/g) ?? [];
const get = (o: any, prop: string) => segments(prop).reduce((v, k) => v?.[k], o);

/** Walk a differ path from root; returns the deepest element with an id and the remaining property path. */
function resolve(root: any, path: string): { owner: string; prop: string } | undefined {
  if (!root?.id) return undefined;
  const segs = segments(path);
  let owner = root.id;
  let rest = segs;
  let cur = root;
  segs.slice(0, -1).forEach((s, i) => {
    cur = cur?.[s];
    if (cur?.id && isSemantic(cur)) {
      owner = cur.id;
      rest = segs.slice(i + 1);
    }
  });
  return { owner, prop: rest.join(".") };
}

/**
 * Semantic diff between two BPMN XML revisions, keyed by element id.
 * bpmn-js-differ decides WHAT changed (properties, layout); before/after values are read
 * from both models here, so the result does not depend on the differ's oldValue/newValue order.
 */
export async function diffXml(oldXml: string, newXml: string): Promise<DiagramDiff> {
  const a = await parse(oldXml);
  const b = await parse(newXml);
  let changes: any = {};
  let partial: string | undefined;
  try {
    changes = diff(a.definitions, b.definitions);
  } catch (e: any) {
    partial = `bpmn-js-differ failed (${e.message}); diff limited to added/removed, pm: metadata and artifacts`;
  }

  const semanticIds = (byId: Record<string, any>) => Object.keys(byId).filter((id) => isSemantic(byId[id]));
  const oldIds = new Set(semanticIds(a.elementsById));
  const newIds = new Set(semanticIds(b.elementsById));

  // Ids are the source of truth for presence; the differ misses artifacts (annotations, groups).
  const added = [...newIds].filter((id) => !oldIds.has(id)).map((id) => ref(b.elementsById[id]));
  const removed = [...oldIds].filter((id) => !newIds.has(id)).map((id) => ref(a.elementsById[id]));

  const modified = new Map<string, ElementChange>();
  const touch = (id: string) => {
    let c = modified.get(id);
    if (!c) modified.set(id, (c = { ...ref(b.elementsById[id]), fields: {} }));
    return c;
  };

  for (const [id, change] of Object.entries<any>(changes._changed ?? {})) {
    for (const path of Object.keys(change.attrs ?? {})) {
      // Paths ending in [n] only reflect an added/removed child, already in added/removed.
      if (/\[\d+\]$/.test(path)) continue;
      // Attribute nested changes (e.g. "processRef.artifacts[0].text") to the closest element with an id.
      const target = resolve(b.elementsById[id], path);
      if (!target || !oldIds.has(target.owner) || !newIds.has(target.owner)) continue;
      touch(target.owner).fields[target.prop] = {
        before: plain(get(a.elementsById[target.owner], target.prop)),
        after: plain(get(b.elementsById[target.owner], target.prop)),
      };
    }
  }

  for (const id of newIds) {
    if (!oldIds.has(id)) continue;
    const ea = a.elementsById[id];
    const eb = b.elementsById[id];

    if (eb.$instanceOf("bpmn:Artifact")) {
      for (const k of ARTIFACT_PROPS) {
        const before = plain(ea[k]);
        const after = plain(eb[k]);
        if (before !== after) touch(id).fields[k] = { before, after };
      }
    }

    // Business metadata lives in pm:Meta, which the differ does not compare.
    const before = metaOf(ea);
    const after = metaOf(eb);
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[k] !== after[k]) touch(id).fields[`pm:${k}`] = { before: before[k], after: after[k] };
    }
  }

  const moved = Object.keys(changes._layoutChanged ?? {})
    .filter((id) => oldIds.has(id) && newIds.has(id))
    .map((id) => ref(b.elementsById[id]));

  return {
    added,
    removed,
    modified: [...modified.values()].filter((c) => Object.keys(c.fields).length),
    moved,
    ...(partial ? { partial } : {}),
  };
}
