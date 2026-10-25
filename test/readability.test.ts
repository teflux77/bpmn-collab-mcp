import { describe, expect, it } from "vitest";
import { validateXml, type Issue } from "../src/validate.js";
import { fingerprint } from "../src/issues.js";
import { autoLayout } from "../src/autolayout.js";
import { fixture } from "./helpers.js";

/** Linear process (no DI): start -> n activities (with optional extra gateways) -> end; optional nested sub-process. */
function processXml(n: number, opts: { gateways?: number; sub?: number } = {}) {
  const nodes: string[] = [];
  const ids: string[] = ["S"];
  for (let i = 1; i <= n; i++) ids.push(`T${i}`);
  for (let g = 1; g <= (opts.gateways ?? 0); g++) ids.push(`G${g}`);
  if (opts.sub) ids.push("Sub");
  ids.push("E");
  const flows = ids.slice(1).map((id, i) => `<bpmn:sequenceFlow id="F${i}" sourceRef="${ids[i]}" targetRef="${id}" />`);
  const io = (id: string) => {
    const i = ids.indexOf(id);
    return `${i > 0 ? `<bpmn:incoming>F${i - 1}</bpmn:incoming>` : ""}${i < ids.length - 1 ? `<bpmn:outgoing>F${i}</bpmn:outgoing>` : ""}`;
  };
  for (const id of ids) {
    if (id === "S") nodes.push(`<bpmn:startEvent id="S" name="Start">${io(id)}</bpmn:startEvent>`);
    else if (id === "E") nodes.push(`<bpmn:endEvent id="E" name="End">${io(id)}</bpmn:endEvent>`);
    else if (id.startsWith("G")) nodes.push(`<bpmn:exclusiveGateway id="${id}">${io(id)}</bpmn:exclusiveGateway>`);
    else if (id === "Sub") {
      const inner = Array.from({ length: opts.sub! }, (_, i) => `<bpmn:task id="ST${i}" name="Do step ${i}" />`).join("");
      nodes.push(`<bpmn:subProcess id="Sub" name="Ship order">${io(id)}${inner}</bpmn:subProcess>`);
    } else nodes.push(`<bpmn:task id="${id}" name="Do ${id}">${io(id)}</bpmn:task>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:process id="P" isExecutable="false">${nodes.join("")}${flows.join("")}</bpmn:process>
</bpmn:definitions>`;
}

const readability = async (xml: string) =>
  (await validateXml(xml)).filter((i: Issue) => i.rule.startsWith("pm/activity-count")).map((i) => `${i.rule}:${i.severity}@${i.elementId}`);

describe("readability: activities per level (pm/activity-count)", () => {
  it("says nothing up to 8 activities", async () => {
    expect(await readability(processXml(8))).toEqual([]);
  });

  it("suggests lightly from 9 to 12 activities", async () => {
    expect(await readability(processXml(9))).toEqual(["pm/activity-count-hint:info@P"]);
    expect(await readability(processXml(12))).toEqual(["pm/activity-count-hint:info@P"]);
  });

  it("warns more clearly above 12, and never as an error", async () => {
    expect(await readability(processXml(13))).toEqual(["pm/activity-count:warning@P"]);
    expect(await readability(processXml(30))).toEqual(["pm/activity-count:warning@P"]);
  });

  it("does not count events and gateways", async () => {
    expect(await readability(processXml(8, { gateways: 6 }))).toEqual([]);
  });

  it("counts each level separately: a sub-process is one activity for its parent", async () => {
    // parent: 7 tasks + 1 sub-process = 8 -> nothing; inside: 9 tasks -> hint on the sub-process
    expect(await readability(processXml(7, { sub: 9 }))).toEqual(["pm/activity-count-hint:info@Sub"]);
  });

  it("keeps the same fingerprint when the count changes, so a dismissal holds", async () => {
    const [a] = (await validateXml(processXml(13))).filter((i) => i.rule === "pm/activity-count");
    const [b] = (await validateXml(processXml(15))).filter((i) => i.rule === "pm/activity-count");
    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe("collapsed sub-process (drill-down) DI", () => {
  it("passes every check, layout included, with its own plane", async () => {
    expect(await validateXml(fixture("collapsed-subprocess.bpmn"))).toEqual([]);
  });

  it("auto-layout puts a sub-process content on its own drill-down plane", async () => {
    // a well-formed sub-process: start -> task -> end inside
    const xml = processXml(2, { sub: 1 })
      .replace('<bpmn:task id="ST0" name="Do step 0" />',
        '<bpmn:startEvent id="SS" name="Go"><bpmn:outgoing>SF0</bpmn:outgoing></bpmn:startEvent>' +
        '<bpmn:task id="ST0" name="Pick items"><bpmn:incoming>SF0</bpmn:incoming><bpmn:outgoing>SF1</bpmn:outgoing></bpmn:task>' +
        '<bpmn:endEvent id="SE" name="Done"><bpmn:incoming>SF1</bpmn:incoming></bpmn:endEvent>' +
        '<bpmn:sequenceFlow id="SF0" sourceRef="SS" targetRef="ST0" /><bpmn:sequenceFlow id="SF1" sourceRef="ST0" targetRef="SE" />');
    const r = await autoLayout(xml);
    expect(r.xml).toMatch(/<bpmndi:BPMNPlane id="Sub_plane" bpmnElement="Sub">[\s\S]*bpmnElement="ST0"[\s\S]*<\/bpmndi:BPMNPlane>/);
    expect(r.xml).toMatch(/bpmnElement="Sub" isExpanded="false"/);
    expect((await validateXml(r.xml)).filter((i) => i.severity !== "info")).toEqual([]);
  });
});
