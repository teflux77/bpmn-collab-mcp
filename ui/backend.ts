/**
 * The canvas talks to the server through one of two backends:
 * - REST when opened as a standalone page (/canvas?id=...);
 * - app-only MCP tools when rendered inline by an MCP Apps host (Claude), where the
 *   sandboxed iframe cannot reach /api.
 */
import { App } from "@modelcontextprotocol/ext-apps";

/** HTTP-like result: status 200 means ok, body is the JSON payload. */
export interface Result {
  status: number;
  body: any;
}

export interface Backend {
  /** True when an MCP Apps host can receive a chat message from the canvas. */
  readonly canMessageHost: boolean;
  load(id: string): Promise<Result>;
  save(id: string, xml: string, baseVersion: number, author: string): Promise<Result>;
  addComment(id: string, c: { elementId: string; text: string; kind: string; author: string }): Promise<Result>;
  setCommentStatus(id: string, commentId: string, status: "open" | "resolved", author: string): Promise<Result>;
  askHost?(text: string): Promise<void>;
  /** Saves a file on the user's device; false when the environment refused it. */
  download(fileName: string, mimeType: string, content: string): Promise<boolean>;
  /** Inline only: asks the host to open a signed download link for the latest revision. */
  openExportLink?(id: string): Promise<boolean>;
}

/** Standalone page: a regular browser download (works on desktop and mobile browsers). */
function browserDownload(fileName: string, mimeType: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

const json = { "content-type": "application/json" };
const rest = async (r: Response): Promise<Result> => ({ status: r.status, body: await r.json() });

export const restBackend: Backend = {
  canMessageHost: false,
  download: async (fileName, mimeType, content) => browserDownload(fileName, mimeType, content),
  load: async (id) => rest(await fetch(`/api/diagrams/${id}`)),
  save: async (id, xml, baseVersion, author) =>
    rest(await fetch(`/api/diagrams/${id}`, { method: "PUT", headers: json, body: JSON.stringify({ xml, baseVersion, author }) })),
  addComment: async (id, c) =>
    rest(await fetch(`/api/diagrams/${id}/comments`, { method: "POST", headers: json, body: JSON.stringify(c) })),
  setCommentStatus: async (id, commentId, status, author) =>
    rest(await fetch(`/api/diagrams/${id}/comments/${commentId}`, { method: "PATCH", headers: json, body: JSON.stringify({ status, author }) })),
};

/** Tool results are JSON text; failures carry { ok: false, status, error }. */
function toolResult(r: any): Result {
  const body = JSON.parse(r.content?.[0]?.text ?? "{}");
  return { status: r.isError ? (body.status ?? 400) : 200, body };
}

/**
 * Connects to the MCP Apps host and resolves with the backend and the diagram id
 * taken from the tool call that opened the canvas (create_diagram / get_diagram).
 */
export async function appBackend(): Promise<{ backend: Backend; diagramId: Promise<string> }> {
  const app = new App({ name: "bpmn-collab-canvas", version: "0.1.0" });
  const diagramId = new Promise<string>((resolve) => {
    app.ontoolinput = (p: any) => typeof p?.arguments?.id === "string" && resolve(p.arguments.id);
    app.ontoolresult = (p: any) => {
      const id = toolResult(p).body?.id;
      if (typeof id === "string") resolve(id);
    };
  });
  await app.connect();
  const call = async (name: string, args: Record<string, unknown>) => toolResult(await app.callServerTool({ name, arguments: args }));
  const backend: Backend = {
    canMessageHost: true,
    load: (id) => call("canvas_load", { id }),
    save: (id, xml, baseVersion, author) => call("canvas_save", { id, xml, baseVersion, author }),
    addComment: (id, c) => call("canvas_add_comment", { id, ...c }),
    setCommentStatus: (id, commentId, status, author) => call("canvas_set_comment_status", { id, commentId, status, author }),
    askHost: async (text) => {
      await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    },
    // The sandboxed iframe cannot download by itself: the host does it (with its own confirmation).
    download: async (fileName, mimeType, content) => {
      try {
        const r = await app.downloadFile({ contents: [{ type: "resource", resource: { uri: `file:///${fileName}`, mimeType, text: content } }] });
        return !r.isError;
      } catch {
        return false;
      }
    },
    openExportLink: async (id) => {
      try {
        const link = await call("canvas_export_link", { id });
        if (link.status !== 200) return false;
        return !(await app.openLink({ url: link.body.downloadUrl })).isError;
      } catch {
        return false;
      }
    },
  };
  return { backend, diagramId };
}
