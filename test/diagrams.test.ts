import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { Store, cleanName } from "../src/store.js";
import { fixture } from "./helpers.js";

describe("diagram names", () => {
  it("are trimmed, length-limited and free of control characters", () => {
    expect(cleanName("  Commande   client ")).toEqual({ name: "Commande client" });
    expect(cleanName("")).toHaveProperty("error");
    expect(cleanName("   ")).toHaveProperty("error");
    expect(cleanName(42)).toHaveProperty("error");
    expect(cleanName("x".repeat(121))).toHaveProperty("error");
    expect(cleanName("a\u0007b")).toHaveProperty("error");
  });
});

describe("list, create and rename diagrams (web + MCP)", () => {
  let server: Server;
  let base: string;
  let client: Client;
  const store = new Store();

  beforeAll(async () => {
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "bpmn-ui-"));
    fs.writeFileSync(path.join(uiDir, "index.html"), "<title>canvas</title>");
    fs.writeFileSync(path.join(uiDir, "home.html"), "<title>Diagrammes BPMN</title>");
    const app = createApp({ store, publicUrl: "http://public.test", uiDir });
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: "diagrams-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client?.close();
    await new Promise((ok) => server?.close(ok));
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };
  const json = (method: string, url: string, body?: object) =>
    fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });

  it("serves the home page (list of diagrams) at /", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Diagrammes BPMN");
  });

  it("creates a diagram from the web, with a clean name and the empty template", async () => {
    const r = await json("POST", "/api/diagrams", { name: "  Achat   fournisseur ", author: "ana" });
    expect(r.status).toBe(201);
    const { id, name, version } = await r.json();
    expect({ name, version }).toEqual({ name: "Achat fournisseur", version: 1 });
    expect(store.latest(store.get(id)!)).toMatchObject({ author: "human:ana" });
    expect((await json("POST", "/api/diagrams", { name: "" })).status).toBe(400);
  });

  it("lists diagrams most recent first, with what the home page needs", async () => {
    const older = store.create("Older", fixture("valid.bpmn")).id;
    const newer = store.create("Newer", fixture("valid.bpmn")).id;
    store.update(newer, fixture("valid.bpmn"), 1, "human:ana");
    store.addComment(newer, { elementId: "Task_CheckOrder", text: "?", author: "human:ana" });
    const list = await (await fetch(`${base}/api/diagrams`)).json();
    expect(list[0]).toMatchObject({ id: newer, name: "Newer", version: 2, lastAuthor: "human:ana", openComments: 1 });
    expect(list.map((d: any) => d.id)).toContain(older);
    expect(list.map((d: any) => d.updatedAt)).toEqual([...list.map((d: any) => d.updatedAt)].sort().reverse());
  });

  it("list_diagrams gives each diagram its web canvas URL", async () => {
    const id = store.create("Visible", fixture("valid.bpmn")).id;
    const { body } = await call("list_diagrams", {});
    expect(body.find((d: any) => d.id === id)).toMatchObject({ name: "Visible", canvasUrl: `http://public.test/canvas?id=${id}` });
  });

  it("renames from MCP and from the web; export file names follow", async () => {
    const id = store.create("Old name", fixture("valid.bpmn")).id;
    expect((await call("rename_diagram", { id, name: "Traiter la commande" })).body).toEqual({ id, name: "Traiter la commande" });
    expect((await call("export_diagram", { id })).body.fileName).toBe("traiter-la-commande-v1.bpmn");

    const r = await json("PATCH", `/api/diagrams/${id}`, { name: "Traiter la commande client" });
    expect(await r.json()).toEqual({ id, name: "Traiter la commande client" });
    expect((await call("get_diagram", { id })).body.name).toBe("Traiter la commande client");

    expect((await call("rename_diagram", { id, name: " " })).isError).toBe(true);
    expect((await json("PATCH", "/api/diagrams/nope", { name: "x" })).status).toBe(404);
  });

  it("lets the AI draw a first version without DI on a diagram created from the web", async () => {
    const { id } = await (await json("POST", "/api/diagrams", { name: "From the web" })).json();
    const noDi = fixture("valid.bpmn").replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, "");
    const r = await call("update_diagram", { id, xml: noDi, baseVersion: 1 });
    expect(r.body).toMatchObject({ ok: true, version: 2, layout: { mode: "auto" } });
  });
});
