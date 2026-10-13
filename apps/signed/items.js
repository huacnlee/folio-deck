// @ts-check
// What a person places on a page. Positions are page pixels (see doc.js PAGE).
import { measure } from "./doc.js";

/**
 * @typedef {{
 *   id: string, page: number, kind: "signature" | "text" | "date",
 *   x: number, y: number, w: number, h: number,
 *   text?: string, strokes?: import("./signature.js").Stroke[],
 *   color?: string, weight?: number
 * }} Item
 */

/** Inner padding of a text box, in page pixels. */
export const TEXT_PAD = 4;
export const TEXT_LINE = 1.25;

/** The text size a box of this height holds. @param {Item} item */
export function fontSize(item) {
  const lines = Math.max(1, (item.text ?? "").split("\n").length);
  return Math.max(6, (item.h - TEXT_PAD * 2) / lines / TEXT_LINE);
}

/** Resizes a text box to its content at its current size. @param {Item} item */
export function fitText(item) {
  const size = fontSize(item);
  const widest = Math.max(...(item.text ?? "").split("\n").map((line) => measure(line, size, "sans")));
  item.w = Math.max(24, Math.ceil(widest + TEXT_PAD * 2 + 2));
}

/** A text box sized for `text` at `size`. */
export function textBox(text, size) {
  const lines = text.split("\n").length;
  return { w: Math.ceil(Math.max(...text.split("\n").map((l) => measure(l, size, "sans"))) + TEXT_PAD * 2 + 2), h: Math.ceil(lines * size * TEXT_LINE + TEXT_PAD * 2) };
}

/** MM/DD/YYYY, as US lease forms write it. @param {Date} date */
export const formatDate = (date) =>
  `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
