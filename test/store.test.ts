import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, StoreError, EMPTY_BPMN, openComments } from "../src/store.js";
import { validateXml } from "../src/validate.js";
import { fixture } from "./helpers.js";

const dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bpmn-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe("Store", () => {
  it("creates a diagram at version 1 from the empty template", () => {
    const s = new Store();
    const d = s.create("Order & <returns>");
    expect(s.latest(d)).toMatchObject({ version: 1, author: "ai" });
    expect(s.latest(d).xml).toContain('name="Order &amp; &lt;returns&gt;"');
    expect(s.list()).toEqual([{ id: d.id, name: "Order & <returns>", version: 1 }]);
  });

  it("produces an empty template that parses and has no errors", async () => {
    const issues = await validateXml(EMPTY_BPMN("Empty"));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("appends revisions on the current version and rejects a stale baseVersion with 409", () => {
    const s = new Store();
    const d = s.create("P");
    expect(s.update(d.id, fixture("valid.bpmn"), 1, "human:ana").version).toBe(2);
    try {
      s.update(d.id, fixture("valid.bpmn"), 1, "ai");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).code).toBe(409);
    }
    expect(s.latest(d).version).toBe(2);
  });

  it("throws 404 for unknown diagrams and comments", () => {
    const s = new Store();
    expect(() => s.update("nope", "", 1, "ai")).toThrow(expect.objectContaining({ code: 404 }));
    expect(() => s.addComment("nope", { elementId: "x", text: "t", author: "ai" })).toThrow(expect.objectContaining({ code: 404 }));
    const d = s.create("P");
    expect(() => s.setCommentStatus(d.id, "nope", "resolved", "ai")).toThrow(expect.objectContaining({ code: 404 }));
  });

  it("adds, replies to and resolves comments", () => {
    const s = new Store();
    const d = s.create("P");
    const c = s.addComment(d.id, { elementId: "StartEvent_1", text: "Which trigger?", author: "human:ana" });
    expect(c).toMatchObject({ status: "open", kind: "note", elementId: "StartEvent_1" });
    const r = s.addComment(d.id, { elementId: "StartEvent_1", text: "A received order", author: "ai", parentId: c.id });
    expect(r.parentId).toBe(c.id);
    expect(s.setCommentStatus(d.id, c.id, "resolved", "ai")).toMatchObject({ status: "resolved", resolvedBy: "ai" });
    const reopened = s.setCommentStatus(d.id, c.id, "open", "human:ana");
    expect(reopened.status).toBe("open");
    expect(reopened.resolvedBy).toBeUndefined();
  });

  it("lists open AI requests before notes", () => {
    const s = new Store();
    const d = s.create("P");
    const note = s.addComment(d.id, { elementId: "StartEvent_1", text: "fyi", author: "human:ana" });
    const req = s.addComment(d.id, { elementId: "StartEvent_1", text: "Rename in French", author: "human:ana", kind: "ai-request" });
    const done = s.addComment(d.id, { elementId: "StartEvent_1", text: "old", author: "human:ana", kind: "ai-request" });
    s.setCommentStatus(d.id, done.id, "resolved", "ai");
    expect(openComments(s.get(d.id)!.comments).map((c) => c.id)).toEqual([req.id, note.id]);
  });

  it("loads comments saved before comment kinds existed as notes", () => {
    const dir = tmpDir();
    const a = new Store(dir);
    const d = a.create("P");
    a.addComment(d.id, { elementId: "StartEvent_1", text: "legacy", author: "ai" });
    const file = path.join(dir, "diagrams.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw[0].comments[0].kind;
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(new Store(dir).get(d.id)!.comments[0].kind).toBe("note");
  });

  it("persists to disk and reloads", () => {
    const dir = tmpDir();
    const a = new Store(dir);
    const d = a.create("P");
    a.update(d.id, fixture("valid.bpmn"), 1, "ai", "first draft");
    a.addComment(d.id, { elementId: "Task_CheckOrder", text: "SLA?", author: "human:ana" });

    const b = new Store(dir);
    const r = b.get(d.id)!;
    expect(b.latest(r)).toMatchObject({ version: 2, note: "first draft" });
    expect(r.comments).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(["diagrams.json"]); // no leftover temp file
  });

  it("keeps purely in-memory stores off disk", () => {
    const before = fs.readdirSync(process.cwd());
    new Store().create("P");
    expect(fs.readdirSync(process.cwd())).toEqual(before);
  });
});
