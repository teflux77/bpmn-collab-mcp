import { describe, expect, it } from "vitest";
import { validateXml } from "../src/validate.js";

const RULES = /^pm\/(message-flow-between-pools|sequence-flow-in-container|pools-without-interaction|lane-membership|empty-pool)$/;
const found = async (xml: string) =>
  (await validateXml(xml)).filter((i) => RULES.test(i.rule)).map((i) => `${i.severity} ${i.rule}@${i.elementId}`).sort();

const defs = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">${body}</bpmn:definitions>`;

/** Our organisation (white box, two lanes) and a customer (black box), one message each way. */
const collab = (opts: { mf?: string; extraPool?: string; lanes?: string; procExtra?: string } = {}) =>
  defs(`
  <bpmn:collaboration id="C">
    <bpmn:participant id="P_Shop" name="Shop" processRef="Proc_Shop" />
    <bpmn:participant id="P_Customer" name="Customer" />
    ${opts.extraPool ?? ""}
    ${opts.mf ?? '<bpmn:messageFlow id="MF_Order" sourceRef="P_Customer" targetRef="S" /><bpmn:messageFlow id="MF_Confirm" sourceRef="T2" targetRef="P_Customer" />'}
  </bpmn:collaboration>
  <bpmn:process id="Proc_Shop" isExecutable="false">
    <bpmn:laneSet id="LS">
      ${opts.lanes ?? '<bpmn:lane id="L_Sales" name="Sales"><bpmn:flowNodeRef>S</bpmn:flowNodeRef><bpmn:flowNodeRef>T1</bpmn:flowNodeRef></bpmn:lane><bpmn:lane id="L_Ship" name="Shipping"><bpmn:flowNodeRef>T2</bpmn:flowNodeRef><bpmn:flowNodeRef>E</bpmn:flowNodeRef></bpmn:lane>'}
    </bpmn:laneSet>
    <bpmn:startEvent id="S" name="Order received"><bpmn:messageEventDefinition /></bpmn:startEvent>
    <bpmn:task id="T1" name="Check order" />
    <bpmn:sendTask id="T2" name="Confirm shipment" />
    <bpmn:endEvent id="E" name="Done" />
    <bpmn:sequenceFlow id="F1" sourceRef="S" targetRef="T1" />
    <bpmn:sequenceFlow id="F2" sourceRef="T1" targetRef="T2" />
    <bpmn:sequenceFlow id="F3" sourceRef="T2" targetRef="E" />
    ${opts.procExtra ?? ""}
  </bpmn:process>`);

