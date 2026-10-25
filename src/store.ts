import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PM_NS } from "./model.js";

export interface Comment {
  id: string;
  elementId: string; // BPMN element id the comment is anchored to
  author: string; // "human:<name>" or "ai"
  text: string;
  status: "open" | "resolved";
  parentId?: string; // reply thread
  createdAt: string;
}

export interface Revision {
  version: number;
  author: string;
  xml: string;
  at: string;
  note?: string;
}

export interface Diagram {
  id: string;
  name: string;
  revisions: Revision[];
  comments: Comment[];
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const TARGET_NS = "https://github.com/teflux77/bpmn-collab-mcp/bpmn";

export const EMPTY_BPMN = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:pm="${PM_NS}"
  id="Definitions_1" targetNamespace="${TARGET_NS}">
  <bpmn:process id="Process_1" name="${escapeXml(name)}" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Start" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="160" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

export class StoreError extends Error {
  constructor(public readonly code: 404 | 409, message: string) {
    super(message);
  }
}
const notFound = (m: string) => new StoreError(404, m);

export class Store {
  private diagrams = new Map<string, Diagram>();
  private readonly file: string;

  /** Persists to <dataDir>/diagrams.json; pass no dataDir for a purely in-memory store (tests). */
  constructor(private readonly dataDir?: string) {
    this.file = dataDir ? path.join(dataDir, "diagrams.json") : "";
    if (!dataDir) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Diagram[];
      raw.forEach((d) => this.diagrams.set(d.id, d));
    } catch {
      /* first run */
    }
  }

  private persist() {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a truncated file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.diagrams.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return [...this.diagrams.values()].map((d) => ({
      id: d.id,
      name: d.name,
      version: this.latest(d).version,
    }));
  }

  get(id: string) {
    return this.diagrams.get(id);
  }

  latest(d: Diagram) {
    return d.revisions[d.revisions.length - 1];
  }

  create(name: string, xml?: string, author = "ai") {
    const d: Diagram = {
      id: randomUUID().slice(0, 8),
      name,
      revisions: [{ version: 1, author, xml: xml ?? EMPTY_BPMN(name), at: new Date().toISOString() }],
      comments: [],
    };
    this.diagrams.set(d.id, d);
    this.persist();
    return d;
  }

  /** Optimistic concurrency: caller must pass the version it started from. */
  update(id: string, xml: string, baseVersion: number, author: string, note?: string) {
    const d = this.diagrams.get(id);
    if (!d) throw notFound(`Diagram ${id} not found`);
    const cur = this.latest(d);
    if (baseVersion !== cur.version) {
      throw new StoreError(409, `Version conflict: base ${baseVersion}, current ${cur.version}`);
    }
    const rev: Revision = { version: cur.version + 1, author, xml, at: new Date().toISOString(), note };
    d.revisions.push(rev);
    this.persist();
    return rev;
  }

  addComment(id: string, c: Omit<Comment, "id" | "createdAt" | "status"> & { status?: Comment["status"] }) {
    const d = this.diagrams.get(id);
    if (!d) throw notFound(`Diagram ${id} not found`);
    const comment: Comment = {
      ...c,
      status: c.status ?? "open",
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
    };
    d.comments.push(comment);
    this.persist();
    return comment;
  }

  setCommentStatus(id: string, commentId: string, status: Comment["status"]) {
    const d = this.diagrams.get(id);
    const c = d?.comments.find((x) => x.id === commentId);
    if (!d || !c) throw notFound("Comment not found");
    c.status = status;
    this.persist();
    return c;
  }
}

