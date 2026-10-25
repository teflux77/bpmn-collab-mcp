import { describe, expect, it } from "vitest";
import { moddle, parse, metaOf, toXml, PM_NS } from "../src/model.js";
import { fixture } from "./helpers.js";

describe("pm: moddle extension", () => {
  it("uses the project namespace", () => {
    expect(PM_NS).toBe("https://github.com/teflux77/bpmn-collab-mcp/schema/process-meta/1.0");
  });

  it("reads pm:Meta from extensionElements as a typed element", async () => {
    const { elementsById, warnings } = await parse(fixture("valid.bpmn"));
    expect(warnings).toEqual([]);
    const meta = elementsById["Task_CheckOrder"].extensionElements.values[0];
    expect(meta.$type).toBe("pm:Meta");
    expect(metaOf(elementsById["Task_CheckOrder"])).toEqual({ owner: "Sales clerk", sla: "PT4H", formRef: "form-check-order" });
    expect(metaOf(elementsById["Process_Order"])).toEqual({ owner: "Sales", level: "3" });
  });

  it("round-trips pm:Meta: modified and newly created metadata survive toXML/fromXML", async () => {
    const { definitions, elementsById } = await parse(fixture("valid.bpmn"));
    elementsById["Task_CheckOrder"].extensionElements.values[0].kpi = "lead time";

    const m = moddle();
    const ship = elementsById["Task_ShipOrder"];
    ship.extensionElements = m.create("bpmn:ExtensionElements", { values: [m.create("pm:Meta", { system: "WMS", decisionRef: "dec-carrier" })] });

    const xml = await toXml(definitions);
    expect(xml).toContain(`xmlns:pm="${PM_NS}"`);
    expect(xml).toMatch(/<pm:meta [^>]*kpi="lead time"/);

    const again = await parse(xml);
    expect(again.warnings).toEqual([]);
    expect(metaOf(again.elementsById["Task_CheckOrder"])).toMatchObject({ owner: "Sales clerk", kpi: "lead time" });
    expect(metaOf(again.elementsById["Task_ShipOrder"])).toEqual({ system: "WMS", decisionRef: "dec-carrier" });
  });
});
