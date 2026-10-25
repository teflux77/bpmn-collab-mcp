import { describe, expect, it } from "vitest";
import { diffXml } from "../src/diff.js";
import { fixture, edit } from "./helpers.js";

const base = fixture("valid.bpmn");

describe("diffXml", () => {
  it("reports nothing for identical revisions", async () => {
    expect(await diffXml(base, base)).toEqual({ added: [], removed: [], modified: [], moved: [] });
  });

  it("reports a rename with before/after values", async () => {
    const d = await diffXml(base, edit(base, ['name="Ship order"', 'name="Ship parcel"']));
    expect(d.modified).toEqual([
      { id: "Task_ShipOrder", type: "bpmn:Task", name: "Ship parcel", fields: { name: { before: "Ship order", after: "Ship parcel" } } },
    ]);
  });

  it("reports pm:Meta changes on the owning element", async () => {
    const d = await diffXml(base, edit(base, ['owner="Sales clerk" sla="PT4H"', 'owner="Back office" sla="PT4H"']));
    expect(d.modified).toEqual([
      expect.objectContaining({ id: "Task_CheckOrder", fields: { "pm:owner": { before: "Sales clerk", after: "Back office" } } }),
    ]);
  });

  it("reports a re-targeted flow as reference ids", async () => {
    const d = await diffXml(base, edit(base, ['sourceRef="Gateway_Approved" targetRef="End_Rejected"', 'sourceRef="Gateway_Approved" targetRef="End_Shipped"']));
    expect(d.modified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Flow_No", fields: { targetRef: { before: "End_Rejected", after: "End_Shipped" } } }),
      ]),
    );
  });

  it("reports a moved shape in moved, not in modified", async () => {
    const d = await diffXml(base, edit(base, ['<dc:Bounds x="490" y="60"', '<dc:Bounds x="700" y="60"']));
    expect(d.moved).toEqual([{ id: "Annotation_Carrier", type: "bpmn:TextAnnotation" }]);
    expect(d.modified).toEqual([]);
  });

  it("reports an edited annotation text on the annotation itself", async () => {
    const d = await diffXml(base, edit(base, ["Carrier chosen by weight", "Carrier chosen by price"]));
    expect(d.modified).toEqual([
      expect.objectContaining({ id: "Annotation_Carrier", fields: { text: { before: "Carrier chosen by weight", after: "Carrier chosen by price" } } }),
    ]);
  });

  // remove the annotation and its association from the semantics
  const withoutAnnotation = (xml: string) =>
    edit(
      xml,
      ['<bpmn:textAnnotation id="Annotation_Carrier">\n      <bpmn:text>Carrier chosen by weight</bpmn:text>\n    </bpmn:textAnnotation>\n', ""],
      ['<bpmn:association id="Association_Carrier" sourceRef="Task_ShipOrder" targetRef="Annotation_Carrier" />\n', ""],
    );
  // ...and from the DI
  const withoutAnnotationDi = (xml: string) => {
    const cut = (from: string, to: string) => xml.slice(xml.indexOf(from), xml.indexOf(to));
    return edit(
      xml,
      [cut('<bpmndi:BPMNShape id="Annotation_Carrier_di"', '<bpmndi:BPMNEdge id="Flow_1_di"'), ""],
      [cut('<bpmndi:BPMNEdge id="Association_Carrier_di"', "</bpmndi:BPMNPlane>"), ""],
    );
  };

  it("reports added and removed elements, artifacts included", async () => {
    const next = edit(withoutAnnotationDi(withoutAnnotation(base)), ["  </bpmn:process>", '  <bpmn:group id="Group_Shipping" />\n  </bpmn:process>']);
    const d = await diffXml(base, next);
    expect(d.added).toEqual([{ id: "Group_Shipping", type: "bpmn:Group" }]);
    expect(d.removed.map((r) => r.id).sort()).toEqual(["Annotation_Carrier", "Association_Carrier"]);
    expect(d.partial).toBeUndefined();
  });

  it("does not crash when DI still points to deleted elements (human saves are kept as-is)", async () => {
    const d = await diffXml(base, withoutAnnotation(base));
    expect(d.removed.map((r) => r.id).sort()).toEqual(["Annotation_Carrier", "Association_Carrier"]);
    expect(d.partial).toMatch(/bpmn-js-differ failed/);
  });
});
