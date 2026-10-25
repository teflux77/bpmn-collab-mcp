import { describe, expect, it } from "vitest";
import { validateXml, type Issue } from "../src/validate.js";
import { fixture, edit } from "./helpers.js";

const byRule = (issues: Issue[], severity: Issue["severity"]) =>
  issues.filter((i) => i.severity === severity).map((i) => `${i.rule}@${i.elementId}`).sort();

describe("validateXml", () => {
  it("accepts the valid fixture without any issue (data object, annotation and pm:Meta included)", async () => {
    expect(await validateXml(fixture("valid.bpmn"))).toEqual([]);
  });

  it("reports errors and warnings on the invalid fixture", async () => {
    const issues = await validateXml(fixture("invalid.bpmn"));
    expect(byRule(issues, "error")).toEqual([
      "moddle-warning@Flow_Dangling",
      "no-bpmndi@Flow_C",
      "no-bpmndi@Flow_Dangling",
      "no-bpmndi@Task_NoDI",
      "pm/call-activity-ref@Call_NoRef",
      "start-event-required@Process_Bad",
    ]);
    expect(byRule(issues, "warning")).toEqual(
      expect.arrayContaining([
        "end-event-required@Process_Bad",
        "label-required@Task_Unnamed",
        "pm/gateway-flow-label@Flow_B",
        "pm/gateway-flow-label@Flow_C",
      ]),
    );
  });

  it.each(["not xml at all", "<bpmn:definitions", "<foo/>", ""])("rejects unparsable input %j", async (xml) => {
    expect(await validateXml(xml)).toEqual([expect.objectContaining({ rule: "xml-parse", severity: "error" })]);
  });

  it("flags a user task without pm:formRef as info only", async () => {
    const xml = edit(fixture("valid.bpmn"), [' formRef="form-check-order"', ""]);
    expect(await validateXml(xml)).toEqual([
      expect.objectContaining({ rule: "pm/user-task-form", severity: "info", elementId: "Task_CheckOrder" }),
    ]);
  });

  it("accepts an unlabeled gateway branch when it is the default flow", async () => {
    const xml = edit(
      fixture("valid.bpmn"),
      ['<bpmn:sequenceFlow id="Flow_No" name="No"', '<bpmn:sequenceFlow id="Flow_No"'],
      ['<bpmn:exclusiveGateway id="Gateway_Approved" name="Order approved?">', '<bpmn:exclusiveGateway id="Gateway_Approved" name="Order approved?" default="Flow_No">'],
    );
    expect(await validateXml(xml)).toEqual([]);
  });

  it("warns on an unlabeled, non-default gateway branch", async () => {
    const xml = edit(fixture("valid.bpmn"), ['<bpmn:sequenceFlow id="Flow_No" name="No"', '<bpmn:sequenceFlow id="Flow_No"']);
    expect(await validateXml(xml)).toEqual([
      expect.objectContaining({ rule: "pm/gateway-flow-label", severity: "warning", elementId: "Flow_No" }),
    ]);
  });
});
