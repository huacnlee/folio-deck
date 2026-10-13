// @ts-check
// Signs a PDF by incremental update: the original bytes are kept untouched
// and new objects — an appearance stream per signed page, the pages that now
// reference it, a font — are appended with a new cross-reference section.
import { Ref, Name, isStream, displayMatrix, invert, mul, apply, bytesOf } from "./pdfparse.js";
import { smooth } from "./signature.js";
import { fontSize, TEXT_PAD, TEXT_LINE } from "./items.js";
import { pdfString } from "./pdf.js";

const num = (value) => {
  if (!Number.isFinite(value)) return "0";
  const text = (Math.round(value * 1000) / 1000).toFixed(3);
  return text.replace(/\.?0+$/, "") || "0";
};

/** Writes a parsed value back as PDF syntax. */
export function serialize(value, path = []) {
  if (path.includes(value)) throw new Error(`cannot write a cyclic object: ${path.map((v) => Object.keys(v ?? {}).slice(0, 4).join(",")).join(" > ")}`);
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return num(value);
  if (typeof value === "string") return pdfString(value);
  if (value instanceof Ref) return `${value.num} ${value.gen} R`;
  if (value instanceof Name) return `/${value.name.replace(/[^!-~]|[#()<>[\]{}/%]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}`;
  if (value instanceof Uint8Array) return `<${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}>`;
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v, [...path, value])).join(" ")}]`;
  if (isStream(value)) throw new Error("streams are not rewritten");
  if (typeof value === "object" && "op" in value) return String(value.op);
  return `<< ${Object.entries(value).map(([k, v]) => `${serialize(new Name(k))} ${serialize(v, [...path, value])}`).join(" ")} >>`;
}

const hex = (color) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? "");
  return m ? [1, 2, 3].map((i) => num(parseInt(m[i], 16) / 255)).join(" ") : "0.08 0.1 0.3";
};

/**
 * Maps display pixels on a page drawn `scale` px per point to PDF user space.
 * @param {ReturnType<import("./pdfparse.js").PdfDocument["pages"]>[number]} page
 * @param {number} scale
 */
export function pixelToPdf(page, scale) {
  const inverse = invert(displayMatrix(page));
  return {
    matrix: inverse,
    /** @param {number} x @param {number} y */
    point: (x, y) => apply(inverse, x / scale, y / scale),
  };
}

/**
 * The drawing operators for one page's items, in PDF user space.
 * @param {import("./items.js").Item[]} items
 * @param {ReturnType<import("./pdfparse.js").PdfDocument["pages"]>[number]} page
 * @param {number} scale display pixels per PDF point
 * @param {string} font the resource name of Helvetica
 */
export function itemsContent(items, page, scale, font) {
  const map = pixelToPdf(page, scale);
  const out = [];
  for (const item of items) {
    if (item.kind === "signature") {
      const width = (item.weight ?? 0.035) * item.h / scale;
      out.push(`q ${hex(item.color)} RG 1 J 1 j ${num(Math.max(0.4, width))} w`);
      const at = (p) => map.point(item.x + p[0] * item.w, item.y + p[1] * item.h).map(num).join(" ");
      for (const stroke of item.strokes ?? []) {
        if (stroke.length < 2) continue;
        const { start, curves } = smooth(stroke);
        out.push(`${at(start)} m ${curves.map((c) => `${at([c[0], c[1]])} ${at([c[2], c[3]])} ${at([c[4], c[5]])} c`).join(" ")} S`);
      }
      out.push("Q");
    } else {
      const size = fontSize(item);
      const lines = (item.text ?? "").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line) continue;
        const top = item.y + TEXT_PAD + index * size * TEXT_LINE + (size * (TEXT_LINE - 1)) / 2;
        // Glyph space (y up) → display pixels (y down) → PDF user space.
        const glyph = [size, 0, 0, -size, item.x + TEXT_PAD, top + size * 0.95];
        const tm = mul(mul(glyph, [1 / scale, 0, 0, 1 / scale, 0, 0]), map.matrix);
        out.push(`BT 0.07 0.07 0.08 rg /${font} 1 Tf ${tm.map(num).join(" ")} Tm ${pdfString(line)} Tj ET`);
      }
    }
  }
  return out.join("\n");
}

/**
 * Appends the items to `bytes` as an incremental update.
 * @param {Uint8Array} bytes the original file
 * @param {import("./pdfparse.js").PdfDocument} doc the same file, parsed
 * @param {ReturnType<import("./pdfparse.js").PdfDocument["pages"]>} pages
 * @param {import("./items.js").Item[]} items
 * @param {(pageIndex: number) => number} scaleOf display pixels per point
 * @returns {Uint8Array}
 */
export function signIncrementally(bytes, doc, pages, items, scaleOf) {
  let next = doc.size;
  /** @type {[number, number, string][]} [num, gen, body] */
  const objects = [];
  const stream = (content) => {
    const ref = new Ref(next++, 0);
    objects.push([ref.num, 0, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    return ref;
  };
  const touched = [...new Set(items.map((item) => item.page))].filter((i) => pages[i]).sort((a, b) => a - b);
  if (!touched.length) throw new Error("there is nothing to sign");

  const fontRef = new Ref(next++, 0);
  objects.push([fontRef.num, 0, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"]);
  // Wrapping the original content in q … Q means whatever state it leaves
  // behind — a stray transform, a clip — cannot move what is drawn after it.
  const save = stream("q");
  const FONT = "SgnHelv";

  for (const index of touched) {
    const page = pages[index];
    if (!page.ref) throw new Error(`page ${index + 1} is not an indirect object`);
    const content = itemsContent(items.filter((item) => item.page === index), page, scaleOf(index), FONT);
    const added = stream(`Q\n${content}\n`);
    const original = doc.get(page.dict.Contents);
    const contents = original === undefined || original === null ? []
      : Array.isArray(original) ? original
        : page.dict.Contents instanceof Ref ? [page.dict.Contents] : [];
    const resources = { ...page.resources };
    resources.Font = { ...(doc.get(resources.Font) ?? {}), [FONT]: fontRef };
    const dict = { ...page.dict, Contents: [save, ...contents, added], Resources: resources };
    objects.push([page.ref.num, page.ref.gen, serialize(dict)]);
  }

  const trailer = {
    Size: Math.max(doc.size, next),
    Root: doc.trailer.Root,
    ...(doc.trailer.Info ? { Info: doc.trailer.Info } : {}),
    ...(doc.trailer.ID ? { ID: doc.trailer.ID } : {}),
  };
  const repaired = doc.repaired || doc.startxref < 0;
  if (!repaired) trailer.Prev = doc.startxref;

  const lastByte = bytes[bytes.length - 1];
  let body = lastByte === 10 || lastByte === 13 ? "" : "\n";
  const base = bytes.length;
  /** @type {Map<number, { offset: number, gen: number }>} */
  const entries = new Map();
  for (const [n, gen, text] of objects) {
    entries.set(n, { offset: base + body.length, gen });
    body += `${n} ${gen} obj\n${text}\nendobj\n`;
  }
  // A repaired file's old cross-reference cannot be chained to, so the new
  // section lists every object the rescan found as well.
  if (repaired) {
    for (const [n, entry] of doc.xref) if (entry.type === "n" && !entries.has(n)) entries.set(n, { offset: entry.offset, gen: entry.gen });
  }

  if (doc.usesXrefStream && !repaired) {
    // A file that indexes itself with a cross-reference stream is updated with one.
    const self = next++;
    trailer.Size = Math.max(trailer.Size, next);
    entries.set(self, { offset: base + body.length, gen: 0 });
    const nums = [...entries.keys()].sort((a, b) => a - b);
    const index = [];
    let data = "";
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j += 1;
      index.push(nums[i], j - i + 1);
      for (let k = i; k <= j; k += 1) {
        const { offset, gen } = /** @type {{ offset: number, gen: number }} */ (entries.get(nums[k]));
        data += String.fromCharCode(1, (offset >>> 24) & 255, (offset >>> 16) & 255, (offset >>> 8) & 255, offset & 255, (gen >> 8) & 255, gen & 255);
      }
      i = j + 1;
    }
    const dict = { Type: new Name("XRef"), ...trailer, W: [1, 4, 2], Index: index, Length: data.length };
    const xrefAt = base + body.length;
    body += `${self} 0 obj\n${serialize(dict)}\nstream\n${data}\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`;
  } else {
    const xrefAt = base + body.length;
    const nums = [...entries.keys()].sort((a, b) => a - b);
    body += "xref\n";
    if (repaired) body += "0 1\n0000000000 65535 f \n";
    for (let i = 0; i < nums.length;) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j += 1;
      body += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k += 1) {
        const { offset, gen } = /** @type {{ offset: number, gen: number }} */ (entries.get(nums[k]));
        body += `${String(offset).padStart(10, "0")} ${String(gen).padStart(5, "0")} n \n`;
      }
      i = j + 1;
    }
    body += `trailer\n${serialize(trailer)}\nstartxref\n${xrefAt}\n%%EOF\n`;
  }

  const tail = bytesOf(body);
  const out = new Uint8Array(bytes.length + tail.length);
  out.set(bytes, 0);
  out.set(tail, bytes.length);
  return out;
}
