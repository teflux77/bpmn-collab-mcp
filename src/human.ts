/**
 * Human-side operations, shared by the REST API (standalone canvas) and the app-only
 * MCP tools (canvas rendered inline in Claude). Results carry an HTTP-like status.
 */
import { Store, StoreError, type Comment } from "./store.js";
import { validateXml } from "./validate.js";
import { parse } from "./model.js";

export interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

const fromStoreError = (e: unknown): Outcome => {
  if (e instanceof StoreError) return { status: e.code, body: { error: e.message } };
  throw e;
};

/** Returns an error message if elementId is not an element of the diagram's current XML. */
export async function checkAnchor(xml: string, elementId: string) {
  const { elementsById } = await parse(xml);
  return elementsById[elementId] ? undefined : `Element ${elementId} does not exist in the current diagram`;
}

export async function loadForHuman(store: Store, id: string): Promise<Outcome> {
  const d = store.get(id);
  if (!d) return { status: 404, body: { error: "not found" } };
  const rev = store.latest(d);
  return {
    status: 200,
    body: { id: d.id, name: d.name, version: rev.version, lastAuthor: rev.author, xml: rev.xml, comments: d.comments, issues: await validateXml(rev.xml) },
  };
}

/** Human saves are always stored (never lose human work) unless the XML does not parse at all. */
export async function saveFromHuman(store: Store, id: string, xml: unknown, baseVersion: unknown, author?: string): Promise<Outcome> {
  if (typeof xml !== "string" || typeof baseVersion !== "number")
    return { status: 400, body: { error: "xml (string) and baseVersion (number) are required" } };
  const issues = await validateXml(xml);
  if (issues.some((i) => i.rule === "xml-parse")) return { status: 400, body: { error: "XML does not parse", issues } };
  try {
    const rev = store.update(id, xml, baseVersion, `human:${author ?? "anonymous"}`);
    return { status: 200, body: { version: rev.version, issues } };
  } catch (e) {
    return fromStoreError(e);
  }
}

export async function commentFromHuman(
  store: Store,
  id: string,
  c: { elementId?: unknown; text?: unknown; parentId?: unknown; kind?: unknown; author?: string },
): Promise<Outcome> {
  const d = store.get(id);
  if (!d) return { status: 404, body: { error: "not found" } };
  if (typeof c.elementId !== "string" || typeof c.text !== "string" || !c.text.trim())
    return { status: 400, body: { error: "elementId and text are required" } };
  const bad = await checkAnchor(store.latest(d).xml, c.elementId);
  if (bad) return { status: 400, body: { error: bad } };
  const comment = store.addComment(d.id, {
    elementId: c.elementId,
    text: c.text,
    parentId: typeof c.parentId === "string" ? c.parentId : undefined,
    kind: c.kind === "ai-request" ? "ai-request" : "note",
    author: `human:${c.author ?? "anonymous"}`,
  });
  return { status: 200, body: { ...comment } };
}

export function setStatusFromHuman(store: Store, id: string, commentId: string, status: unknown, author?: string): Outcome {
  try {
    const s: Comment["status"] = status === "open" ? "open" : "resolved";
    return { status: 200, body: { ...store.setCommentStatus(id, commentId, s, `human:${author ?? "anonymous"}`) } };
  } catch (e) {
    return fromStoreError(e);
  }
}
