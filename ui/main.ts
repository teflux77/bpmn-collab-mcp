import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import "diagram-js-minimap/assets/diagram-js-minimap.css";
import BpmnModeler from "bpmn-js/lib/Modeler";
import minimapModule from "diagram-js-minimap";
import processMeta from "../src/moddle/process-meta.json";
import { appBackend, restBackend, type Backend } from "./backend";
import { contentBox, fitViewbox, needsRefit } from "./view";
import { exportFileName } from "../src/filename";
import { normalizeDrilldownXml } from "../src/drilldown";
import {
  applyOverlays, authorLabel, isAi, loadPrefs, orphans, planOverlays, preview, savePrefs, svgWithComments, thread,
  type Bounds, type CanvasComment, type CommentPrefs, type OverlayPlan,
} from "./comments-view";

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
const modeler: any = new BpmnModeler({
  container: "#canvas",
  moddleExtensions: { pm: processMeta },
  // Official bpmn.io minimap: the viewport rectangle can be dragged to scroll the diagram.
  additionalModules: [minimapModule],
  minimap: { open: true },
});
// Shown at the bottom of the side panel, not over the canvas (it positions itself from its own element).
const minimapEl = document.querySelector("#canvas .djs-minimap");
if (minimapEl) $("#minimap-slot").appendChild(minimapEl);

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
  showTitle();
  comments = d.comments;
  issues = d.issues ?? [];
  const { warnings } = await modeler.importXML(d.xml);
  if (warnings.length) console.warn("import warnings", warnings);
  fitToFreeArea();
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
  renderOverlays();
  renderIssues();
  renderOrphans();

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
      meta.className = "focus";
      meta.title = "Show this element on the diagram";
      meta.onclick = () => focusElement(c.elementId);
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

/** Reloads issues only (after a dismiss/restore), keeping the canvas as it is. */
async function refreshIssues() {
  const r = await backend.load(id!);
  if (r.status === 200) issues = r.body.issues ?? [];
  renderIssues();
}

function issueRow(i: any) {
  const div = document.createElement("div");
  div.className = `i ${i.severity} ${i.status}`;
  const msg = document.createElement("span");
  msg.textContent = `${i.severity === "error" ? "✖" : i.severity === "warning" ? "⚠" : "ℹ"} ${i.message}`;
  if (i.elementId) {
    msg.title = i.elementId;
    msg.onclick = () => {
      const el = modeler.get("elementRegistry").get(i.elementId);
      if (el) modeler.get("selection").select(el);
    };
  }
  div.appendChild(msg);
  if (i.status === "dismissed") {
    const why = document.createElement("small");
    why.textContent = ` (écartée par ${i.dismissal?.author ?? "?"} : ${i.dismissal?.reason ?? ""}) `;
    const b = document.createElement("button");
    b.textContent = "Restaurer";
    b.onclick = async () => {
      const r = await backend.restoreIssue(id!, i.fingerprint);
      if (r.status !== 200) status(`Restore failed: ${r.body.error}`);
      await refreshIssues();
    };
    div.append(why, b);
  } else if (i.severity !== "error") {
    // errors make the model invalid: they are fixed, never dismissed
    const b = document.createElement("button");
    b.textContent = "Écarter";
    b.title = "False positive or rule not relevant here";
    b.onclick = () => {
      const form = document.createElement("span");
      const input = Object.assign(document.createElement("input"), { placeholder: "Raison (courte)", size: 22 });
      const ok = Object.assign(document.createElement("button"), { textContent: "OK" });
      ok.onclick = async () => {
        if (!input.value.trim()) return input.focus();
        const r = await backend.dismissIssue(id!, i.fingerprint, input.value.trim(), author);
        if (r.status !== 200) status(`Dismiss failed: ${r.body.error}`);
        await refreshIssues();
      };
      input.onkeydown = (e) => e.key === "Enter" && ok.click();
      form.append(" ", input, ok);
      b.replaceWith(form);
      input.focus();
    };
    div.appendChild(b);
  }
  return div;
}

