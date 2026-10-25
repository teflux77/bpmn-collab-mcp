import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { fixture, edit } from "./helpers.js";

let server: Server;
let base: string;
let client: Client;

beforeAll(async () => {
  // A stand-in for the built canvas so the ui:// resource can be served without a UI build.
  const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), "bpmn-ui-"));
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html><title>canvas</title>");
  const app = createApp({ store: new Store(), publicUrl: "http://canvas.test", uiDir });
  server = await new Promise<Server>((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await new Promise((ok) => server?.close(ok));
});

/** Call an MCP tool and parse its JSON text payload. */
async function call(name: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name, arguments: args });
  const body = JSON.parse(r.content[0].text);
  return { isError: !!r.isError, body };
}

const putHuman = (id: string, xml: string, baseVersion: number) =>
  fetch(`${base}/api/diagrams/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xml, baseVersion, author: "ana" }),
  });

describe("MCP over streamable HTTP", () => {
  let id: string;

  beforeEach(async () => {
    const { body } = await call("create_diagram", { name: "Order", xml: fixture("valid.bpmn") });
    id = body.id;
  });

  it("lists the tools; canvas tools are app-only, create/get show the inline canvas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_comment", "canvas_add_comment", "canvas_export_link", "canvas_load", "canvas_save", "canvas_set_comment_status",
      "create_diagram", "export_diagram", "get_changes_since", "get_diagram",
      "list_comments", "list_diagrams", "resolve_comment", "update_diagram", "validate_diagram",
    ]);
    const meta = (name: string) => (tools.find((t) => t.name === name)?._meta as any)?.ui;
    expect(meta("create_diagram")).toEqual({ resourceUri: "ui://bpmn-collab/canvas.html" });
    expect(meta("get_diagram")).toEqual({ resourceUri: "ui://bpmn-collab/canvas.html" });
    for (const t of tools.filter((t) => t.name.startsWith("canvas_"))) expect(meta(t.name).visibility).toEqual(["app"]);
    expect(meta("update_diagram")).toBeUndefined();
  });

  it("serves the canvas as an MCP Apps resource", async () => {
    const r: any = await client.readResource({ uri: "ui://bpmn-collab/canvas.html" });
    expect(r.contents[0]).toMatchObject({ uri: "ui://bpmn-collab/canvas.html", mimeType: "text/html;profile=mcp-app" });
    expect(r.contents[0].text).toContain("<title>canvas</title>");
  });

  it("canvas tools save as the human, with the same rules as the REST API", async () => {
    const loaded = await call("canvas_load", { id });
    expect(loaded.body).toMatchObject({ version: 1, issues: [] });

    const saved = await call("canvas_save", { id, xml: fixture("invalid.bpmn"), baseVersion: 1, author: "ana" });
    expect(saved.body.version).toBe(2); // parsable with errors: kept
    expect((await call("canvas_save", { id, xml: "<nope", baseVersion: 2 })).body).toMatchObject({ ok: false, status: 400 });
    expect((await call("get_diagram", { id })).body.lastAuthor).toBe("human:ana");

    const c = await call("canvas_add_comment", { id, elementId: "Task_Unnamed", text: "Name it", kind: "ai-request", author: "ana" });
    expect(c.body).toMatchObject({ kind: "ai-request", author: "human:ana" });
    const closed = await call("canvas_set_comment_status", { id, commentId: c.body.id, status: "resolved", author: "ana" });
    expect(closed.body).toMatchObject({ status: "resolved", resolvedBy: "human:ana" });
  });

  it("create_diagram returns id, version and canvas URL; rejects XML with errors", async () => {
    const ok = await call("create_diagram", { name: "Empty" });
    expect(ok.body).toMatchObject({ ok: true, version: 1, canvasUrl: `http://canvas.test/canvas?id=${ok.body.id}` });

    const bad = await call("create_diagram", { name: "Bad", xml: fixture("invalid.bpmn") });
    expect(bad.isError).toBe(true);
    expect(bad.body.errors.map((e: any) => e.rule)).toContain("start-event-required");
  });

  it("update_diagram saves a revision, returns warnings, and rejects errors without saving", async () => {
    const warned = edit(fixture("valid.bpmn"), ['<bpmn:sequenceFlow id="Flow_No" name="No"', '<bpmn:sequenceFlow id="Flow_No"']);
    const ok = await call("update_diagram", { id, xml: warned, baseVersion: 1, note: "drop label" });
    expect(ok.body).toMatchObject({ ok: true, version: 2 });
    expect(ok.body.issues).toEqual([expect.objectContaining({ rule: "pm/gateway-flow-label", severity: "warning" })]);

    const bad = await call("update_diagram", { id, xml: fixture("invalid.bpmn"), baseVersion: 2 });
    expect(bad.isError).toBe(true);
    expect((await call("get_diagram", { id })).body.version).toBe(2);
  });

  it("detects a version conflict after a human edit, then lets the AI merge", async () => {
    const humanXml = edit(fixture("valid.bpmn"), ['name="Ship order"', 'name="Ship parcel"']);
    expect((await putHuman(id, humanXml, 1)).status).toBe(200);

    const stale = await call("update_diagram", { id, xml: fixture("valid.bpmn"), baseVersion: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.body).toMatchObject({ conflict: true });

    const cur = await call("get_diagram", { id });
    expect(cur.body).toMatchObject({ version: 2, lastAuthor: "human:ana" });
    const merged = await call("update_diagram", { id, xml: cur.body.xml, baseVersion: 2 });
    expect(merged.body).toMatchObject({ ok: true, version: 3 });
  });

  it("lays out XML without DI on create, and on update while no human has edited", async () => {
    const noDi = fixture("valid.bpmn").replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, "");
    const created = await call("create_diagram", { name: "No DI", xml: noDi });
    expect(created.body).toMatchObject({ ok: true, layout: { mode: "auto", notes: [] }, issues: [] });
    expect((await call("get_diagram", { id: created.body.id })).body.xml).toContain("<bpmndi:BPMNShape");

    const updated = await call("update_diagram", { id: created.body.id, xml: noDi, baseVersion: 1 });
    expect(updated.body).toMatchObject({ ok: true, version: 2, layout: { mode: "auto" } });
  });

  it("refuses XML without DI once a human has edited (would overwrite their positions)", async () => {
    await putHuman(id, fixture("valid.bpmn"), 1);
    const noDi = fixture("valid.bpmn").replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, "");
    const r = await call("update_diagram", { id, xml: noDi, baseVersion: 2 });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatch(/auto-layout would overwrite/);
  });

  it("get_changes_since shows the human edit with its author", async () => {
    const humanXml = edit(
      fixture("valid.bpmn"),
      ['name="Ship order"', 'name="Ship parcel"'],
      ['owner="Sales clerk"', 'owner="Back office"'],
      ['<dc:Bounds x="490" y="60"', '<dc:Bounds x="700" y="60"'],
    );
    await putHuman(id, humanXml, 1);
    const { body } = await call("get_changes_since", { id, sinceVersion: 1 });
    expect(body).toMatchObject({ from: 1, to: 2, revisions: [{ version: 2, author: "human:ana" }] });
    expect(body.modified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "Task_ShipOrder", fields: { name: { before: "Ship order", after: "Ship parcel" } } }),
        expect.objectContaining({ id: "Task_CheckOrder", fields: { "pm:owner": { before: "Sales clerk", after: "Back office" } } }),
      ]),
    );
    expect(body.moved).toEqual([expect.objectContaining({ id: "Annotation_Carrier" })]);
  });

  it("add_comment anchors on an existing element, rejects an unknown elementId, resolve_comment closes it", async () => {
    const unknown = await call("add_comment", { id, elementId: "Task_DoesNotExist", text: "?" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error).toMatch(/does not exist/);

    const { body: c } = await call("add_comment", { id, elementId: "Gateway_Approved", text: "Who approves?" });
    expect(c).toMatchObject({ elementId: "Gateway_Approved", author: "ai", status: "open" });
    expect((await call("get_diagram", { id })).body.openComments).toHaveLength(1);

    const { body: r } = await call("resolve_comment", { id, commentId: c.id });
    expect(r.status).toBe("resolved");
    expect((await call("list_comments", { id, onlyOpen: true })).body).toEqual([]);

    expect((await call("resolve_comment", { id, commentId: "nope" })).isError).toBe(true);
  });
});

