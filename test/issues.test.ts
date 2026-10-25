import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { fingerprint, guardAiSave, triage, type GuardState, type TriagedIssue } from "../src/issues.js";
import type { Issue } from "../src/validate.js";
import { fixture, edit } from "./helpers.js";

const warn = (rule: string, elementId: string, message = "m"): Issue => ({ rule, severity: "warning", elementId, message });
const tri = (...issues: Issue[]) => triage(issues);

describe("fingerprints and triage", () => {
  it("are stable across counts and whitespace, distinct across rules and elements", () => {
    const a = fingerprint({ rule: "pm/activity-count", elementId: "P", message: "14 activities  at this level" });
    expect(fingerprint({ rule: "pm/activity-count", elementId: "P", message: "15 activities at this level" })).toBe(a);
    expect(fingerprint({ rule: "pm/activity-count", elementId: "Q", message: "14 activities at this level" })).not.toBe(a);
    expect(fingerprint({ rule: "label-required", elementId: "P", message: "14 activities at this level" })).not.toBe(a);
  });

  it("marks dismissed issues, but never errors", () => {
    const w = warn("label-required", "T1");
    const e: Issue = { rule: "no-bpmndi", severity: "error", elementId: "T1", message: "missing" };
    const dismissed = [w, e].map((i) => ({ fingerprint: fingerprint(i), rule: i.rule, message: i.message, reason: "fp", author: "ai", at: "" }));
    const t = triage([w, e], dismissed);
    expect(t.map((i) => i.status)).toEqual(["dismissed", "open"]);
    expect(t[0].dismissal).toMatchObject({ reason: "fp", author: "ai" });
  });
});

describe("loop guard", () => {
  const run = (sets: TriagedIssue[][], start?: GuardState) => {
    let state = start;
    return sets.map((s) => {
      const r = guardAiSave(state, s);
      state = r.state;
      return r.verdict;
    });
  };
  const A1 = warn("pm/gateway-flow-label", "F1");
  const A2 = warn("label-required", "T1");

  it("lets real progress through", () => {
    const v = run([tri(A1, A2), tri(A1), tri()]);
    expect(v.map((x) => x.loop_guard)).toEqual([false, false, false]);
  });

  it("stops when the same issues survive two consecutive AI saves", () => {
    const v = run([tri(A1), tri(A1)]);
    expect(v[1]).toMatchObject({ loop_guard: true, instruction: expect.stringMatching(/^Stop fixing/) });
    expect(v[1].reasons).toContain("the same open issues survived two consecutive AI saves");
  });

  it("stops when a fix introduces a new warning", () => {
    const v = run([tri(A1), tri(A2)]);
    expect(v[1].loop_guard).toBe(true);
    expect(v[1].introduced).toEqual([fingerprint(A2)]);
  });

  it("stops an oscillation A -> B -> A at the third cycle", () => {
    const v = run([tri(A1, A2), tri(A1), tri(A1, A2)]);
    expect(v.map((x) => x.loop_guard)).toEqual([false, false, true]);
    expect(v[2].reasons).toEqual(expect.arrayContaining(["the open issues went back to a state already seen (oscillation)"]));
  });

  it("detects a fix that recreates the same kind of issue on the same element", () => {
    const v = run([tri(warn("label-required", "T1", "missing label")), tri(warn("label-required", "T1", "label too long"))]);
    expect(v[1].reasons).toContain("a fix recreated the same kind of issue on the same element");
  });

  it("forgets history older than 30 minutes (a new request)", () => {
    const old: GuardState = { history: [{ hash: "x", fingerprints: [fingerprint(A1)], keys: [], at: new Date(Date.now() - 31 * 60_000).toISOString() }] };
    expect(run([tri(A1)], old)[0].loop_guard).toBe(false);
  });
});

