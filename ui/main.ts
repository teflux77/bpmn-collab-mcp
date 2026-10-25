import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import BpmnModeler from "bpmn-js/lib/Modeler";
import processMeta from "../src/moddle/process-meta.json";

const params = new URLSearchParams(location.search);
const id = params.get("id");
const author = localStorage.getItem("author") ?? prompt("Your name?") ?? "anonymous";
localStorage.setItem("author", author);

const $ = (s: string) => document.querySelector(s) as HTMLElement;
// Register the pm: descriptor so pm:Meta in extensionElements is typed (read and written back as-is).
const modeler: any = new BpmnModeler({ container: "#canvas", moddleExtensions: { pm: processMeta } });

let version = 0;
let comments: any[] = [];
let issues: any[] = [];
let selected: string | null = null;
let saving: number | undefined;

async function load() {
  const r = await fetch(`/api/diagrams/${id}`);
  const d = await r.json();
  version = d.version;
  comments = d.comments;
  issues = d.issues ?? [];
  const { warnings } = await modeler.importXML(d.xml);
  if (warnings.length) console.warn("import warnings", warnings);
  modeler.get("canvas").zoom("fit-viewport");
  status(`v${version} loaded`);
  render();
}

function status(msg: string) {
  $("#status").textContent = msg;
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
          const r = await fetch(`/api/diagrams/${id}/comments/${c.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "resolved", author }),
          });
          if (r.ok) Object.assign(c, await r.json());
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
  const { xml } = await modeler.saveXML({ format: true });
  const r = await fetch(`/api/diagrams/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xml, baseVersion: version, author }),
  });
  if (r.status === 409) return status("Conflict: the AI saved a newer version. Reload the page.");
  const body = await r.json();
  issues = body.issues ?? [];
  renderIssues();
  if (!r.ok) return status(`Not saved: ${body.error}`);
  version = body.version;
  status(`Saved v${version}`);
}

modeler.on("commandStack.changed", () => {
  clearTimeout(saving);
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
  const r = await fetch(`/api/diagrams/${id}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ elementId: selected, text, author, kind: ($("#for-ai") as HTMLInputElement).checked ? "ai-request" : "note" }),
  });
  const body = await r.json();
  if (!r.ok) return status(`Comment rejected: ${body.error}`);
  comments.push(body);
  ($("#txt") as HTMLTextAreaElement).value = "";
  render();
};

// Pick up comments resolved by the AI and newer revisions without reloading the canvas.
async function poll() {
  const r = await fetch(`/api/diagrams/${id}`);
  if (!r.ok) return;
  const d = await r.json();
  comments = d.comments;
  render();
  if (d.version > version) status(`v${d.version} saved by ${d.lastAuthor ?? "someone else"}: reload to see it`);
}

if (!id) status("Missing ?id=");
else {
  load();
  setInterval(poll, 10_000);
}
