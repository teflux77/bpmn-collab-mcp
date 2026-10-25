import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { normalizeDrilldown, parse } from "../src/model.js";
import { validateXml } from "../src/validate.js";
import { fixture } from "./helpers.js";

/** The collapsed sub-process fixture with its drill-down plane moved far away (as generated diagrams do). */
function farPlane(dy = 2000) {
  const xml = fixture("collapsed-subprocess.bpmn");
  const start = xml.indexOf('<bpmndi:BPMNDiagram id="BPMNDiagram_Ship">');
  const plane = xml.slice(start).replace(/(<dc:Bounds x="\d+" y=")(\d+)/g, (_, a, y) => `${a}${Number(y) + dy}`)
    .replace(/(<di:waypoint x="\d+" y=")(\d+)/g, (_, a, y) => `${a}${Number(y) + dy}`);
  return xml.slice(0, start) + plane;
}

async function planeTop(xml: string, id: string) {
  const { definitions } = await parse(xml);
  const plane = definitions.diagrams.find((d: any) => d.plane.bpmnElement?.id === id).plane;
  const ys = plane.planeElement.flatMap((pe: any) => [pe.bounds?.y, pe.label?.bounds?.y, ...(pe.waypoint ?? []).map((w: any) => w.y)].filter((v) => v !== undefined));
  const xs = plane.planeElement.flatMap((pe: any) => [pe.bounds?.x, pe.label?.bounds?.x, ...(pe.waypoint ?? []).map((w: any) => w.x)].filter((v) => v !== undefined));
  return { x: Math.min(...xs), y: Math.min(...ys), plane };
}

describe("drill-down planes normalized for bpmn-js based tools (Camunda Modeler)", () => {
  it("moves a sub-process plane drawn far below to the origin, keeping relative positions", async () => {
    const before = await planeTop(farPlane(), "Sub_ShipOrder");
    expect(before.y).toBeGreaterThan(2000);
    const { xml, moved } = await normalizeDrilldown(farPlane());
    expect(moved).toEqual(["Sub_ShipOrder"]);
    const after = await planeTop(xml, "Sub_ShipOrder");
    expect({ x: after.x, y: after.y }).toEqual({ x: 100, y: 100 });
    const gap = (p: any) => p.planeElement[2].bounds.x - p.planeElement[1].bounds.x; // pick -> pack
    expect(gap(after.plane)).toBe(gap(before.plane));
    expect(await validateXml(xml)).toEqual([]);
    // the main plane is not touched
    expect((await planeTop(xml, "Process_Order")).y).toBe((await planeTop(farPlane(), "Process_Order")).y);
  });

  it("leaves a plane already near the origin (and its XML) unchanged", async () => {
    const xml = fixture("collapsed-subprocess.bpmn");
    expect(await normalizeDrilldown(xml)).toEqual({ xml, moved: [] });
  });

  it("keeps business metadata (pm:Meta) when it rewrites the XML", async () => {
    const withMeta = farPlane().replace(
      '<bpmn:task id="Task_PickItems" name="Pick items">',
      '<bpmn:task id="Task_PickItems" name="Pick items"><bpmn:extensionElements><pm:meta owner="Warehouse" /></bpmn:extensionElements>',
    ).replace('id="Definitions_Sub"', 'xmlns:pm="https://github.com/teflux77/bpmn-collab-mcp/schema/process-meta/1.0" id="Definitions_Sub"');
    const { xml } = await normalizeDrilldown(withMeta);
    expect(xml).toMatch(/<pm:meta owner="Warehouse"/);
  });
});

describe("exports and AI saves", () => {
  let server: Server;
  let base: string;
  let client: Client;
  const store = new Store();

  beforeAll(async () => {
    const app = createApp({ store, publicUrl: "http://public.test" });
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: "drilldown-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client?.close();
    await new Promise((ok) => server?.close(ok));
  });
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);

  it("downloads (REST, signed link, export_diagram) open sub-processes at the origin, even for stored far planes", async () => {
    const id = store.create("Far planes", fixture("valid.bpmn")).id;
    store.update(id, farPlane(), 1, "human:ana"); // stored as the human drew it
    expect((await planeTop(store.latest(store.get(id)!).xml, "Sub_ShipOrder")).y).toBeGreaterThan(2000);

    const rest = await (await fetch(`${base}/api/diagrams/${id}/export.bpmn`)).text();
    expect((await planeTop(rest, "Sub_ShipOrder")).y).toBe(100);

    const out = await call("export_diagram", { id });
    expect((await planeTop(out.xml, "Sub_ShipOrder")).y).toBe(100);
    const viaLink = await (await fetch(`${base}${new URL(out.downloadUrl).pathname}`)).text();
    expect((await planeTop(viaLink, "Sub_ShipOrder")).y).toBe(100);

    // the human's stored revision itself is left as drawn
    expect((await planeTop(store.latest(store.get(id)!).xml, "Sub_ShipOrder")).y).toBeGreaterThan(2000);
  });

  it("stores AI saves with sub-process planes at the origin and says so", async () => {
    const created = await call("create_diagram", { name: "AI far planes", xml: farPlane() });
    expect(created).toMatchObject({ ok: true, planesMovedToOrigin: ["Sub_ShipOrder"] });
    expect((await planeTop(store.latest(store.get(created.id)!).xml, "Sub_ShipOrder")).y).toBe(100);

    const updated = await call("update_diagram", { id: created.id, xml: farPlane(3000), baseVersion: 1 });
    expect(updated).toMatchObject({ ok: true, version: 2, planesMovedToOrigin: ["Sub_ShipOrder"] });
  });
});
