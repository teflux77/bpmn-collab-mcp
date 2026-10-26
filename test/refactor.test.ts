import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { extractSubProcess } from "../src/refactor.js";
import { parse } from "../src/model.js";
import { validateXml } from "../src/validate.js";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";

/**
 * A linear process with DI on one row: S -> T1..Tn -> E (tasks 100x80, 150 px apart).
 * `extra` adds raw semantic XML (and `extraDi` its DI); `lanes` wraps it in a pool with two lanes.
 */
function chain(n: number, o: { extra?: string; extraDi?: string; lanes?: boolean; flows?: string[] } = {}) {
  const ids = ["S", ...Array.from({ length: n }, (_, i) => `T${i + 1}`), "E"];
  const x = (i: number) => 100 + i * 150;
  const y0 = o.lanes ? 120 : 100;
  const flows = ids.slice(1).map((id, i) => ({ id: `F${i}`, s: ids[i], t: id }));
  const incoming = (id: string) => flows.filter((f) => f.t === id).map((f) => `<bpmn:incoming>${f.id}</bpmn:incoming>`).join("");
  const outgoing = (id: string) => flows.filter((f) => f.s === id).map((f) => `<bpmn:outgoing>${f.id}</bpmn:outgoing>`).join("");
  const node = (id: string) =>
    id === "S" ? `<bpmn:startEvent id="S" name="Start">${outgoing(id)}</bpmn:startEvent>`
    : id === "E" ? `<bpmn:endEvent id="E" name="End">${incoming(id)}</bpmn:endEvent>`
    : `<bpmn:task id="${id}" name="Do ${id}">${incoming(id)}${outgoing(id)}</bpmn:task>`;
  const shape = (id: string, i: number) => {
    const ev = id === "S" || id === "E";
    const b = ev ? { x: x(i) + 32, y: y0 + 22, w: 36, h: 36 } : { x: x(i), y: y0, w: 100, h: 80 };
    const label = ev ? `<bpmndi:BPMNLabel><dc:Bounds x="${b.x + 3}" y="${b.y + 46}" width="30" height="14" /></bpmndi:BPMNLabel>` : "";
    return `<bpmndi:BPMNShape id="${id}_di" bpmnElement="${id}"><dc:Bounds x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" />${label}</bpmndi:BPMNShape>`;
  };
  const right = (i: number) => (ids[i] === "S" || ids[i] === "E" ? x(i) + 68 : x(i) + 100);
  const left = (i: number) => (ids[i] === "S" || ids[i] === "E" ? x(i) + 32 : x(i));
  const edge = (f: { id: string }, i: number) =>
    `<bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}"><di:waypoint x="${right(i)}" y="${y0 + 40}" /><di:waypoint x="${left(i + 1)}" y="${y0 + 40}" /></bpmndi:BPMNEdge>`;
  const width = x(ids.length) + 50;
  const process = `<bpmn:process id="P" isExecutable="false">${
    o.lanes
      ? `<bpmn:laneSet id="LS"><bpmn:lane id="L_A" name="Clerk">${ids.slice(0, 3).map((i) => `<bpmn:flowNodeRef>${i}</bpmn:flowNodeRef>`).join("")}</bpmn:lane>` +
        `<bpmn:lane id="L_B" name="Manager">${ids.slice(3).map((i) => `<bpmn:flowNodeRef>${i}</bpmn:flowNodeRef>`).join("")}</bpmn:lane></bpmn:laneSet>`
      : ""
  }${ids.map(node).join("")}${flows.map((f) => `<bpmn:sequenceFlow id="${f.id}" sourceRef="${f.s}" targetRef="${f.t}" />`).join("")}${o.extra ?? ""}</bpmn:process>`;
  const collab = o.lanes ? `<bpmn:collaboration id="C"><bpmn:participant id="Pool" name="Shop" processRef="P" /></bpmn:collaboration>` : "";
  const laneDi = o.lanes
    ? `<bpmndi:BPMNShape id="Pool_di" bpmnElement="Pool" isHorizontal="true"><dc:Bounds x="40" y="60" width="${width}" height="260" /></bpmndi:BPMNShape>` +
      `<bpmndi:BPMNShape id="L_A_di" bpmnElement="L_A" isHorizontal="true"><dc:Bounds x="70" y="60" width="${width - 30}" height="260" /></bpmndi:BPMNShape>` +
      `<bpmndi:BPMNShape id="L_B_di" bpmnElement="L_B" isHorizontal="true"><dc:Bounds x="70" y="320" width="${width - 30}" height="10" /></bpmndi:BPMNShape>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="x">
  ${collab}${process}
  <bpmndi:BPMNDiagram id="Dia"><bpmndi:BPMNPlane id="Plane" bpmnElement="${o.lanes ? "C" : "P"}">
    ${laneDi}${ids.map(shape).join("")}${flows.map(edge).join("")}${o.extraDi ?? ""}
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

const ok = async (xml: string, ids: string[], name = "Prepare the shipment") => {
  const r = await extractSubProcess(xml, ids, name);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
};
const refused = async (xml: string, ids: string[]) => {
  const r = await extractSubProcess(xml, ids, "Do it");
  expect(r.ok).toBe(false);
  return (r as { errors: string[] }).errors.join(" | ");
};

describe("extract a fragment into a collapsed sub-process", () => {
  it("rewires semantics, moves DI to a drill-down plane at the origin, and passes every check", async () => {
    const r = await ok(chain(5), ["T2", "T3"]);
    expect(r.subProcessId).toBe("Sub_prepare_the_shipment");
    expect(r.moved.sort()).toEqual(["F2", "T2", "T3"]);
    expect(await validateXml(r.xml)).toEqual([]);

    const { elementsById, definitions } = await parse(r.xml);
    const sub = elementsById["Sub_prepare_the_shipment"];
    expect(sub.$parent.id).toBe("P");
    expect(elementsById["F1"].targetRef.id).toBe(sub.id); // T1 -> Sub
    expect(elementsById["F3"].sourceRef.id).toBe(sub.id); // Sub -> T4
    expect(elementsById["T2"].$parent).toBe(sub);
    expect(elementsById[`${sub.id}_FlowIn`].targetRef.id).toBe("T2");
    expect(elementsById[`${sub.id}_FlowOut`].sourceRef.id).toBe("T3");

    const main = definitions.diagrams[0].plane;
    const subShape = main.planeElement.find((pe: any) => pe.bpmnElement === sub);
    expect(subShape.isExpanded).toBe(false);
    expect(main.planeElement.some((pe: any) => ["T2", "T3"].includes(pe.bpmnElement?.id))).toBe(false);
    const plane = definitions.diagrams.find((d: any) => d.plane.bpmnElement === sub).plane;
    const xs = plane.planeElement.flatMap((pe: any) => [pe.bounds?.x, pe.label?.bounds?.x, ...(pe.waypoint ?? []).map((w: any) => w.x)].filter((v) => v !== undefined));
    expect(Math.min(...xs)).toBe(100);
  });

  it("keeps lanes consistent: the sub-process joins its lane, children leave the parent's lanes", async () => {
    const r = await ok(chain(5, { lanes: true }), ["T1"]); // T1 is in lane L_A
    const { elementsById } = await parse(r.xml);
    const ids = (lane: string) => elementsById[lane].flowNodeRef.map((n: any) => n.id);
    expect(ids("L_A")).toContain(r.subProcessId);
    expect(ids("L_A")).not.toContain("T1");
    expect((await validateXml(r.xml)).filter((i) => i.rule === "pm/lane-membership")).toEqual([]);
  });

  it("warns when the fragment spans several lanes", async () => {
    const r = await ok(chain(5, { lanes: true }), ["T2", "T3"]); // T2 in L_A, T3 in L_B
    expect(r.warnings.join()).toMatch(/spans 2 lanes/);
  });

  it("carries boundary events and annotations attached to the fragment", async () => {
    const extra =
      '<bpmn:boundaryEvent id="B1" attachedToRef="T2"><bpmn:timerEventDefinition /></bpmn:boundaryEvent>' +
      '<bpmn:textAnnotation id="N1"><bpmn:text>Weigh first</bpmn:text></bpmn:textAnnotation><bpmn:association id="A1" sourceRef="T2" targetRef="N1" />';
    const extraDi =
      '<bpmndi:BPMNShape id="B1_di" bpmnElement="B1"><dc:Bounds x="432" y="162" width="36" height="36" /></bpmndi:BPMNShape>' +
      '<bpmndi:BPMNShape id="N1_di" bpmnElement="N1"><dc:Bounds x="400" y="10" width="100" height="30" /></bpmndi:BPMNShape>' +
      '<bpmndi:BPMNEdge id="A1_di" bpmnElement="A1"><di:waypoint x="450" y="100" /><di:waypoint x="450" y="40" /></bpmndi:BPMNEdge>';
    const r = await ok(chain(4, { extra, extraDi }), ["T2"]);
    expect(r.moved.sort()).toEqual(["A1", "B1", "N1", "T2"]);
    const { elementsById } = await parse(r.xml);
    expect(elementsById["B1"].$parent.id).toBe(r.subProcessId);
    expect(elementsById["N1"].$parent.id).toBe(r.subProcessId);
  });

  it("refuses a fragment with two entries or two exits", async () => {
    // T1 -> T3 shortcut: the fragment [T2, T3] gets a second entry
    const xml = chain(4, { extra: '<bpmn:sequenceFlow id="Fx" sourceRef="T1" targetRef="T3" />' })
      .replace('<bpmndi:BPMNPlane id="Plane" bpmnElement="P">', '<bpmndi:BPMNPlane id="Plane" bpmnElement="P"><bpmndi:BPMNEdge id="Fx_di" bpmnElement="Fx"><di:waypoint x="300" y="100" /><di:waypoint x="550" y="100" /></bpmndi:BPMNEdge>');
    expect(await refused(xml, ["T2", "T3"])).toMatch(/exactly one entry flow, it has 2/);
  });

  it("refuses start or end events, unknown ids, and elements of different levels", async () => {
    expect(await refused(chain(3), ["S", "T1"])).toMatch(/Start and end events/);
    expect(await refused(chain(3), ["T9"])).toMatch(/Unknown element/);
    const nested = chain(3, { extra: '<bpmn:subProcess id="SP"><bpmn:task id="Inner" name="Inner" /></bpmn:subProcess>' });
    expect(await refused(nested, ["T1", "Inner"])).toMatch(/same process or sub-process/);
  });

  it("refuses a fragment touched by a message flow", async () => {
    const xml = chain(3, { lanes: true }).replace(
      "</bpmn:collaboration>",
      '<bpmn:participant id="Customer" name="Customer" /><bpmn:messageFlow id="M1" sourceRef="Customer" targetRef="T2" /></bpmn:collaboration>',
    );
    expect(await refused(xml, ["T2"])).toMatch(/Message flows touch the fragment.*M1/);
  });

  it("refuses data used inside and outside the fragment", async () => {
    const extra =
      '<bpmn:dataObjectReference id="DR" name="Order" dataObjectRef="DO" /><bpmn:dataObject id="DO" />';
    const xml = chain(3, { extra })
      .replace('<bpmn:task id="T1" name="Do T1">', '<bpmn:task id="T1" name="Do T1"><bpmn:dataOutputAssociation id="DA1"><bpmn:targetRef>DR</bpmn:targetRef></bpmn:dataOutputAssociation>')
      .replace('<bpmn:task id="T2" name="Do T2">', '<bpmn:task id="T2" name="Do T2"><bpmn:dataInputAssociation id="DA2"><bpmn:sourceRef>DR</bpmn:sourceRef></bpmn:dataInputAssociation>');
    expect(await refused(xml, ["T2"])).toMatch(/Data used inside and outside.*DR/);
  });
});

describe("extract_subprocess over MCP", () => {
  let server: Server;
  let client: Client;
  const store = new Store();

  beforeAll(async () => {
    const app = createApp({ store, publicUrl: "http://public.test" });
    server = await new Promise<Server>((res) => {
      const s = app.listen(0, "127.0.0.1", () => res(s));
    });
    client = new Client({ name: "refactor-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)));
  });
  afterAll(async () => {
    await client?.close();
    await new Promise((res) => server?.close(res));
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };

  it("saves a new AI revision with the sub-process", async () => {
    const id = store.create("Ship", chain(5)).id;
    const r = await call("extract_subprocess", { id, elementIds: ["T2", "T3"], name: "Prepare the shipment", baseVersion: 1 });
    expect(r.body).toMatchObject({ ok: true, version: 2, subProcessId: "Sub_prepare_the_shipment", issueSummary: { errors: 0, warnings: 0 } });
    expect(store.latest(store.get(id)!)).toMatchObject({ author: "ai", note: "extract_subprocess Sub_prepare_the_shipment" });
  });

  it("refuses a stale baseVersion and an invalid fragment without saving", async () => {
    const id = store.create("Ship", chain(4)).id;
    expect((await call("extract_subprocess", { id, elementIds: ["T2"], name: "X", baseVersion: 7 })).body).toMatchObject({ conflict: true });
    const r = await call("extract_subprocess", { id, elementIds: ["S", "T1"], name: "X", baseVersion: 1 });
    expect(r.isError).toBe(true);
    expect(r.body.reasons.join()).toMatch(/Start and end events/);
    expect(store.latest(store.get(id)!).version).toBe(1);
  });
});
