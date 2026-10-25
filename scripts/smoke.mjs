// Smoke test against a running server: MCP JSON-RPC over HTTP + the canvas REST API.
import fs from "node:fs";
// Usage: npm run smoke [-- <baseUrl> <fixture.bpmn>]  (server must be running)
const BASE = process.argv[2] ?? "http://localhost:7860";
const fixture = fs.readFileSync(process.argv[3] ?? new URL("../test/fixtures/valid.bpmn", import.meta.url), "utf8");
let rpcId = 0;
async function tool(name, args) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const line = (await r.text()).split("\n").find((l) => l.startsWith("data: "));
  const res = JSON.parse(line.slice(6)).result;
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
}
const step = (n, msg, v) => console.log(`${n}. ${msg}`, v === undefined ? "" : JSON.stringify(v));

const c = await tool("create_diagram", { name: "Smoke - Handle order", xml: fixture });
step(1, "create_diagram ->", { ok: c.body.ok, id: c.body.id, version: c.body.version, canvasUrl: c.body.canvasUrl });
const id = c.body.id;

const page = await fetch(`${BASE}/canvas?id=${id}`);
const html = await page.text();
step(2, "GET /canvas ->", { status: page.status, bytes: html.length, hasModeler: html.includes("bpmn-js") || html.includes("djs-container") });
const svg = html.match(/url\((?:\.\/)?(bpmn-[\w-]+\.svg)/)?.[1];
if (svg) step("2b", "font asset ->", { svg, status: (await fetch(`${BASE}/${svg}`)).status });

const api = await (await fetch(`${BASE}/api/diagrams/${id}`)).json();
step(3, "GET /api/diagrams/:id (what the canvas loads) ->", { version: api.version, issues: api.issues.length });

// Same request the canvas sends after a human edit (debounced commandStack.changed)
const humanXml = api.xml
  .replace('name="Ship order"', 'name="Ship parcel"')
  .replace('owner="Sales clerk"', 'owner="Back office"')
  .replace('<dc:Bounds x="490" y="60"', '<dc:Bounds x="700" y="60"');
const put = await fetch(`${BASE}/api/diagrams/${id}`, {
  method: "PUT", headers: { "content-type": "application/json" },
  body: JSON.stringify({ xml: humanXml, baseVersion: api.version, author: "smoke" }),
});
step(4, "PUT (human edit) ->", { status: put.status, ...(await put.json()) });

const ch = await tool("get_changes_since", { id, sinceVersion: 1 });
step(5, "get_changes_since(1) ->", ch.body);

const stale = await tool("update_diagram", { id, xml: fixture, baseVersion: 1 });
step(6, "update_diagram with stale baseVersion ->", { isError: stale.isError, error: stale.body.error });

const cm = await tool("add_comment", { id, elementId: "Gateway_Approved", text: "Smoke test: who approves the order?" });
step(7, "add_comment on Gateway_Approved ->", { id: cm.body.id, status: cm.body.status });
console.log(`\nCanvas: ${BASE}/canvas?id=${id}`);
