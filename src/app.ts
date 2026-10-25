import express from "express";
import path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { hostHeaderValidation } from "@modelcontextprotocol/express";
import { Store } from "./store.js";
import { buildMcp } from "./mcp.js";
import { commentFromHuman, loadForHuman, saveFromHuman, setStatusFromHuman, type Outcome } from "./human.js";

export interface AppOptions {
  store: Store;
  publicUrl: string;
  uiDir?: string;
  /** Extra Host header values to accept besides localhost and the PUBLIC_URL host. */
  allowedHosts?: string[];
}

export function createApp(opts: AppOptions) {
  const { store } = opts;
  const uiDir = opts.uiDir ?? path.resolve("dist/ui");
  const app = express();

  // DNS rebinding protection: only answer for known Host names (no auth yet).
  app.use(hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", new URL(opts.publicUrl).hostname, ...(opts.allowedHosts ?? [])]));
  app.use(express.json({ limit: "16mb" }));

  // ---- MCP endpoint: one server per request (stateless), 2026 protocol + legacy fallback ----
  const mcp = toNodeHandler(createMcpHandler(() => buildMcp({ store, publicUrl: opts.publicUrl, uiDir })));
  app.all("/mcp", (req, res) => mcp(req, res, req.body));

  // ---- REST used by the standalone canvas ----
  const send = (res: express.Response, o: Outcome) => void res.status(o.status).json(o.body);
  app.get("/api/diagrams/:id", async (req, res) => send(res, await loadForHuman(store, req.params.id)));
  app.put("/api/diagrams/:id", async (req, res) => {
    const { xml, baseVersion, author } = req.body ?? {};
    send(res, await saveFromHuman(store, req.params.id, xml, baseVersion, author));
  });
  app.post("/api/diagrams/:id/comments", async (req, res) => {
    const { author, ...c } = req.body ?? {};
    send(res, await commentFromHuman(store, req.params.id, { ...c, author }));
  });
  app.patch("/api/diagrams/:id/comments/:cid", (req, res) =>
    send(res, setStatusFromHuman(store, req.params.id, req.params.cid, req.body?.status, req.body?.author)),
  );

  // ---- Canvas (built bpmn-js app, single self-contained HTML file) ----
  app.get("/canvas", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
  app.use(express.static(uiDir, { index: false })); // non-inlined assets (bpmn-font svg fallback)
  app.get("/", (_req, res) => {
    res.send("bpmn-collab-mcp is running. MCP endpoint: /mcp");
  });

  return app;
}
