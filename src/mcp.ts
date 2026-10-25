import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Store, StoreError, openComments } from "./store.js";
import { validateXml } from "./validate.js";
import { diffXml } from "./diff.js";
import { checkAnchor, commentFromHuman, loadForHuman, renameDiagram, saveFromHuman, setStatusFromHuman, type Outcome } from "./human.js";
import { autoLayout, hasDi } from "./autolayout.js";
import { exportFileName, type ExportSigner } from "./export.js";
import { instructions } from "./instructions.js";
import { guardAiSave, openIssues, summarize, triage } from "./issues.js";
import { currentIssues, dismissIssue, listIssues, restoreIssue } from "./triage.js";
import { normalizeDrilldown, parse } from "./model.js";

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

/** AI XML: sub-process planes drawn far from the origin are moved there (they would open empty). */
async function withPlanes<T extends { xml: string }>(prepared: T) {
  const { xml, moved } = await normalizeDrilldown(prepared.xml);
  return { ...prepared, xml, ...(moved.length ? { planesMovedToOrigin: moved } : {}) };
}

/** Signed, read-only download link for one revision (no basic auth needed, expires in minutes). */
export function downloadLink(signer: ExportSigner, publicUrl: string, id: string, version: number) {
  const { token, expiresAt } = signer.sign(id, version);
  return { downloadUrl: `${publicUrl}/dl/${token}`, expiresAt };
}