describe("HTTP hardening", () => {
  it("rejects requests whose Host header is not allowed (DNS rebinding)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((ok, ko) => {
      const r = request(`${base}/api/diagrams/x`, { headers: { host: "evil.example" } }, (res) => ok(res.statusCode ?? 0));
      r.on("error", ko);
      r.end();
    });
    expect(status).toBe(403);
  });
});

describe("REST used by the canvas (human saves)", () => {
  let id: string;
  beforeEach(async () => {
    id = (await call("create_diagram", { name: "Order", xml: fixture("valid.bpmn") })).body.id;
  });

  it("refuses XML that does not parse, without creating a revision", async () => {
    const r = await putHuman(id, "<bpmn:definitions", 1);
    expect(r.status).toBe(400);
    expect((await r.json()).issues[0].rule).toBe("xml-parse");
    expect((await call("get_diagram", { id })).body.version).toBe(1);
  });

  it("accepts parsable XML with validation errors and returns the issues", async () => {
    const r = await putHuman(id, fixture("invalid.bpmn"), 1);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.version).toBe(2);
    expect(body.issues.some((i: any) => i.severity === "error")).toBe(true);
    expect((await call("get_diagram", { id })).body.lastAuthor).toBe("human:ana");
  });

  it("returns 409 on a stale human save and 404 on an unknown diagram", async () => {
    await putHuman(id, fixture("valid.bpmn"), 1);
    expect((await putHuman(id, fixture("valid.bpmn"), 1)).status).toBe(409);
    expect((await putHuman("nope", fixture("valid.bpmn"), 1)).status).toBe(404);
  });

  const post = (elementId: string, extra: Record<string, unknown> = {}) =>
    fetch(`${base}/api/diagrams/${id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ elementId, text: "hello", author: "ana", ...extra }),
    });

  it("gives human AI requests to the AI first, and records who resolved them", async () => {
    await post("Task_CheckOrder");
    const req = await (await post("Task_ShipOrder", { kind: "ai-request", text: "Translate the name to French" })).json();
    expect(req).toMatchObject({ kind: "ai-request", status: "open" });

    const { body } = await call("get_diagram", { id });
    expect(body.openComments.map((c: any) => c.kind)).toEqual(["ai-request", "note"]);

    const { body: resolved } = await call("resolve_comment", { id, commentId: req.id });
    expect(resolved).toMatchObject({ status: "resolved", resolvedBy: "ai" });
  });

  it("records the human who closes a comment from the canvas", async () => {
    const c = await (await post("Task_CheckOrder")).json();
    const r = await fetch(`${base}/api/diagrams/${id}/comments/${c.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", author: "ana" }),
    });
    expect(await r.json()).toMatchObject({ status: "resolved", resolvedBy: "human:ana" });
  });

  it("rejects a human comment on an unknown element", async () => {
    expect((await post("Nope")).status).toBe(400);
    const ok = await post("Task_CheckOrder");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ author: "human:ana", elementId: "Task_CheckOrder" });
  });
});
