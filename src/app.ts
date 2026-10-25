import express from "express";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Store, StoreError } from "./store.js";
import { validateXml } from "./validate.js";
import { diffXml } from "./diff.js";
import { parse } from "./model.js";

export interface AppOptions {
  store: Store;
  publicUrl: string;
  uiDir?: string;
}

const text = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});
const fail = (o: Record<string, unknown>) => ({ ...text({ ok: false, ...o }), isError: true });

/** Returns an error message if elementId is not an element of the diagram's current XML. */
async function checkAnchor(xml: string, elementId: string) {
  const { elementsById } = await parse(xml);
  return elementsById[elementId] ? undefined : `Element ${elementId} does not exist in the current diagram`;
}

function buildMcp({ store, publicUrl }: AppOptions) {
  const s = new McpServer({ name: "bpmn-collab-mcp", version: "0.1.0" });

  s.registerTool(
    "list_diagrams",
    { description: "List all diagrams with their current version." },
    async () => text(store.list()),
  );

  s.registerTool(
    "create_diagram",
    {
      description: "Create a diagram (optionally from BPMN 2.0 XML). Returns id, version and the canvas URL for the human.",
      inputSchema: { name: z.string(), xml: z.string().optional() },
    },
    async ({ name, xml }) => {
      const issues = xml ? await validateXml(xml) : [];
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) return fail({ errors });
      const d = store.create(name, xml);
      return text({ ok: true, id: d.id, version: 1, canvasUrl: `${publicUrl}/canvas?id=${d.id}`, issues });
    },
  );

  s.registerTool(
    "get_diagram",
    {
      description: "Get the CURRENT XML (including human edits) plus open comments. Always call this before modifying a diagram.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      const rev = store.latest(d);
      return text({
        id, name: d.name, version: rev.version, lastAuthor: rev.author, xml: rev.xml,
        openComments: d.comments.filter((c) => c.status === "open"),
      });
    },
  );

  s.registerTool(
    "get_changes_since",
    {
      description: "Semantic diff (added/removed/modified elements by id) between a past version and the current one. Use it to see what the human changed.",
      inputSchema: { id: z.string(), sinceVersion: z.number().int() },
    },
    async ({ id, sinceVersion }) => {
      const d = store.get(id);
      const old = d?.revisions.find((r) => r.version === sinceVersion);
      if (!d || !old) return fail({ error: "diagram or version not found" });
      const cur = store.latest(d);
      const authors = d.revisions.filter((r) => r.version > sinceVersion).map((r) => ({ version: r.version, author: r.author, note: r.note }));
      return text({ from: sinceVersion, to: cur.version, revisions: authors, ...(await diffXml(old.xml, cur.xml)) });
    },
  );

  s.registerTool(
    "update_diagram",
    {
      description: "Save a new full XML revision. Must pass baseVersion (the version you read). Validation errors reject the save; warnings (including layout warnings) are returned and should be fixed.",
      inputSchema: { id: z.string(), xml: z.string(), baseVersion: z.number().int(), note: z.string().optional() },
    },
    async ({ id, xml, baseVersion, note }) => {
      const issues = await validateXml(xml);
      if (issues.some((i) => i.severity === "error")) return fail({ error: "validation failed", issues });
      try {
        const rev = store.update(id, xml, baseVersion, "ai", note);
        return text({ ok: true, version: rev.version, issues });
      } catch (e) {
        if (e instanceof StoreError && e.code === 409)
          return fail({ error: e.message, conflict: true, hint: "Re-read with get_diagram, check get_changes_since, merge, retry." });
        if (e instanceof StoreError) return fail({ error: e.message });
        throw e;
      }
    },
  );

  s.registerTool(
    "validate_diagram",
    { description: "Run deterministic validation on the current revision.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      return text(await validateXml(store.latest(d).xml));
    },
  );

  s.registerTool(
    "list_comments",
    {
      description: "List comments anchored on BPMN element ids (optionally only open ones).",
      inputSchema: { id: z.string(), onlyOpen: z.boolean().optional() },
    },
    async ({ id, onlyOpen }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      return text(onlyOpen ? d.comments.filter((c) => c.status === "open") : d.comments);
    },
  );

  s.registerTool(
    "add_comment",
    {
      description: "Add a comment (e.g. a review remark) on a specific element id, or reply with parentId.",
      inputSchema: { id: z.string(), elementId: z.string(), text: z.string(), parentId: z.string().optional() },
    },
    async ({ id, elementId, text: t, parentId }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      const bad = await checkAnchor(store.latest(d).xml, elementId);
      if (bad) return fail({ error: bad });
      return text(store.addComment(id, { elementId, text: t, parentId, author: "ai" }));
    },
  );

  s.registerTool(
    "resolve_comment",
    {
      description: "Mark a comment resolved (after applying the change it asked for).",
      inputSchema: { id: z.string(), commentId: z.string() },
    },
    async ({ id, commentId }) => {
      try {
        return text(store.setCommentStatus(id, commentId, "resolved"));
      } catch (e) {
        if (e instanceof StoreError) return fail({ error: e.message });
        throw e;
      }
    },
  );

  s.registerTool(
    "export_diagram",
    { description: "Return the current XML for download or import into Signavio/ARIS.", inputSchema: { id: z.string() } },
    async ({ id }) => {
      const d = store.get(id);
      return d ? text(store.latest(d).xml) : fail({ error: "not found" });
    },
  );

  // TODO(MCP Apps): register a ui:// resource serving dist/ui/index.html and link it
  // from create_diagram/get_diagram via _meta.ui.resourceUri to render the canvas inline in Claude.
  return s;
}

