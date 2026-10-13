import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, deflateRawSync, constants } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflate } from "../inflate.js";
import { openPdf, PdfDocument, displayMatrix, apply, interpretPage } from "../pdfparse.js";
import { signIncrementally, pixelToPdf, itemsContent } from "../pdfupdate.js";
import { buildPdf } from "../pdf.js";
import { layout, sampleLease, fieldLine } from "../doc.js";
import { presetSignature } from "../signature.js";
import { typedSignature } from "../handwriting.js";

const latin = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const bytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 255);
const allText = (models) => models.flatMap((m) => m.texts.map((t) => t.text)).join(" ");

test("inflate matches zlib for stored, fixed and dynamic blocks", () => {
  const random = new Uint8Array(70000).map((_, i) => (i * 2654435761) >>> 24);
  const words = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(3000));
  for (const input of [random, words, new Uint8Array(0), Buffer.from("a")]) {
    assert.deepEqual(Buffer.from(inflate(deflateSync(input))), Buffer.from(input));
    assert.deepEqual(Buffer.from(inflate(deflateSync(input, { strategy: constants.Z_FIXED }))), Buffer.from(input));
    assert.deepEqual(Buffer.from(inflate(deflateSync(input, { level: 0 }))), Buffer.from(input));
    assert.deepEqual(Buffer.from(inflate(deflateRawSync(input), { zlib: false })), Buffer.from(input));
  }
});

const pages = layout(sampleLease);
const sample = buildPdf({ title: sampleLease.name, pages, items: [] });

test("the built-in sample opens through the parser", () => {
  const { doc, pages: parsed, models } = openPdf(sample);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].mediaBox, [0, 0, 612, 792]);
  assert.equal(doc.repaired, false);
  assert.match(allText(models), /EQUIPMENT LOAN AGREEMENT/);
  assert.match(allText(models), /Borrower signature/);
  assert.ok(models[0].paths.length >= 5, "signature rules are paths");
  const title = models[0].texts.find((t) => t.text === "EQUIPMENT LOAN AGREEMENT");
  assert.ok(title.bold && title.family === "serif");
  assert.ok(Math.abs(title.size - 23 * 612 / 860) < 0.01);
});