describe("pools, lanes and message flows", () => {
  it("accept a collaboration: one white-box pool with lanes, a black-box partner, message flows between pools", async () => {
    expect(await found(collab())).toEqual([]);
  });

  it("refuse a message flow inside one pool (BPMN 2.0.2, 9.4: MUST connect two separate pools)", async () => {
    const xml = collab({ mf: '<bpmn:messageFlow id="MF_Inside" sourceRef="T1" targetRef="T2" />' });
    expect(await found(xml)).toEqual(["error pm/message-flow-between-pools@MF_Inside"]);
  });

  it("refuse a sequence flow crossing a pool boundary (7.2.1)", async () => {
    const xml = collab({
      extraPool: '<bpmn:participant id="P_Carrier" name="Carrier" processRef="Proc_Carrier" />',
      mf: '<bpmn:messageFlow id="MF_Pick" sourceRef="T2" targetRef="C1" />',
    }).replace("</bpmn:definitions>", `<bpmn:process id="Proc_Carrier" isExecutable="false">
      <bpmn:startEvent id="C1" name="Pickup requested" /><bpmn:task id="C2" name="Deliver" />
      <bpmn:sequenceFlow id="CF1" sourceRef="C1" targetRef="C2" /><bpmn:sequenceFlow id="CF_Cross" sourceRef="C2" targetRef="E" />
    </bpmn:process></bpmn:definitions>`);
    expect(await found(xml)).toContain("error pm/sequence-flow-in-container@CF_Cross");
  });

  it("refuse a sequence flow crossing a sub-process boundary", async () => {
    const xml = collab({
      procExtra: '<bpmn:subProcess id="Sub" name="Pack order"><bpmn:task id="ST" name="Pack" /></bpmn:subProcess><bpmn:sequenceFlow id="F_Into" sourceRef="T1" targetRef="ST" />',
      lanes: '<bpmn:lane id="L_All" name="Sales"><bpmn:flowNodeRef>S</bpmn:flowNodeRef><bpmn:flowNodeRef>T1</bpmn:flowNodeRef><bpmn:flowNodeRef>T2</bpmn:flowNodeRef><bpmn:flowNodeRef>E</bpmn:flowNodeRef><bpmn:flowNodeRef>Sub</bpmn:flowNodeRef></bpmn:lane>',
    });
    expect(await found(xml)).toEqual(["error pm/sequence-flow-in-container@F_Into"]);
  });

  it("warn when white-box pools exchange no message (internal departments drawn as pools)", async () => {
    const xml = defs(`
      <bpmn:collaboration id="C">
        <bpmn:participant id="P_Sales" name="Sales" processRef="PS" /><bpmn:participant id="P_Finance" name="Finance" processRef="PF" />
      </bpmn:collaboration>
      <bpmn:process id="PS" isExecutable="false"><bpmn:task id="A" name="Sell" /></bpmn:process>
      <bpmn:process id="PF" isExecutable="false"><bpmn:task id="B" name="Invoice" /></bpmn:process>`);
    expect(await found(xml)).toEqual(["warning pm/pools-without-interaction@P_Finance", "warning pm/pools-without-interaction@P_Sales"]);
  });

  it("warn when an element of a process with lanes is in no lane, or in two", async () => {
    const none = collab({ lanes: '<bpmn:lane id="L_Sales" name="Sales"><bpmn:flowNodeRef>S</bpmn:flowNodeRef><bpmn:flowNodeRef>T1</bpmn:flowNodeRef><bpmn:flowNodeRef>T2</bpmn:flowNodeRef></bpmn:lane>' });
    expect(await found(none)).toEqual(["warning pm/lane-membership@E"]);
    const twice = collab({
      lanes: '<bpmn:lane id="L1" name="A"><bpmn:flowNodeRef>S</bpmn:flowNodeRef><bpmn:flowNodeRef>T1</bpmn:flowNodeRef><bpmn:flowNodeRef>T2</bpmn:flowNodeRef><bpmn:flowNodeRef>E</bpmn:flowNodeRef></bpmn:lane><bpmn:lane id="L2" name="B"><bpmn:flowNodeRef>T1</bpmn:flowNodeRef></bpmn:lane>',
    });
    expect(await found(twice)).toEqual(["warning pm/lane-membership@T1"]);
  });

  it("count nested lanes by their leaves", async () => {
    const nested = collab({
      lanes: '<bpmn:lane id="L_Dept" name="Operations"><bpmn:childLaneSet id="CLS"><bpmn:lane id="L_Clerk" name="Clerk"><bpmn:flowNodeRef>S</bpmn:flowNodeRef><bpmn:flowNodeRef>T1</bpmn:flowNodeRef></bpmn:lane><bpmn:lane id="L_Driver" name="Driver"><bpmn:flowNodeRef>T2</bpmn:flowNodeRef><bpmn:flowNodeRef>E</bpmn:flowNodeRef></bpmn:lane></bpmn:childLaneSet></bpmn:lane>',
    });
    expect(await found(nested)).toEqual([]);
  });

  it("suggest a black box for a pool whose process is empty", async () => {
    const xml = collab({ extraPool: '<bpmn:participant id="P_Bank" name="Bank" processRef="Proc_Bank" />' }).replace(
      "</bpmn:definitions>",
      '<bpmn:process id="Proc_Bank" isExecutable="false" /></bpmn:definitions>',
    );
    expect(await found(xml)).toEqual(["info pm/empty-pool@P_Bank"]);
  });
});
