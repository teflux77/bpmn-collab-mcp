import { describe, expect, it } from "vitest";
import { TYPE_FILL, fillFor } from "../ui/type-colors-map.js";

describe("canvas colours by element type", () => {
  it("colour start green, end red, intermediate and boundary orange, gateways yellow", () => {
    expect(fillFor("bpmn:StartEvent")).toBe(TYPE_FILL.start);
    expect(fillFor("bpmn:EndEvent")).toBe(TYPE_FILL.end);
    for (const t of ["bpmn:IntermediateCatchEvent", "bpmn:IntermediateThrowEvent", "bpmn:BoundaryEvent"]) expect(fillFor(t)).toBe(TYPE_FILL.intermediate);
    for (const t of ["bpmn:ExclusiveGateway", "bpmn:ParallelGateway", "bpmn:InclusiveGateway", "bpmn:EventBasedGateway", "bpmn:ComplexGateway"])
      expect(fillFor(t)).toBe(TYPE_FILL.gateway);
  });

  it("leave other elements to the bpmn-js defaults", () => {
    for (const t of ["bpmn:Task", "bpmn:UserTask", "bpmn:SubProcess", "bpmn:Participant", "bpmn:DataObjectReference", undefined]) expect(fillFor(t)).toBeUndefined();
  });

  it("use light tints (text and markers stay readable)", () => {
    for (const c of Object.values(TYPE_FILL)) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(200); // luminance on 0..255
    }
  });
});
