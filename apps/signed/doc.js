// @ts-check
// Documents, their page layout, and the font metrics both the screen and the
// PDF writer measure with. Pure JavaScript: no gpui imports, so node can test it.

/** A US Letter page drawn 860 px wide; the PDF is 612 × 792 pt. */
export const PAGE = { width: 860, height: Math.round(860 * 11 / 8.5) };
export const PT_PER_PX = 612 / PAGE.width;

const MARGIN = { left: 99, right: 760, top: 121, bottom: 1040 };

// Advance widths in 1/1000 em for ASCII 32…126, from the Adobe core-font AFMs.
const TIMES_ROMAN = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
const TIMES_BOLD = [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520];
const HELVETICA = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

/** @typedef {"serif" | "serif-bold" | "sans"} Face */
const tables = { serif: TIMES_ROMAN, "serif-bold": TIMES_BOLD, sans: HELVETICA };

/** Width of `text` in px at `size` px. @param {string} text @param {number} size @param {Face} face */
export function measure(text, size, face = "serif") {
  const table = tables[face];
  let units = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32] : 556;
  }
  return (units * size) / 1000;
}

/** Greedy word wrap. @param {string} text @param {number} size @param {number} width @param {Face} face */
export function wrap(text, size, width, face = "serif") {
  /** @type {string[]} */
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next, size, face) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * What a page is drawn from, in page pixels. A `text` op's `y` is the top of
 * its line box, which is `size * LINE` tall.
 * @typedef {{ kind: "text", x: number, y: number, size: number, face: Face, text: string }
 *   | { kind: "line", x1: number, y1: number, x2: number, y2: number, field?: string }} Op
 */
export const LINE = 1.3;
/** Where the baseline sits below the top of a line box, as a fraction of size. */
export const BASELINE = 0.95;

/**
 * @typedef {{ t: "title", text: string }
 *   | { t: "para", heading?: string, text: string }
 *   | { t: "fields", rows: { label: string, span?: "left" | "right" | "full", gap?: number }[][] }
 *   | { t: "break" }} Block
 * @typedef {{ name: string, blocks: Block[] }} Doc
 */

/** Lays a document out into pages of ops. @param {Doc} doc @returns {Op[][]} */
export function layout(doc) {
  /** @type {Op[][]} */
  const pages = [[]];
  let y = MARGIN.top;
  const width = MARGIN.right - MARGIN.left;
  const page = () => pages[pages.length - 1];
  const newPage = () => { pages.push([]); y = MARGIN.top; };
  const room = (height) => { if (y + height > MARGIN.bottom && page().length) newPage(); };

  for (const block of doc.blocks) {
    if (block.t === "break") { newPage(); continue; }
    if (block.t === "title") {
      const size = 23;
      room(size * 2);
      const w = measure(block.text, size, "serif-bold");
      page().push({ kind: "text", x: (PAGE.width - w) / 2, y, size, face: "serif-bold", text: block.text });
      y += size * 2.1;
      continue;
    }
    if (block.t === "para") {
      const size = 15;
      // The heading runs into the first line, as clause numbers do in a lease.
      const lead = block.heading ? `${block.heading} ` : "";
      const lines = wrap(lead + block.text, size, width);
      for (const [index, text] of lines.entries()) {
        room(size * LINE);
        if (index === 0 && lead) {
          const leadWidth = measure(lead, size, "serif-bold");
          page().push({ kind: "text", x: MARGIN.left, y, size, face: "serif-bold", text: lead.trimEnd() });
          page().push({ kind: "text", x: MARGIN.left + leadWidth, y, size, face: "serif", text: text.slice(lead.length) });
        } else {
          page().push({ kind: "text", x: MARGIN.left, y, size, face: "serif", text });
        }
        y += size * LINE;
      }
      y += size * 0.8;
      continue;
    }
    if (block.t === "fields") {
      for (const row of block.rows) {
        const gap = row[0].gap ?? 82;
        room(gap + 30);
        y += gap;
        for (const field of row) {
          const [x1, x2] = field.span === "right" ? [540, MARGIN.right]
            : field.span === "full" ? [MARGIN.left, MARGIN.right] : [MARGIN.left, 498];
          page().push({ kind: "line", x1, y1: y, x2, y2: y, field: field.label });
          page().push({ kind: "text", x: x1, y: y + 6, size: 14, face: "serif", text: field.label });
        }
      }
      y += 40;
    }
  }
  return pages;
}

/** Turns a plain-text file into a document: blank lines separate paragraphs. */
export function docFromText(name, text) {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  const title = paragraphs.length > 1 && paragraphs[0].length < 70 ? paragraphs.shift() : name.replace(/\.[^.]+$/, "");
  /** @type {Block[]} */
  const blocks = [{ t: "title", text: title.replace(/^#+\s*/, "") }];
  for (const text of paragraphs) blocks.push({ t: "para", text: text.replace(/^#+\s*/, "") });
  blocks.push({ t: "fields", rows: [[{ label: "Signature" }, { label: "Date", span: "right" }], [{ label: "Printed name" }]] });
  return { name, blocks };
}

/** The built-in sample: a one-page agreement with signature fields. @type {Doc} */
export const sampleLease = {
  name: "sample-agreement.pdf",
  blocks: [
    { t: "title", text: "EQUIPMENT LOAN AGREEMENT" },
    { t: "para", text: "This agreement is made between Northwind Studio (\"Lender\") and the person signing below (\"Borrower\") for the loan of one laptop computer, serial number NW-2026-0417, together with its charger." },
    { t: "para", heading: "1. Term.", text: "The equipment is lent from the date of signing until December 31, 2026, and shall be returned on request or at the end of the term." },
    { t: "para", heading: "2. Care.", text: "Borrower shall keep the equipment in good condition and report any loss or damage within two business days." },
    { t: "para", heading: "3. Return.", text: "Borrower shall return the equipment in the condition received, reasonable wear excepted." },
    {
      t: "fields",
      rows: [
        [{ label: "Borrower signature", gap: 90 }, { label: "Date", span: "right" }],
        [{ label: "Borrower printed name", gap: 80 }],
        [{ label: "Lender signature", gap: 90 }, { label: "Date", span: "right" }],
      ],
    },
  ],
};

/** The first field line labelled `label` on a page, counting from `nth`. */
export function fieldLine(ops, label, nth = 0) {
  return ops.filter((op) => op.kind === "line" && op.field === label)[nth];
}
