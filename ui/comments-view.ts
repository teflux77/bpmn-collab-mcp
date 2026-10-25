/**
 * Comments drawn on the canvas, as diagram-js overlays attached to their element (diagram-js moves
 * them with the element and scales them within bounds). Pure logic here: filtering, previews,
 * orphans, placement of nearby bubbles, preferences, SVG export. The DOM is created by the caller.
 */

export interface CanvasComment {
  id: string;
  elementId: string;
  author: string; // "ai" or "human:<name>"
  text: string;
  status: "open" | "resolved";
  kind?: "note" | "ai-request";
  parentId?: string;
  createdAt: string;
}

export interface CommentPrefs {
  show: boolean;
  status: "open" | "resolved" | "all";
  author: "all" | "human" | "ai";
}

export const DEFAULT_PREFS: CommentPrefs = { show: true, status: "open", author: "all" };
export const PREFS_KEY = "bpmn-collab:comment-prefs";

/** Minimal Storage subset; localStorage may be missing or throw in a sandboxed iframe. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPrefs(storage?: StorageLike | null): CommentPrefs {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw);
    return {
      show: typeof p.show === "boolean" ? p.show : DEFAULT_PREFS.show,
      status: ["open", "resolved", "all"].includes(p.status) ? p.status : DEFAULT_PREFS.status,
      author: ["all", "human", "ai"].includes(p.author) ? p.author : DEFAULT_PREFS.author,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Returns false when the preference could not be stored (the page keeps working). */
export function savePrefs(storage: StorageLike | null | undefined, prefs: CommentPrefs) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
    return !!storage;
  } catch {
    return false;
  }
}

export const isAi = (c: CanvasComment) => c.author === "ai";

export function filterComments(comments: CanvasComment[], prefs: CommentPrefs) {
  return comments.filter(
    (c) =>
      (prefs.status === "all" || c.status === prefs.status) &&
      (prefs.author === "all" || (prefs.author === "ai") === isAi(c)),
  );
}

/** First words of a comment, cut at a word boundary. */
export function preview(text: string, max = 48) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

export const authorLabel = (c: CanvasComment) => (isAi(c) ? "IA" : c.author.replace(/^human:/, ""));

/** Comments whose element no longer exists: kept and listed, never dropped. */
export function orphans(comments: CanvasComment[], existingIds: Set<string>) {
  return comments.filter((c) => !existingIds.has(c.elementId));
}

/** Thread of one element: oldest first. */
export const thread = (comments: CanvasComment[], elementId: string) =>
  comments.filter((c) => c.elementId === elementId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bubble size in diagram units at zoom 1 (used to keep nearby bubbles apart). */
export const BUBBLE = { width: 170, height: 26, gap: 4 };

/**
 * Bubbles sit above the top-right corner of their element. When two would overlap, the later one
 * (top to bottom, left to right) moves up. Returns the extra upward offset per element id.
 */
export function bubbleOffsets(anchors: Map<string, Bounds>, bubble = BUBBLE) {
  const placed: Bounds[] = [];
  const offsets = new Map<string, number>();
  const ordered = [...anchors.entries()].sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  for (const [id, b] of ordered) {
    let dy = 0;
    const box = (): Bounds => ({ x: b.x + b.width - bubble.width / 2, y: b.y - bubble.height - dy, width: bubble.width, height: bubble.height });
    const hit = (r: Bounds) => placed.some((p) => r.x < p.x + p.width && p.x < r.x + r.width && r.y < p.y + p.height && p.y < r.y + r.height);
    for (let i = 0; i < 20 && hit(box()); i++) dy += bubble.height + bubble.gap;
    placed.push(box());
    offsets.set(id, dy);
  }
  return offsets;
}

export interface OverlayPlan {
  elementId: string;
  /** Root (non-reply) comments shown for this element, most recent last. */
  comments: CanvasComment[];
  /** diagram-js overlay options: attached to the element, scaled within bounds. */
  options: { position: { top: number; right: number }; scale: { min: number; max: number } };
}

/** What to draw: one overlay per element with visible comments, offset to avoid neighbours. */
export function planOverlays(comments: CanvasComment[], prefs: CommentPrefs, elements: Map<string, Bounds>): OverlayPlan[] {
  if (!prefs.show) return [];
  const visible = filterComments(comments, prefs).filter((c) => elements.has(c.elementId) && !c.parentId);
  const byElement = new Map<string, CanvasComment[]>();
  for (const c of visible) byElement.set(c.elementId, [...(byElement.get(c.elementId) ?? []), c]);
  const offsets = bubbleOffsets(new Map([...byElement.keys()].map((id) => [id, elements.get(id)!])));
  return [...byElement].map(([elementId, list]) => ({
    elementId,
    comments: list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    options: { position: { top: -BUBBLE.height - 4 - (offsets.get(elementId) ?? 0), right: BUBBLE.width / 2 }, scale: { min: 0.8, max: 1.4 } },
  }));
}

/** The part of diagram-js Overlays used here. */
export interface OverlaysLike {
  add(element: string, type: string, overlay: { position: object; html: unknown; scale?: object }): string;
  remove(filter: { type: string }): void;
}

export const OVERLAY_TYPE = "comment-bubble";

/** Replaces the comment overlays; `toHtml` builds the bubble element (DOM in the page, a stub in tests). */
export function applyOverlays(overlays: OverlaysLike, plans: OverlayPlan[], toHtml: (plan: OverlayPlan) => unknown) {
  overlays.remove({ type: OVERLAY_TYPE });
  for (const plan of plans) overlays.add(plan.elementId, OVERLAY_TYPE, { ...plan.options, html: toHtml(plan) });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Adds the comment bubbles to an exported SVG (bpmn-js keeps diagram coordinates in saveSVG). */
export function svgWithComments(svg: string, plans: OverlayPlan[], elements: Map<string, Bounds>) {
  const notes = plans.flatMap((p) => {
    const b = elements.get(p.elementId)!;
    return p.comments.map((c, i) => {
      const x = b.x + b.width - BUBBLE.width / 2;
      const y = b.y + p.options.position.top - i * (BUBBLE.height + BUBBLE.gap);
      const fill = c.status === "resolved" ? "#eeeeee" : isAi(c) ? "#e7edff" : "#fff1e6";
      const stroke = c.status === "resolved" ? "#bbbbbb" : isAi(c) ? "#4c6ef5" : "#e8590c";
      return (
        `<g class="comment"><rect x="${x}" y="${y}" width="${BUBBLE.width}" height="${BUBBLE.height - 6}" rx="6" fill="${fill}" stroke="${stroke}"/>` +
        `<text x="${x + 6}" y="${y + 14}" font-family="sans-serif" font-size="11" fill="#222">${esc(`${authorLabel(c)}: ${preview(c.text, 30)}`)}</text></g>`
      );
    });
  });
  if (!notes.length) return svg;
  const at = svg.lastIndexOf("</svg>");
  return `${svg.slice(0, at)}<g class="comments">${notes.join("")}</g>${svg.slice(at)}`;
}