describe("triage over MCP and REST", () => {
  let server: Server;
  let base: string;
  let client: Client;
  const store = new Store();
  const valid = fixture("valid.bpmn");
  // two independent warnings on the valid fixture
  const noLabel = (xml: string) => edit(xml, ['<bpmn:sequenceFlow id="Flow_No" name="No"', '<bpmn:sequenceFlow id="Flow_No"']);
  const noGwLabel = (xml: string) =>
    edit(xml, ['<bpmndi:BPMNLabel>\n          <dc:Bounds x="380" y="160" width="80" height="27" />\n        </bpmndi:BPMNLabel>\n', ""]);

  beforeAll(async () => {
    const app = createApp({ store, publicUrl: "http://public.test" });
    server = await new Promise<Server>((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = new Client({ name: "issues-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client?.close();
    await new Promise((ok) => server?.close(ok));
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
  };
  const create = async (xml: string) => (await call("create_diagram", { name: "Triage", xml })).body.id as string;
  const save = async (id: string, xml: string) => {
    const v = (await call("get_diagram", { id })).body.version;
    return (await call("update_diagram", { id, xml, baseVersion: v })).body;
  };
  const putHuman = async (id: string, xml: string) => {
    const v = (await call("get_diagram", { id })).body.version;
    return fetch(`${base}/api/diagrams/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ xml, baseVersion: v, author: "ana" }) });
  };

  it("a dismissed false positive is never reported again, until restored", async () => {
    const id = await create(noLabel(valid));
    const listed = (await call("list_issues", { id })).body;
    const issue = listed.issues.find((i: any) => i.rule === "pm/gateway-flow-label");
    expect(issue).toMatchObject({ status: "open", elementId: "Flow_No", severity: "warning" });

    const d = await call("dismiss_issue", { id, fingerprint: issue.fingerprint, reason: "Default branch, label not needed here" });
    expect(d.body).toMatchObject({ ok: true, status: "dismissed", summary: { warnings: 0, dismissed: 1 } });

    expect((await call("get_diagram", { id })).body.openIssues).toEqual([]);
    const saved = await save(id, noLabel(valid)); // a later AI save of the same model
    expect(saved).toMatchObject({ openIssues: [], loop_guard: false, issueSummary: { dismissed: 1 } });
    const all = (await call("validate_diagram", { id })).body.issues;
    expect(all).toEqual([expect.objectContaining({ fingerprint: issue.fingerprint, status: "dismissed", dismissal: expect.objectContaining({ author: "ai" }) })]);

    expect((await call("restore_issue", { id, fingerprint: issue.fingerprint })).body).toMatchObject({ status: "open", summary: { warnings: 1 } });
  });

  it("refuses to dismiss an error, an unknown fingerprint, or without a reason", async () => {
    const id = await create(valid);
    await putHuman(id, fixture("invalid.bpmn")); // human saves are kept even with errors
    const err = (await call("list_issues", { id })).body.issues.find((i: any) => i.severity === "error");
    expect((await call("dismiss_issue", { id, fingerprint: err.fingerprint, reason: "no" })).body.error).toMatch(/cannot be dismissed/);
    expect((await call("dismiss_issue", { id, fingerprint: "000000000000", reason: "x" })).isError).toBe(true);
    const w = (await call("list_issues", { id })).body.issues.find((i: any) => i.severity === "warning");
    expect((await call("dismiss_issue", { id, fingerprint: w.fingerprint, reason: "  " })).body.error).toMatch(/reason/);
  });

  it("stops when a fix introduces a new warning", async () => {
    const id = await create(valid);
    expect((await save(id, noLabel(valid))).loop_guard).toBe(false);
    const second = await save(id, noGwLabel(valid)); // fixes the label, breaks the gateway label bounds
    expect(second).toMatchObject({ loop_guard: true, instruction: expect.stringMatching(/ask the human/) });
    expect(second.introduced).toHaveLength(1);
  });

  it("stops an A -> B -> A oscillation at the third AI save, and a human save starts a new round", async () => {
    const id = await create(valid);
    const A = noGwLabel(noLabel(valid));
    const B = noLabel(valid);
    expect((await save(id, A)).loop_guard).toBe(false);
    expect((await save(id, B)).loop_guard).toBe(false);
    const third = await save(id, A);
    expect(third.loop_guard).toBe(true);
    expect(third.reasons).toEqual(expect.arrayContaining(["the open issues went back to a state already seen (oscillation)"]));

    await putHuman(id, A);
    expect((await save(id, A)).loop_guard).toBe(false);
  });

  it("does not count warnings waiting for a human answer", async () => {
    const id = await create(valid);
    await save(id, noLabel(valid));
    await call("add_comment", { id, elementId: "Flow_No", text: "Is this the default branch or should it be labeled?" });
    expect((await save(id, noLabel(valid))).loop_guard).toBe(false);
  });

  it("flags AI changes to elements a human added", async () => {
    const id = await create(valid);
    const withNote = edit(valid, ["  </bpmn:process>", '  <bpmn:group id="Group_Human" />\n  </bpmn:process>']);
    await putHuman(id, withNote);
    expect(store.get(id)!.humanAdded).toContain("Group_Human");
    const r = await save(id, valid); // the AI drops the human's group
    expect(r.humanElementsTouched).toEqual(["Group_Human"]);
  });

  it("lets the human dismiss and restore from the canvas (REST)", async () => {
    const id = await create(noLabel(valid));
    const fp = (await call("list_issues", { id })).body.issues[0].fingerprint;
    const post = (path: string, body: object) =>
      fetch(`${base}/api/diagrams/${id}/issues/${fp}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("dismiss", { reason: "Not relevant for this diagram", author: "ana" })).status).toBe(200);
    const all = (await call("list_issues", { id })).body.issues;
    expect(all[0]).toMatchObject({ status: "dismissed", dismissal: { author: "human:ana", reason: "Not relevant for this diagram" } });
    expect((await post("restore", {})).status).toBe(200);
    expect((await post("restore", {})).status).toBe(404);
  });
});
