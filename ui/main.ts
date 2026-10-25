import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import BpmnModeler from "bpmn-js/lib/Modeler";
import processMeta from "../src/moddle/process-meta.json";
import { appBackend, restBackend, type Backend } from "./backend";
import { exportFileName } from "../src/filename";

const params = new URLSearchParams(location.search);
// Inline in an MCP Apps host: framed and opened without ?id= (the id comes from the tool call).
const inline = window.parent !== window && !params.has("id");

/** Storage and prompt() may be blocked in a sandboxed iframe. */
function authorName() {
  try {
    const saved = localStorage.getItem("author");
    if (saved) return saved;
    const name = inline ? null : prompt("Your name?");
    if (name) localStorage.setItem("author", name);
    return name || "anonymous";
  } catch {
    return "anonymous";
  }
}
const author = authorName();

const $ = (s: string) => document.querySelector(s) as HTMLElement;
// Register the pm: descriptor so pm:Meta in extensionElements is typed (read and written back as-is).
const modeler: any = new BpmnModeler({ container: "#canvas", moddleExtensions: { pm: processMeta } });

let backend: Backend = restBackend;
let id: string | null = params.get("id");
let version = 0;
let comments: any[] = [];
let issues: any[] = [];
let selected: string | null = null;
let saving: number | undefined;
let dirty = false; // local edits not saved yet
let diagramName = "diagram";

async function load() {
  const { status: code, body: d } = await backend.load(id!);
  if (code !== 200) return status(`Cannot load diagram: ${d.error}`);
  version = d.version;
  diagramName = d.name ?? diagramName;
  comments = d.comments;
  issues = d.issues ?? [];
  const { warnings } = await modeler.importXML(d.xml);
  if (warnings.length) console.warn("import warnings", warnings);
  modeler.get("canvas").zoom("fit-viewport");
  dirty = false;
  status(`v${version} loaded`);
  render();
}

function status(msg: string) {
  $("#status").textContent = msg;
}

const openRequests = () => comments.filter((c) => c.status === "open" && c.kind === "ai-request");

function askClaudeButton() {
  const b = document.createElement("button");
  b.textContent = "Ask Claude to apply now";
  b.title = "Posts a message in the conversation asking Claude to process the open AI requests";
  b.onclick = async () => {
    await backend.askHost?.(
      `Please process the open AI requests on BPMN diagram ${id} (bpmn-collab): apply each one on its element, reply to it, then resolve it.`,
    );
    status("Request sent to Claude");
  };
  return b;
}

function render() {
  const overlays = modeler.get("overlays");
  overlays.remove({ type: "comment-badge" });
  const counts = new Map<string, number>();
  comments.filter((c) => c.status === "open").forEach((c) => counts.set(c.elementId, (counts.get(c.elementId) ?? 0) + 1));
  for (const [el, n] of counts) {
    try {
      const html = document.createElement("span");
      html.className = "badge";
      html.textContent = String(n);
      overlays.add(el, "comment-badge", { position: { top: -8, right: 8 }, html });
    } catch {
      /* element no longer exists */
    }
  }
  renderIssues();

  const ask = $("#ask");
  ask.innerHTML = "";
  if (backend.canMessageHost && openRequests().length) ask.appendChild(askClaudeButton());

  const list = $("#list");
  list.innerHTML = "";
  comments
    .filter((c) => !selected || c.elementId === selected)
    .forEach((c) => {
      const div = document.createElement("div");
      div.className = `c ${c.status} ${c.kind}`;
      const meta = document.createElement("small");
      meta.textContent = `${c.kind === "ai-request" ? "🤖 For the AI · " : ""}${c.author} · ${c.elementId}`;
      const body = document.createElement("div");
      body.textContent = c.text;
      div.append(meta, body);
      if (c.status === "resolved") {
        const done = document.createElement("small");
        done.className = "done";
        done.textContent = c.resolvedBy === "ai" ? "✓ Applied by the AI" : `Closed by ${c.resolvedBy ?? "someone"}`;
        div.appendChild(done);
      } else if (c.kind === "ai-request") {
        // No close button: the AI resolves a request once it has applied it.
        const wait = document.createElement("small");
        wait.className = "done";
        wait.textContent = "Waiting for the AI's next turn";
        div.appendChild(wait);
      } else {
        const b = document.createElement("button");
        b.textContent = "Close";
        b.title = "Close this comment without any AI action";
        b.onclick = async () => {
          const r = await backend.setCommentStatus(id!, c.id, "resolved", author);
          if (r.status === 200) Object.assign(c, r.body);
          render();
        };
        div.appendChild(b);
      }
      list.appendChild(div);
    });
}

