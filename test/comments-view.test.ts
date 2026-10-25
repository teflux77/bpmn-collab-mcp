import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  OVERLAY_TYPE,
  PREFS_KEY,
  applyOverlays,
  bubbleOffsets,
  filterComments,
  loadPrefs,
  orphans,
  planOverlays,
  preview,
  savePrefs,
  svgWithComments,
  thread,
  type Bounds,
  type CanvasComment,
  type OverlaysLike,
  type StorageLike,
} from "../ui/comments-view.js";

const c = (id: string, elementId: string, o: Partial<CanvasComment> = {}): CanvasComment => ({
  id, elementId, author: "human:ana", text: `comment ${id}`, status: "open", createdAt: `2026-10-25T10:00:0${id.length}Z`, ...o,
});
const box = (x: number, y: number): Bounds => ({ x, y, width: 100, height: 80 });

/** In-memory storage, optionally broken like a sandboxed iframe's. */
function memoryStorage(broken = false): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => {
      if (broken) throw new Error("SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (broken) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
  };
}

/** Records overlays.add / remove like diagram-js does (overlays are keyed by element id). */
function fakeOverlays() {
  const added: { element: string; type: string; overlay: any }[] = [];
  const api: OverlaysLike = {
    add: (element, type, overlay) => (added.push({ element, type, overlay }), `ov${added.length}`),
    remove: ({ type }) => {
      for (let i = added.length - 1; i >= 0; i--) if (added[i].type === type) added.splice(i, 1);
    },
  };
  return { api, added };
}

describe("comment preferences", () => {
  it("apply on reload: what was saved is read back", () => {
    const storage = memoryStorage();
    expect(savePrefs(storage, { show: false, status: "all", author: "ai" })).toBe(true);
    expect(loadPrefs(storage)).toEqual({ show: false, status: "all", author: "ai" });
    expect(storage.data.has(PREFS_KEY)).toBe(true);
  });

  it("fall back to defaults when storage is missing, throws or holds garbage", () => {
    expect(loadPrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(memoryStorage(true))).toEqual(DEFAULT_PREFS);
    expect(savePrefs(memoryStorage(true), DEFAULT_PREFS)).toBe(false);
    const s = memoryStorage();
    s.setItem(PREFS_KEY, "{not json");
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
    s.setItem(PREFS_KEY, JSON.stringify({ show: "yes", status: "weird", author: "ai" }));
    expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, author: "ai" });
  });
});

describe("filters, previews, threads", () => {
  const list = [c("1", "T1"), c("2", "T1", { author: "ai" }), c("3", "T2", { status: "resolved" })];

  it("filter by status and by author", () => {
    expect(filterComments(list, { ...DEFAULT_PREFS }).map((x) => x.id)).toEqual(["1", "2"]);
    expect(filterComments(list, { show: true, status: "resolved", author: "all" }).map((x) => x.id)).toEqual(["3"]);
    expect(filterComments(list, { show: true, status: "all", author: "ai" }).map((x) => x.id)).toEqual(["2"]);
    expect(filterComments(list, { show: true, status: "all", author: "human" }).map((x) => x.id)).toEqual(["1", "3"]);
  });

  it("cut previews cleanly at a word boundary", () => {
    expect(preview("short text")).toBe("short text");
    expect(preview("Who approves the order when the amount is above the limit?", 30)).toBe("Who approves the order when…");
  });

  it("keep orphan comments (element deleted) instead of dropping them", () => {
    expect(orphans(list, new Set(["T1"])).map((x) => [x.id, x.elementId])).toEqual([["3", "T2"]]);
  });

  it("order a thread oldest first", () => {
    const t = thread([c("22", "T1"), c("1", "T1"), c("x", "T9")], "T1");
    expect(t.map((x) => x.id)).toEqual(["1", "22"]);
  });
});

describe("overlays on the canvas", () => {
  const elements = new Map([["T1", box(100, 100)], ["T2", box(400, 100)], ["T3", box(140, 110)]]);

  it("attach each bubble to its element id with a bounded scale, so it follows the element", () => {
    const { api, added } = fakeOverlays();
    applyOverlays(api, planOverlays([c("1", "T1"), c("2", "T2")], DEFAULT_PREFS, elements), () => "<div/>");
    expect(added.map((a) => [a.element, a.type])).toEqual([["T1", OVERLAY_TYPE], ["T2", OVERLAY_TYPE]]);
    expect(added[0].overlay.scale).toEqual({ min: 0.8, max: 1.4 });
  });

  it("re-render after a move recomputes placement for the new position", () => {
    const { api, added } = fakeOverlays();
    const comments = [c("1", "T1"), c("2", "T3")];
    applyOverlays(api, planOverlays(comments, DEFAULT_PREFS, elements), () => null);
    const before = added.find((a) => a.element === "T3")!.overlay.position.top;
    const moved = new Map(elements).set("T3", box(700, 400)); // T3 dragged far away from T1
    applyOverlays(api, planOverlays(comments, DEFAULT_PREFS, moved), () => null);
    expect(added).toHaveLength(2); // old overlays removed, not duplicated
    const after = added.find((a) => a.element === "T3")!.overlay.position.top;
    expect(after).toBeGreaterThan(before); // no longer pushed up by T1's bubble
  });

  it("move a bubble up when it would overlap a neighbour's", () => {
    const offsets = bubbleOffsets(new Map([["T1", box(100, 100)], ["T3", box(140, 110)], ["T2", box(600, 100)]]));
    expect(offsets.get("T1")).toBe(0);
    expect(offsets.get("T3")).toBeGreaterThan(0);
    expect(offsets.get("T2")).toBe(0);
  });

  it("draw nothing when hidden, and skip replies and orphans", () => {
    expect(planOverlays([c("1", "T1")], { ...DEFAULT_PREFS, show: false }, elements)).toEqual([]);
    const plans = planOverlays([c("1", "T1"), c("2", "T1", { parentId: "1" }), c("3", "Gone")], DEFAULT_PREFS, elements);
    expect(plans.map((p) => [p.elementId, p.comments.map((x) => x.id)])).toEqual([["T1", ["1"]]]);
  });

  it("can add the bubbles to an exported SVG, escaped, without touching it when there are none", () => {
    const svg = '<svg viewBox="0 0 800 600"><g class="layer"/></svg>';
    const plans = planOverlays([c("1", "T1", { text: "<b>is this right?</b>" })], DEFAULT_PREFS, elements);
    const out = svgWithComments(svg, plans, elements);
    expect(out).toMatch(/<g class="comments">.*&lt;b&gt;is this right\?&lt;\/b&gt;.*<\/g><\/svg>$/);
    expect(svgWithComments(svg, [], elements)).toBe(svg);
  });
});
