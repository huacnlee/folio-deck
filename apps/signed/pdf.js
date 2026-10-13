// @ts-check
// A small PDF 1.4 writer: the laid-out pages as real text in the standard
// Times and Helvetica fonts, rules as strokes, signatures as vector Béziers.
// No dependencies and no gpui imports, so node can test the bytes it makes.
import { PAGE, PT_PER_PX, BASELINE } from "./doc.js";
import { fontSize, TEXT_PAD, TEXT_LINE } from "./items.js";
import { smooth } from "./signature.js";

const PAGE_PT = { width: 612, height: 792 };
const FONTS = { serif: "F1", "serif-bold": "F2", sans: "F3" };
/** Where a sans text line's baseline sits below its top, as a fraction of size. */
const SANS_BASELINE = 0.95;

const num = (value) => {
  const text = (Math.round(value * 100) / 100).toFixed(2);
  return text.replace(/\.?0+$/, "") || "0";
};
const X = (px) => num(px * PT_PER_PX);
const Y = (px) => num(PAGE_PT.height - px * PT_PER_PX);

/** A PDF literal string in WinAnsi; anything outside Latin-1 becomes `?`. */
export function pdfString(text) {
  let out = "(";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code >= 32 && code <= 126) out += char;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, "0")}`;
    else if (char === "’") out += "\\222";
    else if (char === "“") out += "\\223";
    else if (char === "”") out += "\\224";
    else if (char === "—") out += "\\227";
    else out += "?";
  }
  return `${out})`;
}

/** The content stream of one page. @param {import("./doc.js").Op[]} ops @param {import("./items.js").Item[]} items */
export function pageContent(ops, items) {
  const out = [];
  out.push("0.07 0.07 0.08 rg 0.2 0.2 0.22 RG 0.75 w");
  for (const op of ops) {
    if (op.kind === "line") out.push(`${X(op.x1)} ${Y(op.y1)} m ${X(op.x2)} ${Y(op.y2)} l S`);
    else {
      const size = op.size * PT_PER_PX;
      out.push(`BT /${FONTS[op.face]} ${num(size)} Tf ${X(op.x)} ${Y(op.y + op.size * BASELINE)} Td ${pdfString(op.text)} Tj ET`);
    }
  }
  for (const item of items) {
    if (item.kind === "signature") {
      out.push(`q 0.07 0.08 0.26 RG 1 J 1 j ${num(Math.max(0.4, (item.weight ?? 0.035) * item.h * PT_PER_PX))} w`);
      const at = (p) => `${X(item.x + p[0] * item.w)} ${Y(item.y + p[1] * item.h)}`;
      for (const stroke of item.strokes ?? []) {
        if (stroke.length < 2) continue;
        const { start, curves } = smooth(stroke);
        out.push(`${at(start)} m ${curves.map((c) => `${at([c[0], c[1]])} ${at([c[2], c[3]])} ${at([c[4], c[5]])} c`).join(" ")} S`);
      }
      out.push("Q");
    } else {
      const size = fontSize(item);
      for (const [index, line] of (item.text ?? "").split("\n").entries()) {
        const top = item.y + TEXT_PAD + index * size * TEXT_LINE + (size * (TEXT_LINE - 1)) / 2;
        out.push(`BT /F3 ${num(size * PT_PER_PX)} Tf ${X(item.x + TEXT_PAD)} ${Y(top + size * SANS_BASELINE)} Td ${pdfString(line)} Tj ET`);
      }
    }
  }
  return out.join("\n");
}

/**
 * Writes the document as PDF bytes.
 * @param {{ title: string, pages: import("./doc.js").Op[][], items: import("./items.js").Item[], date?: Date }} input
 * @returns {Uint8Array}
 */
export function buildPdf({ title, pages, items, date = new Date() }) {
  /** @type {string[]} Object bodies; object n is objects[n - 1]. */
  const objects = [];
  const add = (body) => objects.push(body) ;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // Pages, filled in once the page objects exist.
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const stamp = `D:${date.getUTCFullYear()}${[date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join("")}Z`;
  add(`<< /Title ${pdfString(title)} /Producer (Signed for gpui-shell) /CreationDate (${stamp}) >>`);
  const info = objects.length;
  const kids = [];
  for (const [index, ops] of pages.entries()) {
    const content = pageContent(ops, items.filter((item) => item.page === index));
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const contentRef = objects.length;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_PT.width} ${PAGE_PT.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentRef} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`;

  // Every byte is below 256, so a string's length is its length in bytes.
  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i);
  return bytes;
}

/** `lease.pdf` → `lease-signed.pdf`. */
export const signedName = (name) => `${name.replace(/\.[^.]+$/, "")}-signed.pdf`;
export { PAGE };
