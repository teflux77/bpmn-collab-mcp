/**
 * Lint issue triage: stable fingerprints, dismissals (false positives, rules not relevant here), and
 * the server-side loop guard that tells the AI to stop fixing and ask the human.
 * Pure functions over plain data; the store persists `dismissed` and `guard` per diagram.
 */
import { createHash } from "node:crypto";
import type { Issue } from "./validate.js";

export interface Dismissal {
  fingerprint: string;
  rule: string;
  elementId?: string;
  message: string;
  reason: string;
  author: string; // "ai" or "human:<name>"
  at: string;
}

export interface TriagedIssue extends Issue {
  fingerprint: string;
  status: "open" | "dismissed";
  dismissal?: Pick<Dismissal, "reason" | "author" | "at">;
}

/** Counts and sizes vary between revisions; they must not change the identity of an issue. */
const normalize = (message: string) => message.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

export function fingerprint(i: Pick<Issue, "rule" | "elementId" | "message">) {
  return createHash("sha256").update(`${i.rule}\u0000${i.elementId ?? ""}\u0000${normalize(i.message)}`).digest("hex").slice(0, 12);
}

export function triage(issues: Issue[], dismissed: Dismissal[] = []): TriagedIssue[] {
  const byFp = new Map(dismissed.map((d) => [d.fingerprint, d]));
  return issues.map((i) => {
    const fp = fingerprint(i);
    const d = i.severity === "error" ? undefined : byFp.get(fp); // errors are never dismissed
    return { ...i, fingerprint: fp, status: d ? "dismissed" : "open", ...(d ? { dismissal: { reason: d.reason, author: d.author, at: d.at } } : {}) };
  });
}

export const openIssues = (t: TriagedIssue[]) => t.filter((i) => i.status === "open");

export function summarize(t: TriagedIssue[]) {
  const open = openIssues(t);
  return {
    errors: open.filter((i) => i.severity === "error").length,
    warnings: open.filter((i) => i.severity === "warning").length,
    info: open.filter((i) => i.severity === "info").length,
    dismissed: t.length - open.length,
  };
}

// ---- Loop guard ----

export interface GuardState {
  /** Open warning fingerprints after each AI save since the last human save, oldest first. */
  history: { hash: string; fingerprints: string[]; keys: string[]; at: string }[];
}

export interface GuardVerdict {
  loop_guard: boolean;
  reasons: string[];
  /** Warnings this save introduced (not open before it). */
  introduced: string[];
  instruction?: string;
}

/** History older than this belongs to a previous request. */
const STALE_MS = 30 * 60 * 1000;
const GUARD_INSTRUCTION =
  "Stop fixing. Do not save again for these issues: summarize what you fixed, what you dismissed (with reasons) and what is still open, and ask the human how to proceed.";

const setHash = (fps: string[]) => createHash("sha256").update([...fps].sort().join(",")).digest("hex").slice(0, 16);

/**
 * Evaluates an AI save. `relevant` are the open warnings the AI is expected to handle (warnings
 * waiting for a human answer are excluded by the caller). Returns the verdict and the new state.
 */
export function guardAiSave(state: GuardState | undefined, relevant: TriagedIssue[], now = new Date()): { verdict: GuardVerdict; state: GuardState } {
  const fresh = (state?.history ?? []).filter((h) => now.getTime() - Date.parse(h.at) < STALE_MS);
  const fps = [...new Set(relevant.map((i) => i.fingerprint))].sort();
  const keys = [...new Set(relevant.map((i) => `${i.rule}@${i.elementId ?? ""}`))];
  const entry = { hash: setHash(fps), fingerprints: fps, keys, at: now.toISOString() };
  const prev = fresh[fresh.length - 1];
  const reasons: string[] = [];
  const introduced = prev ? fps.filter((f) => !prev.fingerprints.includes(f)) : [];

  if (prev && fps.length) {
    if (entry.hash === prev.hash) reasons.push("the same open issues survived two consecutive AI saves");
    else if (fresh.slice(0, -1).some((h) => h.hash === entry.hash)) reasons.push("the open issues went back to a state already seen (oscillation)");
    if (fps.length > prev.fingerprints.length) reasons.push("the number of open issues grew");
    if (introduced.length) reasons.push(`this save introduced ${introduced.length} new issue(s)`);
    const recreated = introduced.filter((f) => {
      const i = relevant.find((x) => x.fingerprint === f)!;
      return prev.keys.includes(`${i.rule}@${i.elementId ?? ""}`);
    });
    if (recreated.length) reasons.push("a fix recreated the same kind of issue on the same element");
  }
  const loop_guard = reasons.length > 0;
  return {
    verdict: { loop_guard, reasons: [...new Set(reasons)], introduced, ...(loop_guard ? { instruction: GUARD_INSTRUCTION } : {}) },
    state: { history: [...fresh, entry].slice(-10) },
  };
}
