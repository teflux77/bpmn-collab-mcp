import { describe, expect, it } from "vitest";
import { validateXml, type Issue } from "../src/validate.js";
import { rectsOverlap, segmentHitsRect } from "../src/layout-check.js";
import { fixture, edit } from "./helpers.js";

const base = fixture("valid.bpmn");

/** Issues of one rule, as "severity@elementId". */
async function found(xml: string, rule: string) {
  return (await validateXml(xml)).filter((i: Issue) => i.rule === rule).map((i) => `${i.severity}@${i.elementId}`);
}

describe("geometry helpers", () => {
  const r = { x: 0, y: 0, width: 10, height: 10 };
  it("detects rectangle overlap but not mere contact", () => {
    expect(rectsOverlap(r, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap(r, { x: 10, y: 0, width: 5, height: 5 })).toBe(false);
  });
  it("detects segments crossing or lying inside a rectangle, not passing beside it", () => {
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 15, y: 5 }, r)).toBe(true);
    expect(segmentHitsRect({ x: 2, y: 2 }, { x: 8, y: 8 }, r)).toBe(true);
    expect(segmentHitsRect({ x: -5, y: 12 }, { x: 15, y: 12 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 10, y: -5 }, { x: 10, y: 15 }, r)).toBe(false); // along the border
  });
});

describe("layout checks (validate)", () => {
  it("the valid fixture passes every layout check", async () => {
    expect((await validateXml(base)).filter((i) => i.severity !== "info")).toEqual([]);
  });

  describe("missing DI (error: rejects AI saves)", () => {
    it("flags a data object reference and an annotation without DI", async () => {
      const xml = edit(
        base,
        [base.slice(base.indexOf('<bpmndi:BPMNShape id="DataRef_Order_di"'), base.indexOf('<bpmndi:BPMNShape id="Annotation_Carrier_di"')), ""],
        [base.slice(base.indexOf('<bpmndi:BPMNShape id="Annotation_Carrier_di"'), base.indexOf('<bpmndi:BPMNEdge id="Flow_1_di"')), ""],
      );
      expect((await found(xml, "no-bpmndi")).sort()).toEqual(["error@Annotation_Carrier", "error@DataRef_Order"]);
    });
  });

  describe("pm/shared-attachment-point (warning)", () => {
    it("flags two flows leaving a gateway from the same point", async () => {
      const xml = edit(base, ['<di:waypoint x="420" y="245" />', '<di:waypoint x="445" y="220" />']);
      expect(await found(xml, "pm/shared-attachment-point")).toEqual(["warning@Gateway_Approved"]);
    });
  });

  describe("pm/label-overlap (warning)", () => {
    it("flags a flow label sitting on its own line", async () => {
      const xml = edit(base, ['<dc:Bounds x="460" y="198" width="20" height="14" />', '<dc:Bounds x="460" y="213" width="20" height="14" />']);
      expect(await found(xml, "pm/label-overlap")).toEqual(["warning@Flow_Yes"]);
    });

    it("flags a label on top of a shape", async () => {
      const xml = edit(base, ['<dc:Bounds x="380" y="160" width="80" height="27" />', '<dc:Bounds x="510" y="190" width="80" height="27" />']);
      expect(await found(xml, "pm/label-overlap")).toEqual(["warning@Gateway_Approved"]);
    });

    it("flags two overlapping labels", async () => {
      const xml = edit(base, ['<dc:Bounds x="432" y="270" width="16" height="14" />', '<dc:Bounds x="465" y="200" width="16" height="14" />']);
      expect((await found(xml, "pm/label-overlap")).sort()).toEqual(["warning@Flow_No", "warning@Flow_Yes"]);
    });

    it("flags a label crossing a container border (group, lane, pool, expanded sub-process)", async () => {
      const xml = edit(
        base,
        ["  </bpmn:process>", '  <bpmn:group id="Group_Check" />\n  </bpmn:process>'],
        ["    </bpmndi:BPMNPlane>", '      <bpmndi:BPMNShape id="Group_Check_di" bpmnElement="Group_Check">\n        <dc:Bounds x="220" y="150" width="200" height="130" />\n      </bpmndi:BPMNShape>\n    </bpmndi:BPMNPlane>'],
      );
      expect(await found(xml, "pm/label-overlap")).toEqual(["warning@Gateway_Approved"]);
    });
  });

  describe("pm/gateway-label-bounds (warning)", () => {
    it("flags a named gateway relying on default label placement", async () => {
      const xml = edit(base, [
        '<bpmndi:BPMNLabel>\n          <dc:Bounds x="380" y="160" width="80" height="27" />\n        </bpmndi:BPMNLabel>\n',
        "",
      ]);
      expect(await found(xml, "pm/gateway-label-bounds")).toEqual(["warning@Gateway_Approved"]);
    });
  });

  describe("explicit joins: bpmnlint fake-join (warning)", () => {
    it("flags two flows converging directly on an activity", async () => {
      const xml = edit(
        base,
        ['sourceRef="Gateway_Approved" targetRef="End_Rejected"', 'sourceRef="Gateway_Approved" targetRef="Task_ShipOrder"'],
        ["<bpmn:incoming>Flow_Yes</bpmn:incoming>", "<bpmn:incoming>Flow_Yes</bpmn:incoming>\n      <bpmn:incoming>Flow_No</bpmn:incoming>"],
      );
      expect(await found(xml, "fake-join")).toContain("warning@Task_ShipOrder");
    });
  });

  describe("shape overlap: bpmnlint no-overlapping-elements (warning)", () => {
    it("flags an event drawn on top of a task", async () => {
      const xml = edit(base, ['<dc:Bounds x="652" y="312" width="36" height="36" />', '<dc:Bounds x="530" y="200" width="36" height="36" />']);
      expect(await found(xml, "no-overlapping-elements")).toEqual(expect.arrayContaining(["warning@End_Rejected"]));
    });
  });

  describe("@miragon/bpmnlint-plugin-rules", () => {
    it("flow-through-element (warning): a flow routed through an unrelated shape", async () => {
      // move the "Order shipped" end event onto the "No" branch (data objects are not considered)
      const xml = edit(base, ['<dc:Bounds x="652" y="202" width="36" height="36" />', '<dc:Bounds x="540" y="312" width="36" height="36" />']);
      expect(await found(xml, "@miragon/rules/flow-through-element")).toEqual(["warning@Flow_No"]);
    });

    it("flow-orthogonal (warning): a diagonal segment", async () => {
      const xml = edit(base, ['<di:waypoint x="188" y="220" />\n        <di:waypoint x="240" y="220" />', '<di:waypoint x="188" y="220" />\n        <di:waypoint x="240" y="240" />']);
      expect(await found(xml, "@miragon/rules/flow-orthogonal")).toEqual(["warning@Flow_1"]);
    });

    it("exclusive-gateway-marker-visible (warning): XOR drawn without its X", async () => {
      const xml = edit(base, [' isMarkerVisible="true"', ""]);
      expect(await found(xml, "@miragon/rules/exclusive-gateway-marker-visible")).toEqual(["warning@Gateway_Approved"]);
    });
  });
});
