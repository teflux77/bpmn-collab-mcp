import { describe, expect, it } from "vitest";
import { autoLayout, hasDi } from "../src/autolayout.js";
import { parse } from "../src/model.js";
import { validateXml } from "../src/validate.js";
import { fixture, edit } from "./helpers.js";

/** The valid fixture with its whole BPMNDiagram removed. */
const withoutDi = (xml: string) => xml.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, "");

describe("autoLayout", () => {
  it("detects whether XML carries DI", async () => {
    expect(hasDi((await parse(fixture("valid.bpmn"))).definitions)).toBe(true);
    expect(hasDi((await parse(withoutDi(fixture("valid.bpmn")))).definitions)).toBe(false);
  });

  it("lays out a DI-less process so that it passes every check, artifacts and labels included", async () => {
    const r = await autoLayout(withoutDi(fixture("valid.bpmn")));
    expect(r.notes).toEqual([]);
    expect(await validateXml(r.xml)).toEqual([]);

    const { elementsById } = await parse(r.xml);
    const di = (id: string) => elementsById[`${id}_di`];
    // completion pass: what bpmn-auto-layout leaves out
    expect(di("Annotation_Carrier")?.bounds).toBeDefined();
    expect(di("Association_Carrier")?.waypoint?.length).toBeGreaterThanOrEqual(2);
    expect(di("DataOut_Order")?.waypoint?.length).toBeGreaterThanOrEqual(2);
    for (const id of ["Gateway_Approved", "Start_OrderReceived", "End_Shipped", "End_Rejected", "DataRef_Order", "Flow_Yes", "Flow_No"])
      expect(di(id)?.label?.bounds, `${id} label`).toBeDefined();
    // bpmn-auto-layout draws bpmn:DataObject, which has no visual representation
    expect(di("DataObject_Order")).toBeUndefined();
  });

  it("keeps business metadata (pm:Meta) intact", async () => {
    const r = await autoLayout(withoutDi(fixture("valid.bpmn")));
    expect(r.xml).toMatch(/<pm:meta owner="Sales clerk" sla="PT4H" formRef="form-check-order"/);
  });

  it("places the gateway label above the diamond", async () => {
    const { elementsById } = await parse((await autoLayout(withoutDi(fixture("valid.bpmn")))).xml);
    const gw = elementsById["Gateway_Approved_di"];
    const label = gw.label.bounds;
    expect(label.y + label.height).toBeLessThanOrEqual(gw.bounds.y - 8);
    expect(Math.abs(label.x + label.width / 2 - (gw.bounds.x + gw.bounds.width / 2))).toBeLessThanOrEqual(1);
  });

  it("reports artifacts it cannot place instead of guessing", async () => {
    const xml = edit(withoutDi(fixture("valid.bpmn")), [
      '<bpmn:association id="Association_Carrier" sourceRef="Task_ShipOrder" targetRef="Annotation_Carrier" />',
      "",
    ]);
    const r = await autoLayout(xml);
    expect(r.notes).toEqual([expect.stringContaining("TextAnnotation Annotation_Carrier was not laid out")]);
    expect((await validateXml(r.xml)).filter((i) => i.severity === "error").map((i) => i.elementId)).toEqual(["Annotation_Carrier"]);
  });
});