/** A PDF 1.5 file with an object stream, a compressed xref stream with a PNG predictor, and a Flate content stream. */
function modernPdf({ rotate = 0, mediaBox = [0, 0, 612, 792] } = {}) {
  const content = deflateSync(Buffer.from("BT /F1 24 Tf 72 700 Td (Hello modern PDF) Tj ET 0 0 1 RG 72 690 m 300 690 l S 10 10 50 50 re f"));
  const pagesObj = "<< /Type /Pages /Kids [4 0 R] /Count 1 >>";
  const header = `2 0 3 ${pagesObj.length + 1} `;
  const objstm = `${header}${pagesObj} << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const first = header.length;
  const objData = deflateSync(Buffer.from(objstm));
  let out = "%PDF-1.5\n";
  const offsets = {};
  const add = (n, body) => { offsets[n] = out.length; out += `${n} 0 obj\n${body}\nendobj\n`; };
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(4, `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}] /Rotate ${rotate} /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>`);
  add(5, `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${latin(content)}\nendstream`);
  add(6, `<< /Type /ObjStm /N 2 /First ${first} /Length ${objData.length} /Filter /FlateDecode >>\nstream\n${latin(objData)}\nendstream`);
  const xrefAt = out.length;
  // Rows for objects 0..7: type, offset(4 bytes), index(1 byte); PNG Up predictor.
  const rows = [[0, 0, 255], [1, offsets[1], 0], [2, 6, 0], [2, 6, 1], [1, offsets[4], 0], [1, offsets[5], 0], [1, offsets[6], 0], [1, xrefAt, 0]];
  const raw = rows.map(([t, a, b]) => [t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b]);
  const filtered = [];
  let prev = new Array(6).fill(0);
  for (const row of raw) { filtered.push(2, ...row.map((v, i) => (v - prev[i] + 256) & 255)); prev = row; }
  const xdata = deflateSync(Buffer.from(filtered));
  out += `7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 6 >> /Length ${xdata.length} >>\nstream\n${latin(xdata)}\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`;
  return bytes(out);
}

test("xref streams, object streams and Flate content are read", () => {
  const { doc, pages: parsed, models } = openPdf(modernPdf());
  assert.ok(doc.usesXrefStream);
  assert.equal(parsed.length, 1);
  assert.equal(models[0].texts[0].text, "Hello modern PDF");
  assert.equal(models[0].texts[0].y, 792 - 700);
  assert.equal(models[0].paths.length, 2);
  assert.equal(models[0].paths[0].stroke, "#0000ff");
  assert.equal(models[0].paths[1].fill, "#000000");
});

test("a file with a broken xref is recovered by rescanning", () => {
  const broken = latin(sample).replace(/startxref\n\d+/, "startxref\n99999");
  const { doc, pages: parsed } = openPdf(bytes(broken));
  assert.ok(doc.repaired);
  assert.equal(parsed.length, 1);
});

test("display pixels map back to PDF coordinates, with rotation and offset boxes", () => {
  const cases = [
    { rotate: 0, mediaBox: [0, 0, 612, 792], px: [0, 0], pdf: [0, 792] },
    { rotate: 0, mediaBox: [50, 100, 662, 892], px: [0, 0], pdf: [50, 892] },
    { rotate: 90, mediaBox: [0, 0, 612, 792], px: [0, 0], pdf: [0, 0] },
    { rotate: 180, mediaBox: [0, 0, 612, 792], px: [0, 0], pdf: [612, 0] },
    { rotate: 270, mediaBox: [0, 0, 612, 792], px: [0, 0], pdf: [612, 792] },
  ];
  for (const c of cases) {
    const page = { rotate: c.rotate, mediaBox: c.mediaBox };
    const scale = 2;
    const back = pixelToPdf(page, scale).point(c.px[0], c.px[1]);
    assert.deepEqual(back.map((v) => Math.round(v * 1000) / 1000), c.pdf, `rotate ${c.rotate}`);
    // Round trip: page space → display → page space.
    const display = apply(displayMatrix(page), 123, 456);
    const again = pixelToPdf(page, scale).point(display[0] * scale, display[1] * scale);
    assert.deepEqual(again.map((v) => Math.round(v * 1000) / 1000), [123, 456]);
  }
});

test("signature strokes land where they were placed", () => {
  const page = { rotate: 0, mediaBox: [0, 0, 612, 792] };
  const item = { id: "s", page: 0, kind: "signature", x: 100, y: 200, w: 200, h: 60, strokes: [[[0, 0], [1, 1]]], weight: 0.04 };
  const content = itemsContent([item], page, 2, "F");
  // (100, 200) px at 2 px/pt is (50, 100) pt from the top: y = 692 in PDF space.
  assert.match(content, /^q .* RG 1 J 1 j 1\.2 w\n50 692 m /);
  assert.match(content, / 150 662 c S/);
});

const items = (line) => [
  { id: "a", page: 0, kind: "signature", x: line.x1 + 10, y: line.y1 - 60, w: 216, h: 65, strokes: presetSignature.strokes, color: "#1f2a6b", weight: 0.035 },
  { id: "b", page: 0, kind: "date", x: 540, y: line.y1 - 30, w: 110, h: 28, text: "10/11/2026" },
];

function checkSigned(original, signed, expectedPages) {
  assert.deepEqual(signed.subarray(0, original.length), original, "original bytes are untouched");
  const reopened = openPdf(signed);
  assert.equal(reopened.doc.repaired, false, "the new xref chain is valid");
  assert.equal(reopened.pages.length, expectedPages);
  const contents = reopened.doc.get(reopened.pages[0].dict.Contents);
  assert.ok(Array.isArray(contents) && contents.length >= 3, "q, the original content, and the signature stream");
  const last = latin(reopened.doc.decode(reopened.doc.get(contents[contents.length - 1])));
  assert.match(last, /^Q\n/);
  assert.match(last, / c S/, "signature strokes are in the new content stream");
  assert.match(last, /\(10\/11\/2026\) Tj/);
  assert.ok(reopened.models[0].paths.some((p) => p.stroke === "#1f2a6b"), "the parser sees the signature");
  return reopened;
}

test("incremental signing keeps the original and adds a readable content stream", () => {
  const line = fieldLine(pages[0], "Borrower signature");
  const parsed = openPdf(sample);
  const signed = signIncrementally(sample, parsed.doc, parsed.pages, items(line), () => 860 / 612);
  const reopened = checkSigned(sample, signed, 1);
  assert.match(latin(signed.subarray(sample.length)), /\/Prev \d+/);
  assert.match(allText(reopened.models), /10\/11\/2026/);
  // Signing the signed copy again chains another update.
  const twice = signIncrementally(signed, reopened.doc, reopened.pages, items(line), () => 860 / 612);
  checkSigned(signed, twice, 1);
});

test("files indexed by xref streams are updated with an xref stream", () => {
  const original = modernPdf({ rotate: 90 });
  const parsed = openPdf(original);
  const signed = signIncrementally(original, parsed.doc, parsed.pages, items({ x1: 100, y1: 300 }), () => 1);
  assert.match(latin(signed.subarray(original.length)), /\/Type \/XRef/);
  const reopened = checkSigned(original, signed, 1);
  assert.match(latin(reopened.doc.contentOf(reopened.pages[0].dict)), /\(Hello modern PDF\) Tj/);
  // On a page turned 90°, the date still reads left to right on screen.
  assert.ok(reopened.models[0].texts.some((t) => t.text === "10/11/2026"));
});

test("a typed name becomes strokes", () => {
  const result = typedSignature("Alex Morgan");
  assert.ok(result && result.strokes.length > 10 && result.aspect > 3);
  assert.equal(typedSignature("   "), null);
});

const has = (cmd) => { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };

test("poppler and macOS read the signed copy", { skip: !has("pdfinfo") && !has("sips") && "no PDF tools installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "signed-"));
  try {
    const line = fieldLine(pages[0], "Borrower signature");
    for (const [name, original] of [["sample", sample], ["modern", modernPdf({ rotate: 90 })]]) {
      const parsed = openPdf(original);
      const file = join(dir, `${name}-signed.pdf`);
      writeFileSync(file, signIncrementally(original, parsed.doc, parsed.pages, items(line), () => 860 / parsed.models[0].width));
      if (has("pdfinfo")) {
        const info = execFileSync("pdfinfo", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        assert.match(info, /Pages:\s+1/);
        assert.match(execFileSync("pdftotext", [file, "-"], { encoding: "utf8" }), /10\/11\/2026/);
      }
      if (has("sips")) {
        const png = join(dir, `${name}.png`);
        execFileSync("sips", ["-s", "format", "png", file, "--out", png], { stdio: "ignore" });
        assert.ok(existsSync(png) && readFileSync(png).length > 1000, "Quartz rendered the signed page");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real PDFs on this machine parse with the right page count", { skip: !has("pdfinfo") && "pdfinfo not installed" }, () => {
  const found = execFileSync("sh", ["-c", "{ ls /System/Library/ProductDocuments/ProductGuides/*.pdf; find /System/Library /Library/Documentation /opt/homebrew/share -name '*.pdf' -size +20k; } 2>/dev/null | head -10"], { encoding: "utf8" }).split("\n").filter(Boolean);
  let checked = 0, texts = 0, paths = 0;
  for (const file of found) {
    let expected;
    try { expected = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))?.[1]); } catch { continue; }
    if (!expected) continue;
    let doc;
    try { doc = new PdfDocument(new Uint8Array(readFileSync(file))); } catch (error) { if (/encrypted/.test(error.message)) continue; throw new Error(`${file}: ${error.message}`); }
    const parsed = doc.pages();
    assert.equal(parsed.length, expected, file);
    for (const page of parsed.slice(0, 2)) {
      const model = interpretPage(doc, page);
      assert.ok(model.width > 0 && model.height > 0, file);
      texts += model.texts.length;
      paths += model.paths.length;
    }
    checked += 1;
  }
  console.log(`checked ${checked} system PDFs: ${texts} text runs, ${paths} paths on their first pages`);
  assert.ok(texts + paths > 0);
});
