// @ts-check
// Handwritten strokes: kept as point lists in a unit box (0…1 on both axes,
// y down), smoothed into cubic Béziers the same way for the screen and the PDF.

/** @typedef {[number, number][]} Stroke */
/** @typedef {{ id: string, name: string, aspect: number, strokes: Stroke[], color?: string, weight?: number }} Signature */

/**
 * Catmull-Rom through the points, as cubic segments.
 * @param {Stroke} points
 * @returns {{ start: [number, number], curves: [number, number, number, number, number, number][] }}
 */
export function smooth(points) {
  const curves = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    curves.push(/** @type {[number, number, number, number, number, number]} */ ([
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    ]));
  }
  return { start: points[0], curves };
}

/**
 * Fits raw strokes drawn in pixels into the unit box, keeping their shape.
 * Returns null when there is nothing to keep.
 * @param {Stroke[]} strokes
 * @returns {{ aspect: number, height: number, strokes: Stroke[] } | null}
 */
export function normalize(strokes) {
  const kept = strokes.filter((stroke) => stroke.length > 1);
  if (!kept.length) return null;
  const xs = kept.flat().map((p) => p[0]);
  const ys = kept.flat().map((p) => p[1]);
  const pad = 4;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const width = Math.max(Math.max(...xs) + pad - minX, 1);
  const height = Math.max(Math.max(...ys) + pad - minY, 1);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    aspect: width / height,
    height,
    strokes: kept.map((stroke) => stroke.map(([x, y]) => /** @type {[number, number]} */ ([round((x - minX) / width), round((y - minY) / height)]))),
  };
}

/** Drops points closer than `min` px to the previous one. */
export function addPoint(stroke, point, min = 2) {
  const last = stroke[stroke.length - 1];
  if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= min) stroke.push(point);
}

/** The saved signature the sample lease ships with. @type {Signature} */
export const presetSignature = {
  id: "alex-morgan",
  name: "Alex Morgan",
  aspect: 3.3,
  color: "#1f2a6b",
  weight: 0.035,
  strokes: [
    [[0.02, 0.92], [0.06, 0.6], [0.1, 0.28], [0.135, 0.05], [0.16, 0.3], [0.18, 0.6], [0.2, 0.9]],
    [[0.05, 0.62], [0.12, 0.6], [0.19, 0.58], [0.23, 0.52], [0.25, 0.32], [0.245, 0.18], [0.232, 0.34], [0.24, 0.62], [0.255, 0.84], [0.28, 0.78], [0.3, 0.62], [0.322, 0.56], [0.33, 0.64], [0.31, 0.74], [0.305, 0.66], [0.335, 0.6], [0.36, 0.64], [0.38, 0.78], [0.4, 0.66], [0.42, 0.58]],
    [[0.37, 0.56], [0.395, 0.66], [0.42, 0.8]],
    [[0.44, 0.9], [0.46, 0.5], [0.49, 0.1], [0.52, 0.45], [0.55, 0.75], [0.58, 0.4], [0.61, 0.08], [0.63, 0.45], [0.645, 0.86], [0.66, 0.7], [0.68, 0.62], [0.7, 0.7], [0.69, 0.82], [0.67, 0.78], [0.68, 0.65], [0.72, 0.66], [0.74, 0.62], [0.76, 0.72], [0.78, 0.62], [0.8, 0.66], [0.82, 0.8], [0.8, 0.72], [0.83, 0.62], [0.85, 0.72], [0.845, 0.96], [0.825, 0.99], [0.83, 0.85], [0.87, 0.7], [0.89, 0.62], [0.91, 0.7], [0.93, 0.62], [0.96, 0.6], [0.99, 0.63]],
    [[0.12, 0.9], [0.35, 0.87], [0.6, 0.83], [0.85, 0.77], [0.95, 0.75]],
  ],
};
