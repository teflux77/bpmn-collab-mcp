import fs from "node:fs";
import { BpmnModdle } from "bpmn-moddle";
import { normalizeDrilldownXml } from "./drilldown.js";

export const processMeta = JSON.parse(
  fs.readFileSync(new URL("./moddle/process-meta.json", import.meta.url), "utf8"),
);
export const PM_NS: string = processMeta.uri;

export function moddle() {
  return new BpmnModdle({ pm: processMeta });
}

export async function parse(xml: string) {
  const { rootElement, warnings, elementsById } = await moddle().fromXML(xml);
  return {
    definitions: rootElement,
    warnings: warnings as any[],
    elementsById: elementsById as Record<string, any>,
  };
}

/** Sub-process planes moved near the origin so they open correctly in bpmn-js based tools (Camunda). */
export async function normalizeDrilldown(xml: string) {
  return normalizeDrilldownXml(xml, moddle());
}

export async function toXml(element: any) {
  const { xml } = await moddle().toXML(element, { format: true });
  return xml as string;
}

/** Flatten all flow elements (recursing into sub-processes) with their container path. */
export function flatten(definitions: any) {
  const out: { el: any; container: string }[] = [];
  const walk = (container: any, cpath: string) => {
    for (const fe of container.flowElements ?? []) {
      out.push({ el: fe, container: cpath });
      if (fe.$type === "bpmn:SubProcess" || fe.$type === "bpmn:Transaction" || fe.$type === "bpmn:AdHocSubProcess") {
        walk(fe, `${cpath}/${fe.id}`);
      }
    }
  };
  for (const root of definitions.rootElements ?? []) {
    if (root.$type === "bpmn:Process") walk(root, root.id);
  }
  return out;
}

export function metaOf(el: any): Record<string, string> {
  const ext = el.extensionElements?.values?.find((v: any) => v.$type === "pm:Meta");
  if (!ext) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ext)) {
    if (!k.startsWith("$") && v !== undefined) out[k] = String(v);
  }
  return out;
}
