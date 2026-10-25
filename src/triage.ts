/**
 * Issue triage operations shared by the MCP tools (AI) and the canvas (human): list the issues of the
 * latest revision with their status, dismiss a false positive with a reason, restore it.
 */
import type { Diagram, Store } from "./store.js";
import { validateXml } from "./validate.js";
import { summarize, triage, type TriagedIssue } from "./issues.js";
import type { Outcome } from "./human.js";

export async function currentIssues(store: Store, d: Diagram): Promise<TriagedIssue[]> {
  return triage(await validateXml(store.latest(d).xml), d.dismissed);
}

export async function listIssues(store: Store, id: string, includeDismissed = true): Promise<Outcome> {
  const d = store.get(id);
  if (!d) return { status: 404, body: { error: "not found" } };
  const all = await currentIssues(store, d);
  return {
    status: 200,
    body: { id, version: store.latest(d).version, summary: summarize(all), issues: includeDismissed ? all : all.filter((i) => i.status === "open") },
  };
}

export async function dismissIssue(store: Store, id: string, fingerprint: string, reason: unknown, author: string): Promise<Outcome> {
  const d = store.get(id);
  if (!d) return { status: 404, body: { error: "not found" } };
  if (typeof reason !== "string" || !reason.trim()) return { status: 400, body: { error: "a short reason is required" } };
  const issues = await currentIssues(store, d);
  const issue = issues.find((i) => i.fingerprint === fingerprint);
  if (!issue) return { status: 404, body: { error: `no current issue with fingerprint ${fingerprint}` } };
  if (issue.severity === "error") return { status: 400, body: { error: "errors cannot be dismissed: they make the model invalid, fix them" } };
  store.dismiss(id, {
    fingerprint,
    rule: issue.rule,
    elementId: issue.elementId,
    message: issue.message,
    reason: reason.trim().slice(0, 500),
    author,
    at: new Date().toISOString(),
  });
  return { status: 200, body: { ok: true, fingerprint, status: "dismissed", summary: summarize(await currentIssues(store, d)) } };
}

export async function restoreIssue(store: Store, id: string, fingerprint: string): Promise<Outcome> {
  const d = store.get(id);
  if (!d) return { status: 404, body: { error: "not found" } };
  if (!d.dismissed?.some((x) => x.fingerprint === fingerprint)) return { status: 404, body: { error: `issue ${fingerprint} is not dismissed` } };
  store.restore(id, fingerprint);
  return { status: 200, body: { ok: true, fingerprint, status: "open", summary: summarize(await currentIssues(store, d)) } };
}