function renderIssues() {
  const box = $("#issues");
  box.innerHTML = "";
  const shown = issues.filter((i) => i.severity !== "info");
  $("#issues-title").textContent = shown.length ? `Validation (${shown.length})` : "Validation: OK";
  for (const i of shown) {
    const div = document.createElement("div");
    div.className = `i ${i.severity}`;
    div.textContent = `${i.severity === "error" ? "✖" : "⚠"} ${i.message}`;
    if (i.elementId) {
      div.title = i.elementId;
      div.onclick = () => {
        const el = modeler.get("elementRegistry").get(i.elementId);
        if (el) modeler.get("selection").select(el);
      };
    }
    box.appendChild(div);
  }
}

async function save() {
  saving = undefined;
  const { xml } = await modeler.saveXML({ format: true });
  const r = await backend.save(id!, xml, version, author);
  if (r.status === 409) return status("Conflict: the AI saved a newer version. Reload to get it (your last edit is not saved).");
  issues = r.body.issues ?? [];
  renderIssues();
  if (r.status !== 200) return status(`Not saved: ${r.body.error}`);
  version = r.body.version;
  dirty = false;
  status(`Saved v${version}`);
}

modeler.on("commandStack.changed", () => {
  clearTimeout(saving);
  dirty = true;
  status("Editing…");
  saving = window.setTimeout(save, 1500); // debounce
});

modeler.on("selection.changed", ({ newSelection }: any) => {
  selected = newSelection[0]?.id ?? null;
  $("#sel").textContent = selected ?? "No element selected";
  render();
});

$("#add").onclick = async () => {
  const text = ($("#txt") as HTMLTextAreaElement).value.trim();
  if (!selected || !text) return;
  const kind = ($("#for-ai") as HTMLInputElement).checked ? "ai-request" : "note";
  const r = await backend.addComment(id!, { elementId: selected, text, author, kind });
  if (r.status !== 200) return status(`Comment rejected: ${r.body.error}`);
  comments.push(r.body);
  ($("#txt") as HTMLTextAreaElement).value = "";
  render();
};

/** Pick up comments resolved by the AI and newer revisions; reload them when nothing local is pending. */
async function poll() {
  const r = await backend.load(id!);
  if (r.status !== 200) return;
  comments = r.body.comments;
  render();
  if (r.body.version <= version) return;
  if (!dirty) await load();
  else status(`v${r.body.version} saved by ${r.body.lastAuthor ?? "someone else"}: reload to see it`);
}

// ---- Export: .bpmn (latest revision) and SVG ----
/** Saves pending edits first, so the file is the latest revision. */
async function flushSave() {
  if (saving !== undefined) {
    clearTimeout(saving);
    await save();
  }
}

function showExportPanel(content: string, message: string) {
  ($("#export-msg") as HTMLElement).textContent = message;
  const area = $("#export-text") as HTMLTextAreaElement;
  area.value = content;
  $("#export-panel").hidden = false;
  area.focus();
  area.select();
}

async function copyExportText() {
  const area = $("#export-text") as HTMLTextAreaElement;
  area.select();
  try {
    await navigator.clipboard.writeText(area.value);
  } catch {
    document.execCommand("copy"); // older or sandboxed contexts
  }
  status("XML copied");
}

async function exportFile(kind: "bpmn" | "svg") {
  await flushSave();
  const { content, mime } =
    kind === "bpmn"
      ? { content: (await modeler.saveXML({ format: true })).xml as string, mime: "application/xml" }
      : { content: (await modeler.saveSVG()).svg as string, mime: "image/svg+xml" };
  const fileName = exportFileName(diagramName, version, kind);
  if (await backend.download(fileName, mime, content)) return status(`${fileName} downloaded`);
  // Inline in a chat: the host refused or cannot download; try a signed link, then copy/paste.
  if (kind === "bpmn" && (await backend.openExportLink?.(id!))) return status("Download link opened");
  showExportPanel(content, `Download blocked here: copy the ${kind === "bpmn" ? "XML" : "SVG"} and save it as ${fileName}.`);
}

$("#dl-bpmn").onclick = () => void exportFile("bpmn").catch((e) => status(`Export failed: ${e.message ?? e}`));
$("#dl-svg").onclick = () => void exportFile("svg").catch((e) => status(`Export failed: ${e.message ?? e}`));
$("#export-copy").onclick = () => void copyExportText();
$("#export-close").onclick = () => ($("#export-panel").hidden = true);

async function start() {
  if (inline) {
    status("Connecting to Claude…");
    const app = await appBackend();
    backend = app.backend;
    $("#hint").textContent = "Tick “Request for the AI”, then “Ask Claude to apply now” to send it to the conversation.";
    id = await app.diagramId;
  }
  if (!id) return status("Missing ?id=");
  await load();
  setInterval(poll, 10_000);
}

start().catch((e) => status(`Error: ${e.message ?? e}`));