function renderIssues() {
  const box = $("#issues");
  box.innerHTML = "";
  const active = issues.filter((i) => i.status !== "dismissed" && i.severity !== "info");
  const dismissed = issues.filter((i) => i.status === "dismissed");
  $("#issues-title").textContent = active.length ? `Validation (${active.length})` : "Validation: OK";
  active.forEach((i) => box.appendChild(issueRow(i)));
  if (dismissed.length) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Écartées (${dismissed.length})`;
    details.appendChild(summary);
    dismissed.forEach((i) => details.appendChild(issueRow(i)));
    box.appendChild(details);
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
      ? { content: await exportBpmn(), mime: "application/xml" }
      : { content: await exportSvg(), mime: "image/svg+xml" };
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

// ---- Zoom: buttons on every device (diagram-js handles Ctrl/Cmd + wheel, trackpad pinch, drag) ----
const canvas = modeler.get("canvas");
const showZoom = () => ($("#zoom-level").textContent = `${Math.round(canvas.zoom() * 100)} %`);
const zoomTo = (z: number) => canvas.zoom(Math.min(4, Math.max(0.2, z)), "auto");
$("#zoom-in").onclick = () => zoomTo(canvas.zoom() * 1.25);
$("#zoom-out").onclick = () => zoomTo(canvas.zoom() / 1.25);
$("#zoom-fit").onclick = () => fitToFreeArea();

/**
 * Like fit-viewport, but keeps the content clear of the palette (left) and the zoom bar (top),
 * measured on screen, with a margin around it.
 */
function fitToFreeArea() {
  const root = canvas.getRootElement();
  const content = contentBox(modeler.get("elementRegistry").filter((e: any) => e.parent === root));
  if (!content) return;
  const box = $("#canvas").getBoundingClientRect();
  const palette = document.querySelector("#canvas .djs-palette")?.getBoundingClientRect();
  const bar = $("#zoom-bar").getBoundingClientRect();
  const margin = 24;
  const insets = {
    left: palette && palette.width ? palette.right - box.left + margin : margin,
    top: Math.max(margin, bar.bottom - box.top + 8),
    right: margin,
    bottom: margin,
  };
  const { scale, ...viewbox } = fitViewbox(content, { width: box.width, height: box.height }, insets);
  canvas.viewbox(viewbox);
}
$("#zoom-reset").onclick = () => zoomTo(1);
modeler.on("canvas.viewbox.changed", showZoom);

/** Centres an element at a readable zoom and highlights it briefly (drills into its sub-process if needed). */
function focusElement(elementId: string) {
  const el = modeler.get("elementRegistry").get(elementId);
  if (!el) return status(`Element ${elementId} no longer exists (orphan comment)`);
  const root = canvas.findRoot?.(el);
  if (root && root !== canvas.getRootElement()) canvas.setRootElement(root);
  if (canvas.zoom() < 1) canvas.zoom(1);
  canvas.scrollToElement(el, { top: 120, bottom: 120, left: 160, right: 160 });
  modeler.get("selection").select(el);
  canvas.addMarker(elementId, "highlight");
  setTimeout(() => canvas.removeMarker(elementId, "highlight"), 2500);
}

// ---- Comments on the canvas (overlays attached to elements) ----
/** localStorage may be missing or throw in a sandboxed iframe: the page works without it. */
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
let prefs: CommentPrefs = loadPrefs(storage);
let expanded: string | null = null; // element whose thread is open in its bubble

function elementBounds() {
  const map = new Map<string, Bounds>();
  for (const el of modeler.get("elementRegistry").getAll()) {
    if (el.waypoints) {
      const xs = el.waypoints.map((p: any) => p.x), ys = el.waypoints.map((p: any) => p.y);
      map.set(el.id, { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    } else if (el.width !== undefined) map.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height });
  }
  return map;
}

function bubbleHtml(plan: OverlayPlan) {
  const last = plan.comments[plan.comments.length - 1] as CanvasComment;
  const div = document.createElement("div");
  div.className = `bubble ${last.status === "resolved" ? "resolved" : isAi(last) ? "ai" : "human"}`;
  // keep diagram-js from starting a drag/selection when interacting with the bubble
  div.addEventListener("mousedown", (e) => e.stopPropagation());
  div.addEventListener("pointerdown", (e) => e.stopPropagation());
  const head = document.createElement("div");
  head.className = "bubble-head";
  head.textContent = `${authorLabel(last)} : ${preview(last.text)}${plan.comments.length > 1 ? ` (+${plan.comments.length - 1})` : ""}`;
  head.title = "Show the thread";
  head.onclick = () => {
    expanded = expanded === plan.elementId ? null : plan.elementId;
    renderOverlays();
  };
  div.appendChild(head);
  if (expanded === plan.elementId) div.appendChild(threadHtml(plan.elementId));
  return div;
}

function threadHtml(elementId: string) {
  const box = document.createElement("div");
  box.className = "bubble-thread";
  for (const c of thread(comments as CanvasComment[], elementId)) {
    const item = document.createElement("div");
    item.className = `bubble-item ${c.status} ${isAi(c) ? "ai" : "human"}`;
    const who = document.createElement("small");
    who.textContent = `${authorLabel(c)}${c.parentId ? " (réponse)" : ""}${c.status === "resolved" ? " · résolu" : ""}`;
    const body = document.createElement("div");
    body.textContent = c.text;
    item.append(who, body);
    box.appendChild(item);
  }
  const input = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "Répondre…" });
  const send = Object.assign(document.createElement("button"), { textContent: "Répondre" });
  send.onclick = async () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    const root = thread(comments as CanvasComment[], elementId).find((c) => !c.parentId);
    const kind = ($("#for-ai") as HTMLInputElement).checked ? "ai-request" : "note";
    const r = await backend.addComment(id!, { elementId, text, author, kind, parentId: root?.id });
    if (r.status !== 200) return status(`Reply rejected: ${r.body.error}`);
    comments.push(r.body);
    render();
  };
  box.append(input, send);
  return box;
}

function renderOverlays() {
  applyOverlays(modeler.get("overlays"), planOverlays(comments as CanvasComment[], prefs, elementBounds()), bubbleHtml);
}

function renderOrphans() {
  const gone = orphans(comments as CanvasComment[], new Set(elementBounds().keys()));
  const box = $("#orphans");
  box.innerHTML = "";
  box.hidden = !gone.length;
  if (!gone.length) return;
  const title = document.createElement("b");
  title.textContent = `Commentaires orphelins (${gone.length})`;
  box.appendChild(title);
  for (const c of gone) {
    const div = document.createElement("div");
    div.className = `c ${c.status}`;
    div.textContent = `${authorLabel(c)} · ancien élément ${c.elementId} : ${c.text}`;
    box.appendChild(div);
  }
}

// Bubbles follow their element natively; offsets between neighbours are recomputed after a change.
let relayout: number | undefined;
modeler.on("elements.changed", () => {
  clearTimeout(relayout);
  relayout = window.setTimeout(() => {
    renderOverlays();
    renderOrphans();
  }, 150);
});
modeler.on("root.set", () => renderOverlays());

// Drill-down: bpmn-js opens a sub-process plane at the origin the first time; when its content is
// drawn elsewhere (common in generated XML) the plane looks empty. Re-fit after bpmn-js's own
// centring (lower priority), only when most of the content is out of view.
modeler.on("root.set", 500, () => {
  const root = canvas.getRootElement();
  const content = contentBox(modeler.get("elementRegistry").filter((e: any) => e.parent === root));
  if (needsRefit(canvas.viewbox(), content)) fitToFreeArea();
});

function applyPrefs(next: CommentPrefs) {
  prefs = next;
  savePrefs(storage, prefs);
  renderOverlays();
}
($("#c-show") as HTMLInputElement).checked = prefs.show;
($("#c-status") as HTMLSelectElement).value = prefs.status;
($("#c-author") as HTMLSelectElement).value = prefs.author;
$("#c-show").onchange = (e) => applyPrefs({ ...prefs, show: (e.target as HTMLInputElement).checked });
$("#c-status").onchange = (e) => applyPrefs({ ...prefs, status: (e.target as HTMLSelectElement).value as CommentPrefs["status"] });
$("#c-author").onchange = (e) => applyPrefs({ ...prefs, author: (e.target as HTMLSelectElement).value as CommentPrefs["author"] });

/** The .bpmn file: sub-process planes start at the origin, so they open correctly in Camunda Modeler. */
async function exportBpmn() {
  const { xml } = await modeler.saveXML({ format: true });
  return (await normalizeDrilldownXml(xml, modeler.get("moddle"))).xml;
}

async function exportSvg() {
  const { svg } = await modeler.saveSVG();
  if (!($("#svg-comments") as HTMLInputElement).checked) return svg as string;
  const bounds = elementBounds();
  return svgWithComments(svg, planOverlays(comments as CanvasComment[], { ...prefs, show: true }, bounds), bounds);
}

// ---- Diagram name: shown as the title, renamed in place ----
function showTitle() {
  $("#title").textContent = diagramName;
  document.title = `${diagramName} · BPMN`;
}

function editTitle() {
  const title = $("#title");
  if (title.querySelector("input")) return;
  const input = Object.assign(document.createElement("input"), { value: diagramName, maxLength: 120 });
  title.textContent = "";
  title.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== diagramName) {
      const r = await backend.rename(id!, name);
      if (r.status === 200) {
        diagramName = r.body.name;
        status("Renamed");
      } else status(`Rename failed: ${r.body.error}`);
    }
    showTitle();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") void finish(true);
    if (e.key === "Escape") void finish(false);
  };
  input.onblur = () => void finish(true);
}
$("#title").onclick = editTitle;
$("#title").onkeydown = (e) => e.key === "Enter" && editTitle();

async function start() {
  if (inline) {
    status("Connecting to Claude…");
    const app = await appBackend();
    backend = app.backend;
    $("#hint").textContent = "Tick “Request for the AI”, then “Ask Claude to apply now” to send it to the conversation.";
    $("#back").hidden = true; // the list of diagrams is a web page, outside the chat
    id = await app.diagramId;
  }
  if (!id) return status("Missing ?id=");
  await load();
  setInterval(poll, 10_000);
}

start().catch((e) => status(`Error: ${e.message ?? e}`));
