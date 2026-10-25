import express from "express";
import path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { hostHeaderValidation } from "@modelcontextprotocol/express";
import { Store } from "./store.js";
import { buildMcp } from "./mcp.js";
import { commentFromHuman, loadForHuman, saveFromHuman, setStatusFromHuman, type Outcome } from "./human.js";
import { mountOAuth, type OAuthConfig } from "./auth.js";
import { ExportSigner, exportFileName } from "./export.js";
import { dismissIssue, restoreIssue } from "./triage.js";

export interface AppOptions {
  store: Store;
  publicUrl: string;
  uiDir?: string;
  /** Extra Host header values to accept besides localhost and the PUBLIC_URL host. */
  allowedHosts?: string[];
  /** When set, /mcp requires an OAuth access token from this issuer for an allowlisted user. */
  oauth?: OAuthConfig;
  /** HMAC secret for signed download URLs (>= 32 chars); without it a random per-process key is used. */
  exportSecret?: string;
}

export function createApp(opts: AppOptions) {
  const { store } = opts;
  const uiDir = opts.uiDir ?? path.resolve("dist/ui");
  const app = express();

  // DNS rebinding protection: only answer for known Host names (no auth yet).
  app.use(hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", new URL(opts.publicUrl).hostname, ...(opts.allowedHosts ?? [])]));
  app.use(express.json({ limit: "16mb" }));

  // ---- MCP endpoint: one server per request (stateless), 2026 protocol + legacy fallback ----
  const signer = new ExportSigner(opts.exportSecret);
  const mcp = toNodeHandler(createMcpHandler(() => buildMcp({ store, publicUrl: opts.publicUrl, uiDir, signer })));
  const guard = opts.oauth ? mountOAuth(app, opts.oauth) : [];
  app.all("/mcp", ...guard, (req, res) => mcp(req, res, req.body));

  // ---- .bpmn export: the XML of a stored revision, as a file ----
  const sendBpmn = (res: express.Response, name: string, version: number, xml: string) => {
    const file = exportFileName(name, version);
    res.set({
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(xml);
  };
  // Latest revision, behind the same protection as the rest of /api (basic auth in Caddy).
  app.get("/api/diagrams/:id/export.bpmn", (req, res) => {
    const d = store.get(req.params.id);
    if (!d) return void res.status(404).json({ error: "not found" });
    const rev = store.latest(d);
    sendBpmn(res, d.name, rev.version, rev.xml);
  });
  // Signed link (export_diagram, canvas fallback): no basic auth, one revision, expires in minutes.
  app.get("/dl/:token", (req, res) => {
    const grant = signer.verify(req.params.token);
    if ("error" in grant) return void res.status(grant.error === "expired" ? 410 : 403).json({ error: grant.error === "expired" ? "link expired" : "invalid link" });
    const d = store.get(grant.id);
    const rev = d?.revisions.find((r) => r.version === grant.version);
    if (!d || !rev) return void res.status(404).json({ error: "not found" });
    sendBpmn(res, d.name, rev.version, rev.xml);
  });

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
  app.post("/api/diagrams/:id/issues/:fp/dismiss", async (req, res) =>
    send(res, await dismissIssue(store, req.params.id, req.params.fp, req.body?.reason, `human:${req.body?.author ?? "anonymous"}`)),
  );
  app.post("/api/diagrams/:id/issues/:fp/restore", async (req, res) => send(res, await restoreIssue(store, req.params.id, req.params.fp)));

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
