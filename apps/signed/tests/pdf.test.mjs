import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdf, pdfString, signedName } from "../pdf.js";
import { layout, sampleLease, docFromText, fieldLine, PAGE } from "../doc.js";
import { normalize, presetSignature, smooth } from "../signature.js";

const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

/** Parses the cross-reference table and checks every offset lands on its object. */
function checkStructure(text) {
  assert.ok(text.startsWith("%PDF-1.4\n"), "header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "trailer marker");
  const startxref = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(text)?.[1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref", "startxref points at xref");
  const [, first, count] = /^xref\n(\d+) (\d+)\n/.exec(text.slice(startxref)) ?? [];
  assert.equal(Number(first), 0);
  const entries = text.slice(startxref).split("\n").slice(2, 2 + Number(count));
  assert.equal(entries[0], "0000000000 65535 f ");
  for (const [index, entry] of entries.slice(1).entries()) {
    assert.match(entry, /^\d{10} 00000 n $/);
    const offset = Number(entry.slice(0, 10));
    assert.ok(text.startsWith(`${index + 1} 0 obj\n`, offset), `object ${index + 1} at ${offset}`);
  }
  const size = Number(/\/Size (\d+)/.exec(text.slice(startxref))?.[1]);
  assert.equal(size, Number(count));
  // Every stream's /Length matches the bytes between `stream\n` and `\nendstream`.
  for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = match.index + match[0].length;
    assert.equal(text.slice(start + Number(match[1]), start + Number(match[1]) + 10), "\nendstream");
  }
  return Number(count) - 1;
}

const pages = layout(sampleLease);
const line = fieldLine(pages[0], "Borrower signature");
const items = [
  { id: "a", page: 0, kind: "signature", x: line.x1 + 10, y: line.y1 - 60, w: 216, h: 65, strokes: presetSignature.strokes },
  { id: "b", page: 0, kind: "date", x: 540, y: line.y1 - 30, w: 110, h: 28, text: "10/11/2026" },
  { id: "c", page: 0, kind: "text", x: 104, y: 600, w: 220, h: 50, text: "221 Harbor Street, Apt 4B\nPortland, OR 97209" },
];

test("the sample agreement lays out as one page", () => {
  assert.equal(pages.length, 1);
  assert.ok(pages.every((ops) => ops.every((op) => op.kind !== "text" || op.x + 1 >= 0 && op.y < PAGE.height)));
  assert.ok(line && line.x2 > line.x1);
});

test("the PDF's cross-reference table and stream lengths are exact", () => {
  const text = latin1(buildPdf({ title: "lease.pdf", pages, items }));
  const objects = checkStructure(text);
  assert.equal(objects, 6 + pages.length * 2);
  assert.match(text, /\/Count 1/);
  assert.match(text, / c S/, "signature strokes are Bézier paths");
  assert.match(text, /\(10\/11\/2026\) Tj/);
});

test("strings are escaped for PDF", () => {
  assert.equal(pdfString("a(b)c\\"), "(a\\(b\\)c\\\\)");
  assert.equal(pdfString("café ☃"), "(caf\\351 ?)");
  assert.equal(signedName("lease.pdf"), "lease-signed.pdf");
});

test("a plain-text document becomes pages with signature fields", () => {
  const doc = docFromText("note.txt", "My agreement\n\n" + "Lorem ipsum dolor sit amet. ".repeat(400));
  const out = layout(doc);
  assert.ok(out.length > 1);
  assert.equal(out[0][0].text, "My agreement");
  checkStructure(latin1(buildPdf({ title: "note", pages: out, items: [] })));
});

test("drawn strokes normalize into the unit box", () => {
  const result = normalize([[[10, 10], [110, 60]], [[5, 5]]]);
  assert.ok(result);
  assert.equal(result.strokes.length, 1);
  assert.ok(result.strokes[0].flat().every((v) => v >= 0 && v <= 1));
  assert.ok(result.aspect > 1.5);
  assert.equal(normalize([]), null);
  assert.equal(smooth(presetSignature.strokes[0]).curves.length, presetSignature.strokes[0].length - 1);
});

let poppler = true;
try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); } catch { poppler = false; }

test("poppler parses the file and reads its text back", { skip: !poppler && "pdftotext not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "signed-"));
  try {
    const file = join(dir, "lease-signed.pdf");
    writeFileSync(file, buildPdf({ title: "sample-agreement.pdf", pages, items }));
    const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
    assert.match(info, /Pages:\s+1/);
    const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    assert.match(text, /EQUIPMENT LOAN AGREEMENT/);
    assert.match(text, /Borrower printed name/);
    assert.match(text, /Portland, OR 97209/);
    assert.match(text, /10\/11\/2026/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