export function createApp(opts: AppOptions) {
  const { store } = opts;
  const app = express();
  app.use(express.json({ limit: "16mb" }));

  // ---- MCP endpoint (stateless streamable HTTP) ----
  app.post("/mcp", async (req, res) => {
    const server = buildMcp(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const noMethod = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ error: "Method not allowed" });
  };
  app.get("/mcp", noMethod);
  app.delete("/mcp", noMethod);

  // ---- REST used by the human canvas ----
  app.get("/api/diagrams/:id", async (req, res) => {
    const d = store.get(req.params.id);
    if (!d) return void res.status(404).json({ error: "not found" });
    const rev = store.latest(d);
    res.json({ id: d.id, name: d.name, version: rev.version, xml: rev.xml, comments: d.comments, issues: await validateXml(rev.xml) });
  });

  // Human saves are always stored (never lose human work) unless the XML does not parse at all.
  // Validation issues are returned so the canvas can display them.
  app.put("/api/diagrams/:id", async (req, res) => {
    const { xml, baseVersion, author } = req.body ?? {};
    if (typeof xml !== "string" || typeof baseVersion !== "number")
      return void res.status(400).json({ error: "xml (string) and baseVersion (number) are required" });
    const issues = await validateXml(xml);
    if (issues.some((i) => i.rule === "xml-parse"))
      return void res.status(400).json({ error: "XML does not parse", issues });
    try {
      const rev = store.update(req.params.id, xml, baseVersion, `human:${author ?? "anonymous"}`);
      res.json({ version: rev.version, issues });
    } catch (e) {
      if (e instanceof StoreError) return void res.status(e.code).json({ error: e.message });
      throw e;
    }
  });

  app.post("/api/diagrams/:id/comments", async (req, res) => {
    const { elementId, text: t, author, parentId } = req.body ?? {};
    const d = store.get(req.params.id);
    if (!d) return void res.status(404).json({ error: "not found" });
    if (typeof elementId !== "string" || typeof t !== "string" || !t.trim())
      return void res.status(400).json({ error: "elementId and text are required" });
    const bad = await checkAnchor(store.latest(d).xml, elementId);
    if (bad) return void res.status(400).json({ error: bad });
    res.json(store.addComment(d.id, { elementId, text: t, parentId, author: `human:${author ?? "anonymous"}` }));
  });

  app.patch("/api/diagrams/:id/comments/:cid", (req, res) => {
    try {
      res.json(store.setCommentStatus(req.params.id, req.params.cid, req.body?.status === "open" ? "open" : "resolved"));
    } catch (e) {
      if (e instanceof StoreError) return void res.status(e.code).json({ error: e.message });
      throw e;
    }
  });

  // ---- Canvas (built bpmn-js app, single self-contained HTML file) ----
  const uiDir = opts.uiDir ?? path.resolve("dist/ui");
  app.get("/canvas", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
  app.use(express.static(uiDir, { index: false })); // non-inlined assets (bpmn-font svg fallback)
  app.get("/", (_req, res) => {
    res.send("bpmn-collab-mcp is running. MCP endpoint: /mcp");
  });

  return app;
}
