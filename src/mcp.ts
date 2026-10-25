import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Store, StoreError, openComments } from "./store.js";
import { validateXml } from "./validate.js";
import { diffXml } from "./diff.js";
import { checkAnchor, commentFromHuman, loadForHuman, saveFromHuman, setStatusFromHuman, type Outcome } from "./human.js";
import { autoLayout, hasDi } from "./autolayout.js";
import { exportFileName, type ExportSigner } from "./export.js";
import { parse } from "./model.js";

export interface McpOptions {
  store: Store;
  publicUrl: string;
  uiDir: string;
  signer: ExportSigner;
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

/**
 * AI-submitted XML without any DI gets an automatic layout, unless that would overwrite
 * positions chosen by a human (any human revision exists): then the save is refused.
 */
async function withLayout(xml: string, humanEdited: boolean) {
  let definitions;
  try {
    ({ definitions } = await parse(xml));
  } catch {
    return { xml }; // validation reports the parse error
  }
  if (hasDi(definitions)) return { xml };
  if (humanEdited)
    return {
      xml,
      refused:
        "The XML has no DI. A human has edited this diagram, so auto-layout would overwrite their positions: start from get_diagram and keep its DI, adding DI for new elements.",
    };
  const r = await autoLayout(xml);
  return { xml: r.xml, layout: { mode: "auto" as const, notes: r.notes } };
}

/** Signed, read-only download link for one revision (no basic auth needed, expires in minutes). */
export function downloadLink(signer: ExportSigner, publicUrl: string, id: string, version: number) {
  const { token, expiresAt } = signer.sign(id, version);
  return { downloadUrl: `${publicUrl}/dl/${token}`, expiresAt };
}

export function buildMcp({ store, publicUrl, uiDir, signer }: McpOptions) {
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
        "XML without any DI (no bpmndi:BPMNDiagram content) is laid out automatically (bpmn-auto-layout + label/artifact placement); " +
        "check the returned layout notes and issues. Hosts that support MCP Apps also show the canvas inline.",
      inputSchema: z.object({ name: z.string(), xml: z.string().optional() }),
      _meta: showCanvas,
    },
    async ({ name, xml: submitted }) => {
      const prepared = submitted ? await withLayout(submitted, false) : undefined;
      const xml = prepared?.xml;
      const issues = xml ? await validateXml(xml) : [];
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) return fail({ errors, layout: prepared?.layout });
      const d = store.create(name, xml);
      return text({ ok: true, id: d.id, version: 1, canvasUrl: `${publicUrl}/canvas?id=${d.id}`, layout: prepared?.layout, issues });
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
      description:
        "Save a new full XML revision. Must pass baseVersion (the version you read). Validation errors reject the save; " +
        "warnings (including layout warnings) are returned and should be fixed. Keep the DI from get_diagram: XML without any DI " +
        "is laid out automatically only while no human has edited the diagram, otherwise it is refused.",
      inputSchema: z.object({ id: z.string(), xml: z.string(), baseVersion: z.number().int(), note: z.string().optional() }),
    },
    async ({ id, xml: submitted, baseVersion, note }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      const prepared = await withLayout(submitted, d.revisions.some((r) => r.author.startsWith("human:")));
      if (prepared.refused) return fail({ error: prepared.refused });
      const { xml, layout } = prepared;
      const issues = await validateXml(xml);
      if (issues.some((i) => i.severity === "error")) return fail({ error: "validation failed", layout, issues });
      try {
        const rev = store.update(id, xml, baseVersion, "ai", note);
        return text({ ok: true, version: rev.version, layout, issues });
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
    {
      description:
        "Export the latest revision as a .bpmn file (standard BPMN 2.0, importable in Signavio, ARIS, Camunda). Returns the XML " +
        "and a signed downloadUrl valid about 10 minutes for this revision only: give the user that link as a clickable " +
        "Markdown link (it works on a phone without the canvas login). Do not assume the chat can display a file.",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      const rev = store.latest(d);
      const fileName = exportFileName(d.name, rev.version);
      return text({ ok: true, id, name: d.name, version: rev.version, fileName, ...downloadLink(signer, publicUrl, id, rev.version), xml: rev.xml });
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

  registerAppTool(
    s,
    "canvas_export_link",
    { description: "Canvas: signed download link for the latest revision.", inputSchema: z.object({ id: z.string() }), _meta: appOnly },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ status: 404, error: "not found" });
      const rev = store.latest(d);
      return text({ fileName: exportFileName(d.name, rev.version), version: rev.version, ...downloadLink(signer, publicUrl, id, rev.version) });
    },
  );

  return s;
}
