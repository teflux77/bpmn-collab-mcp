import { describe, expect, it } from "vitest";
import { contentBox, needsRefit } from "../ui/view.js";
import { autoLayout } from "../src/autolayout.js";
import { parse } from "../src/model.js";

const shape = (x: number, y: number, width = 100, height = 80) => ({ x, y, width, height });

describe("drill-down view", () => {
  it("computes the content box of shapes and connections", () => {
    expect(contentBox([shape(100, 1355), { waypoints: [{ x: 50, y: 1400 }, { x: 300, y: 1600 }] }])).toEqual({ x: 50, y: 1355, width: 250, height: 245 });
    expect(contentBox([])).toBeUndefined();
  });

  it("re-fits a sub-process plane whose content is far from where bpmn-js opens it", () => {
    const atOrigin = { x: 0, y: 0, width: 1200, height: 700 }; // first opening of a plane
    // the production case: content drawn between y=1355 and y=1585
    expect(needsRefit(atOrigin, contentBox([shape(82, 1355), shape(1338, 1505)]))).toBe(true);
    // content near the origin: keep the view
    expect(needsRefit(atOrigin, contentBox([shape(100, 100), shape(600, 300)]))).toBe(false);
    // mostly visible (more than a quarter): keep the view
    expect(needsRefit(atOrigin, contentBox([shape(100, 100), shape(1300, 300)]))).toBe(false);
    // nothing to show: nothing to do
    expect(needsRefit(atOrigin, undefined)).toBe(false);
  });
});

describe("auto-layout drill-down planes start near the origin", () => {
  it("shifts a sub-process plane so its content starts at (100, 100)", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x"><bpmn:process id="P" isExecutable="false">
<bpmn:startEvent id="S" name="Start"><bpmn:outgoing>F0</bpmn:outgoing></bpmn:startEvent>
<bpmn:task id="T" name="Check order"><bpmn:incoming>F0</bpmn:incoming><bpmn:outgoing>F1</bpmn:outgoing></bpmn:task>
<bpmn:subProcess id="Sub" name="Ship order"><bpmn:incoming>F1</bpmn:incoming><bpmn:outgoing>F2</bpmn:outgoing>
 <bpmn:startEvent id="SS" name="Go"><bpmn:outgoing>SF0</bpmn:outgoing></bpmn:startEvent>
 <bpmn:task id="ST0" name="Pick items"><bpmn:incoming>SF0</bpmn:incoming><bpmn:outgoing>SF1</bpmn:outgoing></bpmn:task>
 <bpmn:endEvent id="SE" name="Done"><bpmn:incoming>SF1</bpmn:incoming></bpmn:endEvent>
 <bpmn:sequenceFlow id="SF0" sourceRef="SS" targetRef="ST0"/><bpmn:sequenceFlow id="SF1" sourceRef="ST0" targetRef="SE"/></bpmn:subProcess>
<bpmn:endEvent id="E" name="End"><bpmn:incoming>F2</bpmn:incoming></bpmn:endEvent>
<bpmn:sequenceFlow id="F0" sourceRef="S" targetRef="T"/><bpmn:sequenceFlow id="F1" sourceRef="T" targetRef="Sub"/><bpmn:sequenceFlow id="F2" sourceRef="Sub" targetRef="E"/>
</bpmn:process></bpmn:definitions>`;
    const { definitions } = await parse((await autoLayout(xml)).xml);
    const plane = definitions.diagrams.find((d: any) => d.plane.bpmnElement?.id === "Sub").plane;
    const xs = plane.planeElement.flatMap((pe: any) => (pe.bounds ? [pe.bounds.x] : pe.waypoint.map((w: any) => w.x)));
    // labels count too: the top-most item (shape, label or waypoint) sits at y = 100
    const ys = plane.planeElement.flatMap((pe: any) =>
      pe.bounds ? [pe.bounds.y, ...(pe.label?.bounds ? [pe.label.bounds.y] : [])] : pe.waypoint.map((w: any) => w.y),
    );
    expect(Math.min(...xs)).toBe(100);
    expect(Math.min(...ys)).toBe(100);
  });
});
