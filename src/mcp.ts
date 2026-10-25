import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Store, StoreError, openComments } from "./store.js";
import { validateXml } from "./validate.js";
import { diffXml } from "./diff.js";
import { checkAnchor, commentFromHuman, loadForHuman, saveFromHuman, setStatusFromHuman, type Outcome } from "./human.js";

export interface McpOptions {
  store: Store;
  publicUrl: string;
  uiDir: string;
}

/** The bpmn-js canvas, rendered inline by hosts that support MCP Apps. */
export const CANVAS_URI = "ui://bpmn-collab/canvas.html";

const text = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});
const fail = (o: Record<string, unknown>) => ({ ...text({ ok: false, ...o }), isError: true });
const outcome = (o: Outcome) => (o.status === 200 ? text(o.body) : fail({ status: o.status, ...o.body }));

/** Shown inline by MCP Apps hosts; other clients just get the text result. */
const showCanvas = { ui: { resourceUri: CANVAS_URI } };
/** Callable by the inline canvas only, hidden from the model. */
const appOnly = { ui: { resourceUri: CANVAS_URI, visibility: ["app" as const] } };

export function buildMcp({ store, publicUrl, uiDir }: McpOptions) {
  const s = new McpServer({ name: "bpmn-collab-mcp", version: "0.1.0" });

  s.registerTool(
    "list_diagrams",
    { description: "List all diagrams with their current version.", inputSchema: z.object({}) },
    async () => text(store.list()),
  );

  registerAppTool(
    s,
    "create_diagram",
    {
      description:
        "Create a diagram (optionally from BPMN 2.0 XML). Returns id, version and the canvas URL for the human. " +
        "Hosts that support MCP Apps also show the canvas inline.",
      inputSchema: z.object({ name: z.string(), xml: z.string().optional() }),
      _meta: showCanvas,
    },
    async ({ name, xml }) => {
      const issues = xml ? await validateXml(xml) : [];
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) return fail({ errors });
      const d = store.create(name, xml);
      return text({ ok: true, id: d.id, version: 1, canvasUrl: `${publicUrl}/canvas?id=${d.id}`, issues });
    },
  );

  registerAppTool(
    s,
    "get_diagram",
    {
      description:
        "Get the CURRENT XML (including human edits) plus open comments. Always call this before modifying a diagram. " +
        'Open comments of kind "ai-request" come first: they are instructions from the human; apply them, then resolve_comment.',
      inputSchema: z.object({ id: z.string() }),
      _meta: showCanvas,
    },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      const rev = store.latest(d);
      return text({
        id, name: d.name, version: rev.version, lastAuthor: rev.author, xml: rev.xml,
        canvasUrl: `${publicUrl}/canvas?id=${d.id}`,
        openComments: openComments(d.comments),
      });
    },
  );

  s.registerTool(
    "get_changes_since",
    {
      description: "Semantic diff (added/removed/modified elements by id) between a past version and the current one. Use it to see what the human changed.",
      inputSchema: z.object({ id: z.string(), sinceVersion: z.number().int() }),
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
      inputSchema: z.object({ id: z.string(), xml: z.string(), baseVersion: z.number().int(), note: z.string().optional() }),
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
    { description: "Run deterministic validation on the current revision.", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      return text(await validateXml(store.latest(d).xml));
    },
  );

  s.registerTool(
    "list_comments",
    {
      description: 'List comments anchored on BPMN element ids (optionally only open ones; open "ai-request" comments first).',
      inputSchema: z.object({ id: z.string(), onlyOpen: z.boolean().optional() }),
    },
    async ({ id, onlyOpen }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      return text(onlyOpen ? openComments(d.comments) : d.comments);
    },
  );

  s.registerTool(
    "add_comment",
    {
      description: "Add a comment (e.g. a review remark) on a specific element id, or reply with parentId.",
      inputSchema: z.object({ id: z.string(), elementId: z.string(), text: z.string(), parentId: z.string().optional() }),
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
      description: "Mark a comment resolved after applying the change it asked for (always do this for ai-request comments you applied).",
      inputSchema: z.object({ id: z.string(), commentId: z.string() }),
    },
    async ({ id, commentId }) => {
      try {
        return text(store.setCommentStatus(id, commentId, "resolved", "ai"));
      } catch (e) {
        if (e instanceof StoreError) return fail({ error: e.message });
        throw e;
      }
    },
  );

  s.registerTool(
    "export_diagram",
    { description: "Return the current XML for download or import into Signavio/ARIS.", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => {
      const d = store.get(id);
      return d ? text(store.latest(d).xml) : fail({ error: "not found" });
    },
  );

  // ---- Inline canvas (MCP Apps): the iframe cannot reach /api, so it uses these app-only tools ----
  registerAppResource(s, "BPMN canvas", CANVAS_URI, { description: "bpmn-js canvas for the human", mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: CANVAS_URI, mimeType: RESOURCE_MIME_TYPE, text: fs.readFileSync(path.join(uiDir, "index.html"), "utf8") }],
  }));

  registerAppTool(
    s,
    "canvas_load",
    { description: "Canvas: load diagram, comments and issues.", inputSchema: z.object({ id: z.string() }), _meta: appOnly },
    async ({ id }) => outcome(await loadForHuman(store, id)),
  );

  registerAppTool(
    s,
    "canvas_save",
    {
      description: "Canvas: save a human edit.",
      inputSchema: z.object({ id: z.string(), xml: z.string(), baseVersion: z.number().int(), author: z.string().optional() }),
      _meta: appOnly,
    },
    async ({ id, xml, baseVersion, author }) => outcome(await saveFromHuman(store, id, xml, baseVersion, author)),
  );

  registerAppTool(
    s,
    "canvas_add_comment",
    {
      description: "Canvas: add a human comment or AI request.",
      inputSchema: z.object({
        id: z.string(), elementId: z.string(), text: z.string(),
        kind: z.enum(["note", "ai-request"]).optional(), author: z.string().optional(),
      }),
      _meta: appOnly,
    },
    async ({ id, ...c }) => outcome(await commentFromHuman(store, id, c)),
  );

  registerAppTool(
    s,
    "canvas_set_comment_status",
    {
      description: "Canvas: close or reopen a comment.",
      inputSchema: z.object({ id: z.string(), commentId: z.string(), status: z.enum(["open", "resolved"]), author: z.string().optional() }),
      _meta: appOnly,
    },
    async ({ id, commentId, status, author }) => outcome(setStatusFromHuman(store, id, commentId, status, author)),
  );

  return s;
}