export function buildMcp({ store, publicUrl, uiDir, signer }: McpOptions) {
  // The modeling guide (skill/SKILL.md) travels with the server: no skill needs to be installed in Claude.
  const s = new McpServer({ name: "bpmn-collab-mcp", version: "0.1.0" }, { instructions });

  s.registerTool(
    "list_diagrams",
    {
      description:
        "List all diagrams, most recently modified first: id, name, version, updatedAt, lastAuthor, openComments and canvasUrl " +
        "(the web canvas, outside the chat). Show them to the user as a list of clickable Markdown links named after the diagram.",
      inputSchema: z.object({}),
    },
    async () => text(store.list().map((d) => ({ ...d, canvasUrl: `${publicUrl}/canvas?id=${d.id}` }))),
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
      const prepared = submitted ? await withPlanes(await withLayout(submitted, false)) : undefined;
      const xml = prepared?.xml;
      const issues = xml ? await validateXml(xml) : [];
      const errors = issues.filter((i) => i.severity === "error");
      if (errors.length) return fail({ errors, layout: prepared?.layout });
      const d = store.create(name, xml);
      return text({
        ok: true, id: d.id, version: 1, canvasUrl: `${publicUrl}/canvas?id=${d.id}`, layout: prepared?.layout,
        ...(prepared?.planesMovedToOrigin ? { planesMovedToOrigin: prepared.planesMovedToOrigin } : {}), issues,
      });
    },
  );

  registerAppTool(
    s,
    "get_diagram",
    {
      description:
        "Get the CURRENT XML (including human edits) plus open comments and open lint issues (with fingerprints). Always call " +
        'this before modifying a diagram. Open comments of kind "ai-request" come first: they are instructions from the human; ' +
        "apply them, then resolve_comment. Triage issues as described in list_issues.",
      inputSchema: z.object({ id: z.string() }),
      _meta: showCanvas,
    },
    async ({ id }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      const rev = store.latest(d);
      const issues = await currentIssues(store, d);
      return text({
        id, name: d.name, version: rev.version, lastAuthor: rev.author, xml: rev.xml,
        canvasUrl: `${publicUrl}/canvas?id=${d.id}`,
        openComments: openComments(d.comments),
        issueSummary: summarize(issues),
        openIssues: openIssues(issues),
      });
    },
  );

  s.registerTool(
    "rename_diagram",
    {
      description: "Give a diagram a new name (1-120 characters). The id, revisions and comments are unchanged; export file names follow the new name.",
      inputSchema: z.object({ id: z.string(), name: z.string() }),
    },
    async ({ id, name }) => outcome(renameDiagram(store, id, name)),
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
        "open warnings are returned with fingerprints. If loop_guard is true, STOP: do not save again for these issues, " +
        "summarize and ask the human. Keep the DI from get_diagram (XML without any DI is laid out automatically only while " +
        "no human has edited the diagram, otherwise it is refused) and do not touch elements a human added (humanElementsTouched).",
      inputSchema: z.object({ id: z.string(), xml: z.string(), baseVersion: z.number().int(), note: z.string().optional() }),
    },
    async ({ id, xml: submitted, baseVersion, note }) => {
      const d = store.get(id);
      if (!d) return fail({ error: "not found" });
      // A human revision counts once it is an edit: version 1 created from the web is the empty template.
      const humanEdited = d.revisions.some((r) => r.author.startsWith("human:") && r.version > 1);
      const laidOut = await withLayout(submitted, humanEdited);
      if (laidOut.refused) return fail({ error: laidOut.refused });
      const { xml, layout, planesMovedToOrigin } = await withPlanes(laidOut);
      const issues = triage(await validateXml(xml), d.dismissed);
      if (issues.some((i) => i.severity === "error")) return fail({ error: "validation failed", layout, issues: openIssues(issues) });
      const before = store.latest(d).xml;
      try {
        const rev = store.update(id, xml, baseVersion, "ai", note);
        // Elements a human added that this save modified, moved or removed.
        const changes = await diffXml(before, xml);
        const touched = [...changes.modified, ...changes.moved, ...changes.removed].map((e) => e.id).filter((x) => d.humanAdded?.includes(x));
        // Loop guard: warnings waiting for a human answer (open AI comment on the element) do not count.
        const waiting = new Set(d.comments.filter((c) => c.status === "open" && c.author === "ai").map((c) => c.elementId));
        const relevant = openIssues(issues).filter((i) => i.severity === "warning" && !(i.elementId && waiting.has(i.elementId)));
        const { verdict, state } = guardAiSave(d.guard, relevant);
        store.setGuard(id, state);
        return text({
          ok: true, version: rev.version, layout, ...(planesMovedToOrigin ? { planesMovedToOrigin } : {}),
          issueSummary: summarize(issues), openIssues: openIssues(issues),
          ...verdict,
          ...(touched.length
            ? { humanElementsTouched: [...new Set(touched)], humanElementsWarning: "These elements were added by a human: leave them unchanged unless an issue or comment is about them." }
            : {}),
        });
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
    {
      description: "Run deterministic validation on the current revision. Issues carry a fingerprint and a status (open / dismissed).",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => outcome(await listIssues(store, id)),
  );

  s.registerTool(
    "list_issues",
    {
      description:
        "List the lint issues of the latest revision: fingerprint, rule, severity, elementId, message, status (open / dismissed). " +
        "Triage each open issue: (a) real problem with a safe, unambiguous fix -> fix it; (b) false positive or rule not relevant " +
        "here -> dismiss_issue with a short reason; (c) depends on business information -> add_comment on the element with a " +
        "precise question, do not guess.",
      inputSchema: z.object({ id: z.string(), includeDismissed: z.boolean().optional() }),
    },
    async ({ id, includeDismissed }) => outcome(await listIssues(store, id, includeDismissed ?? true)),
  );

  s.registerTool(
    "dismiss_issue",
    {
      description:
        "Set aside a warning or info issue (false positive, rule not relevant here) with a short reason: it is no longer reported " +
        "as active, and stays visible (greyed) to the human, who can restore it. Errors cannot be dismissed.",
      inputSchema: z.object({ id: z.string(), fingerprint: z.string(), reason: z.string() }),
    },
    async ({ id, fingerprint, reason }) => outcome(await dismissIssue(store, id, fingerprint, reason, "ai")),
  );

  s.registerTool(
    "restore_issue",
    { description: "Make a dismissed issue active again.", inputSchema: z.object({ id: z.string(), fingerprint: z.string() }) },
    async ({ id, fingerprint }) => outcome(await restoreIssue(store, id, fingerprint)),
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
      const { xml } = await normalizeDrilldown(rev.xml);
      return text({ ok: true, id, name: d.name, version: rev.version, fileName, ...downloadLink(signer, publicUrl, id, rev.version), xml });
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
        id: z.string(), elementId: z.string(), text: z.string(), parentId: z.string().optional(),
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
    "canvas_rename",
    { description: "Canvas: the human renames the diagram.", inputSchema: z.object({ id: z.string(), name: z.string() }), _meta: appOnly },
    async ({ id, name }) => outcome(renameDiagram(store, id, name)),
  );

  registerAppTool(
    s,
    "canvas_dismiss_issue",
    {
      description: "Canvas: the human sets an issue aside.",
      inputSchema: z.object({ id: z.string(), fingerprint: z.string(), reason: z.string(), author: z.string().optional() }),
      _meta: appOnly,
    },
    async ({ id, fingerprint, reason, author }) => outcome(await dismissIssue(store, id, fingerprint, reason, `human:${author ?? "anonymous"}`)),
  );

  registerAppTool(
    s,
    "canvas_restore_issue",
    { description: "Canvas: the human restores a dismissed issue.", inputSchema: z.object({ id: z.string(), fingerprint: z.string() }), _meta: appOnly },
    async ({ id, fingerprint }) => outcome(await restoreIssue(store, id, fingerprint)),
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
