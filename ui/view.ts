/**
 * Viewport helpers. bpmn-js opens a drill-down plane (collapsed sub-process) for the first time at
 * the origin, zoom 1: content drawn far from the origin is then off screen and the plane looks
 * empty. The canvas re-fits in that case (see main.ts, "root.set").
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of shapes and connections (diagram coordinates), or undefined when there is nothing. */
export function contentBox(elements: { x?: number; y?: number; width?: number; height?: number; waypoints?: { x: number; y: number }[] }[]): Box | undefined {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const e of elements) {
    if (e.waypoints?.length) {
      for (const p of e.waypoints) xs.push(p.x), ys.push(p.y);
    } else if (e.width !== undefined && e.height !== undefined && e.x !== undefined && e.y !== undefined) {
      xs.push(e.x, e.x + e.width);
      ys.push(e.y, e.y + e.height);
    }
  }
  if (!xs.length) return undefined;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * True when too little of the content is visible to read the plane: less than `minShare` of the
 * content box intersects the viewbox (diagram coordinates, as returned by canvas.viewbox()).
 */
export function needsRefit(viewbox: Box, content: Box | undefined, minShare = 0.25) {
  if (!content || content.width * content.height === 0) return false;
  const w = Math.max(0, Math.min(viewbox.x + viewbox.width, content.x + content.width) - Math.max(viewbox.x, content.x));
  const h = Math.max(0, Math.min(viewbox.y + viewbox.height, content.y + content.height) - Math.max(viewbox.y, content.y));
  return (w * h) / (content.width * content.height) < minShare;
}

export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Viewbox (diagram coordinates) that fits `content` in the free part of the canvas: the container
 * minus `insets` in screen pixels (palette on the left, zoom bar on top, margins). The content is
 * centred in that free area and never zoomed above `maxZoom`.
 */
export function fitViewbox(content: Box, container: { width: number; height: number }, insets: Insets, maxZoom = 1.5): Box & { scale: number } {
  const freeW = Math.max(40, container.width - insets.left - insets.right);
  const freeH = Math.max(40, container.height - insets.top - insets.bottom);
  const scale = Math.min(maxZoom, freeW / Math.max(content.width, 1), freeH / Math.max(content.height, 1));
  // screen position of the content's top-left corner, centred in the free area
  const left = insets.left + (freeW - content.width * scale) / 2;
  const top = insets.top + (freeH - content.height * scale) / 2;
  return { x: content.x - left / scale, y: content.y - top / scale, width: container.width / scale, height: container.height / scale, scale };
}
