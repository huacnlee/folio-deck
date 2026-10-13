// @ts-check
// Reads PDF files in plain JavaScript: the object syntax, classic and stream
// cross-reference sections (with a full rescan when they are damaged), object
// streams, the common filters, the page tree, and page content interpreted
// into positioned text runs and vector paths in top-left page coordinates.
import { inflate } from "./inflate.js";

// -- Objects -------------------------------------------------------------------

export class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen; }
}
export class Name {
  constructor(name) { this.name = name; }
}
/** @typedef {{ dict: Record<string, any>, data: Uint8Array, start: number }} Stream */

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isRegular = (c) => !WS.has(c) && !DELIM.has(c);
const latin = (bytes, start = 0, end = bytes.length) => {
  let s = "";
  for (let i = start; i < end; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(end, i + 0x8000))));
  return s;
};
export const bytesOf = (text) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

const KEYWORD = Symbol("keyword");

/** A tokenizer and object reader over bytes. */
export class Lexer {
  /** @param {Uint8Array} bytes */
  constructor(bytes, pos = 0) { this.bytes = bytes; this.pos = pos; }

  skip() {
    const b = this.bytes;
    for (;;) {
      while (this.pos < b.length && WS.has(b[this.pos])) this.pos += 1;
      if (b[this.pos] !== 37) return;
      while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos += 1;
    }
  }

  /** The next token: a number, Name, string bytes, delimiter or keyword. */
  token() {
    this.skip();
    const b = this.bytes;
    if (this.pos >= b.length) return null;
    const c = b[this.pos];
    if (c === 47) {
      let end = this.pos + 1;
      while (end < b.length && isRegular(b[end])) end += 1;
      const raw = latin(b, this.pos + 1, end).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.pos = end;
      return new Name(raw);
    }
    if (c === 40) return { str: this.literal() };
    if (c === 60) {
      if (b[this.pos + 1] === 60) { this.pos += 2; return "<<"; }
      return { str: this.hex() };
    }
    if (c === 62 && b[this.pos + 1] === 62) { this.pos += 2; return ">>"; }
    if (c === 91 || c === 93 || c === 123 || c === 125) { this.pos += 1; return String.fromCharCode(c); }
    let end = this.pos;
    while (end < b.length && isRegular(b[end])) end += 1;
    if (end === this.pos) { this.pos += 1; return { [KEYWORD]: String.fromCharCode(c) }; }
    const word = latin(b, this.pos, end);
    this.pos = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (/^[+-]?\d*\.?\d*[+-]?$/.test(word) && /\d/.test(word)) return Number.parseFloat(word.replace(/--+/, "-")) || 0;
    return { [KEYWORD]: word };
  }

  literal() {
    const b = this.bytes;
    const out = [];
    let depth = 1;
    this.pos += 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92) {
        const n = b[this.pos++];
        if (n === 110) out.push(10); else if (n === 114) out.push(13); else if (n === 116) out.push(9);
        else if (n === 98) out.push(8); else if (n === 102) out.push(12);
        else if (n === 13) { if (b[this.pos] === 10) this.pos += 1; }
        else if (n === 10) { /* line continuation */ }
        else if (n >= 48 && n <= 55) {
          let v = n - 48;
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k += 1) v = v * 8 + b[this.pos++] - 48;
          out.push(v & 0xff);
        } else out.push(n);
      } else if (c === 40) { depth += 1; out.push(c); }
      else if (c === 41) { depth -= 1; if (!depth) break; out.push(c); }
      else out.push(c);
    }
    return Uint8Array.from(out);
  }

  hex() {
    const b = this.bytes;
    this.pos += 1;
    let digits = "";
    while (this.pos < b.length && b[this.pos] !== 62) {
      const c = b[this.pos++];
      if (!WS.has(c)) digits += String.fromCharCode(c);
    }
    this.pos += 1;
    if (digits.length % 2) digits += "0";
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(digits.substr(i * 2, 2), 16) || 0;
    return out;
  }

  /**
   * Reads one object. Numbers followed by `gen R` become refs. A dictionary
   * followed by `stream` becomes a Stream when `doc` can resolve its length.
   */
  object(doc = null) {
    const t = this.token();
    return this.fromToken(t, doc);
  }

  fromToken(t, doc) {
    if (t === null) return null;
    if (typeof t === "number") {
      const save = this.pos;
      const g = this.token();
      if (typeof g === "number" && Number.isInteger(t) && Number.isInteger(g)) {
        const r = this.token();
        if (r && r[KEYWORD] === "R") return new Ref(t, g);
      }
      this.pos = save;
      return t;
    }
    if (t === "[") {
      const arr = [];
      for (;;) {
        const n = this.token();
        if (n === "]" || n === null) return arr;
        arr.push(this.fromToken(n, doc));
      }
    }
    if (t === "<<") {
      /** @type {Record<string, any>} */
      const dict = {};
      for (;;) {
        const k = this.token();
        if (k === ">>" || k === null) break;
        if (!(k instanceof Name)) continue;
        dict[k.name] = this.fromToken(this.token(), doc);
      }
      const save = this.pos;
      const next = this.token();
      if (next && next[KEYWORD] === "stream") {
        let start = this.pos;
        if (this.bytes[start] === 13) start += 1;
        if (this.bytes[start] === 10) start += 1;
        let length = dict.Length;
        if (length instanceof Ref) length = doc ? doc.get(length) : null;
        let end = typeof length === "number" ? start + length : -1;
        // Trust /Length only when `endstream` really follows it.
        if (end < 0 || end > this.bytes.length || !/^\s*endstream/.test(latin(this.bytes, end, Math.min(this.bytes.length, end + 20)))) {
          end = indexOf(this.bytes, "endstream", start);
          if (end < 0) end = this.bytes.length;
          while (end > start && (this.bytes[end - 1] === 10 || this.bytes[end - 1] === 13)) end -= 1;
        }
        this.pos = end;
        const close = indexOf(this.bytes, "endstream", end);
        if (close >= 0) this.pos = close + 9;
        return /** @type {Stream} */ ({ dict, data: this.bytes.subarray(start, end), start });
      }
      this.pos = save;
      return dict;
    }
    if (t && typeof t === "object" && "str" in t) return t.str;
    if (t instanceof Name) return t;
    if (t && t[KEYWORD] !== undefined) {
      const k = t[KEYWORD];
      if (k === "true") return true;
      if (k === "false") return false;
      if (k === "null") return null;
      return { op: k };
    }
    return null;
  }
}

export function indexOf(bytes, text, from = 0) {
  const first = text.charCodeAt(0);
  outer: for (let i = from; i <= bytes.length - text.length; i += 1) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < text.length; k += 1) if (bytes[i + k] !== text.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
function lastIndexOf(bytes, text, from = bytes.length - text.length) {
  for (let i = Math.min(from, bytes.length - text.length); i >= 0; i -= 1) {
    let ok = true;
    for (let k = 0; k < text.length; k += 1) if (bytes[i + k] !== text.charCodeAt(k)) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

export const isStream = (v) => v && typeof v === "object" && v.dict && v.data instanceof Uint8Array;
const nameOf = (v) => (v instanceof Name ? v.name : null);

// -- Filters -------------------------------------------------------------------

function predictor(data, parms) {
  const p = parms?.Predictor ?? 1;
  if (p < 10) return data;
  const colors = parms.Colors ?? 1, bpc = parms.BitsPerComponent ?? 8, columns = parms.Columns ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  let prev = new Uint8Array(row);
  for (let r = 0; r < rows; r += 1) {
    const type = data[r * (row + 1)];
    const line = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1));
    const cur = out.subarray(r * row, (r + 1) * row);
    for (let i = 0; i < row; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

function asciiHex(data) {
  const digits = latin(data).replace(/[^0-9a-fA-F>]/g, "").split(">")[0];
  const out = new Uint8Array(Math.ceil(digits.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt((digits.substr(i * 2, 2) + "0").slice(0, 2), 16);
  return out;
}

function ascii85(data) {
  const text = latin(data).replace(/\s/g, "").replace(/^<~/, "").split("~>")[0];
  const out = [];
  let group = [];
  for (const ch of text) {
    if (ch === "z" && !group.length) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

// -- Document ------------------------------------------------------------------

export class PdfDocument {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    /** @type {Map<number, { type: "n", offset: number, gen: number } | { type: "c", stream: number, index: number }>} */
    this.xref = new Map();
    /** @type {Map<number, any>} */
    this.cache = new Map();
    this.trailer = {};
    this.startxref = -1;
    this.usesXrefStream = false;
    this.repaired = false;
    if (latin(bytes, 0, Math.min(1024, bytes.length)).indexOf("%PDF-") < 0) throw new Error("not a PDF file");
    try {
      this.readXrefChain();
      if (!this.trailer.Root) throw new Error("no document catalog");
      this.get(this.trailer.Root).Type;
    } catch {
      this.rebuild();
    }
    if (this.trailer.Encrypt) throw new Error("encrypted PDFs are not supported");
  }

  readXrefChain() {
    const at = lastIndexOf(this.bytes, "startxref");
    if (at < 0) throw new Error("no startxref");
    const lexer = new Lexer(this.bytes, at + 9);
    let offset = lexer.token();
    if (typeof offset !== "number") throw new Error("bad startxref");
    this.startxref = offset;
    const seen = new Set();
    let first = true;
    while (typeof offset === "number" && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefAt(offset, first);
      if (first) this.trailer = { ...trailer };
      first = false;
      if (typeof trailer.XRefStm === "number") this.readXrefAt(trailer.XRefStm, false);
      offset = trailer.Prev;
    }
  }

  /** Reads one xref section, keeping entries already set by newer sections. */
  readXrefAt(offset, newest) {
    const lexer = new Lexer(this.bytes, offset);
    lexer.skip();
    if (latin(this.bytes, lexer.pos, lexer.pos + 4) === "xref") {
      lexer.pos += 4;
      for (;;) {
        const t = lexer.token();
        if (t && t[KEYWORD] === "trailer") break;
        const count = lexer.token();
        if (typeof t !== "number" || typeof count !== "number") throw new Error("bad xref table");
        for (let i = 0; i < count; i += 1) {
          const off = lexer.token(), gen = lexer.token(), kind = lexer.token();
          const num = t + i;
          if (!this.xref.has(num) && kind?.[KEYWORD] === "n" && off > 0) this.xref.set(num, { type: "n", offset: off, gen });
        }
      }
      const trailer = lexer.object(this);
      if (!trailer || typeof trailer !== "object") throw new Error("bad trailer");
      return trailer;
    }
    // A cross-reference stream: `n g obj << /Type /XRef … >> stream`.
    lexer.token(); lexer.token(); lexer.token();
    const stream = lexer.object(this);
    if (!isStream(stream) || nameOf(stream.dict.Type) !== "XRef") throw new Error("bad xref stream");
    if (newest) this.usesXrefStream = true;
    const data = this.decode(stream);
    const [w0, w1, w2] = stream.dict.W;
    const index = stream.dict.Index ?? [0, stream.dict.Size];
    let p = 0;
    const field = (w) => { let v = 0; for (let i = 0; i < w; i += 1) v = v * 256 + data[p++]; return v; };
    for (let s = 0; s < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i += 1) {
        const type = w0 ? field(w0) : 1, a = field(w1), b = field(w2);
        const num = index[s] + i;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: "n", offset: a, gen: b });
        else if (type === 2) this.xref.set(num, { type: "c", stream: a, index: b });
      }
    }
    return stream.dict;
  }

  /** Recovers a damaged file by scanning for every `n g obj`. */
  rebuild() {
    this.repaired = true;
    this.xref.clear();
    this.cache.clear();
    const text = latin(this.bytes);
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) this.xref.set(Number(m[1]), { type: "n", offset: m.index, gen: Number(m[2]) });
    this.trailer = {};
    for (const match of text.matchAll(/trailer\s*<</g)) {
      const t = new Lexer(this.bytes, match.index + 7).object(this);
      if (t?.Root) this.trailer = t;
    }
    if (!this.trailer.Root) {
      for (const [num] of this.xref) {
        const obj = this.getNum(num);
        if (isStream(obj) && nameOf(obj.dict.Type) === "XRef" && obj.dict.Root) this.trailer = obj.dict;
        if (obj && nameOf(obj.Type) === "Catalog") this.trailer = { ...this.trailer, Root: new Ref(num, 0) };
      }
    }
    if (!this.trailer.Root) throw new Error("no document catalog found");
  }

  get size() {
    let max = 0;
    for (const num of this.xref.keys()) max = Math.max(max, num);
    return Math.max(max + 1, this.trailer.Size ?? 0);
  }

  /** Resolves a value: refs are followed, everything else is returned as is. */
  get(value) {
    return value instanceof Ref ? this.getNum(value.num) : value;
  }

  getNum(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.xref.get(num);
    let value = null;
    this.cache.set(num, null); // breaks reference cycles while loading
    if (entry?.type === "n") {
      const lexer = new Lexer(this.bytes, entry.offset);
      const n = lexer.token(), g = lexer.token(), kw = lexer.token();
      if (n === num && kw?.[KEYWORD] === "obj") value = lexer.object(this);
    } else if (entry?.type === "c") {
      const stream = this.getNum(entry.stream);
      if (isStream(stream)) {
        const data = this.decode(stream);
        const lexer = new Lexer(data);
        const pairs = [];
        for (let i = 0; i < stream.dict.N; i += 1) pairs.push([lexer.token(), lexer.token()]);
        const pair = pairs.find((p) => p[0] === num) ?? pairs[entry.index];
        if (pair) value = new Lexer(data, stream.dict.First + pair[1]).object(this);
      }
    }
    this.cache.set(num, value);
    return value;
  }

  /** The decoded bytes of a stream. Unsupported filters return null. */
  decode(stream) {
    let data = stream.data;
    const filters = [].concat(this.get(stream.dict.Filter) ?? []).map((f) => nameOf(this.get(f)));
    const parms = [].concat(this.get(stream.dict.DecodeParms) ?? []).map((p) => this.get(p));
    for (const [i, filter] of filters.entries()) {
      if (filter === "FlateDecode" || filter === "Fl") {
        try { data = inflate(data); } catch { data = inflate(data, { zlib: false }); }
        data = predictor(data, parms[i]);
      } else if (filter === "ASCIIHexDecode" || filter === "AHx") data = asciiHex(data);
      else if (filter === "ASCII85Decode" || filter === "A85") data = ascii85(data);
      else return null;
    }
    return data;
  }

  get catalog() { return this.get(this.trailer.Root); }

  /** Every page, in order, with its inherited attributes. */
  pages() {
    /** @type {{ ref: Ref | null, dict: any, mediaBox: number[], rotate: number, resources: any }[]} */
    const out = [];
    const seen = new Set();
    const walk = (nodeRef, inherited) => {
      const node = this.get(nodeRef);
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      const attrs = {
        MediaBox: node.MediaBox ?? inherited.MediaBox,
        Rotate: node.Rotate ?? inherited.Rotate,
        Resources: node.Resources ?? inherited.Resources,
        CropBox: node.CropBox ?? inherited.CropBox,
      };
      const kids = this.get(node.Kids);
      if (Array.isArray(kids) && nameOf(node.Type) !== "Page") {
        for (const kid of kids) walk(kid, attrs);
        return;
      }
      const box = (this.get(attrs.CropBox) ?? this.get(attrs.MediaBox) ?? [0, 0, 612, 792]).map((v) => Number(this.get(v)) || 0);
      const [x0, y0, x1, y1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
      out.push({
        ref: nodeRef instanceof Ref ? nodeRef : null,
        dict: node,
        mediaBox: [x0, y0, x1, y1],
        rotate: ((((Number(this.get(attrs.Rotate)) || 0) % 360) + 360) % 360),
        resources: this.get(attrs.Resources) ?? {},
      });
    };
    walk(this.catalog?.Pages, {});
    return out;
  }

  /** The decoded content of a page, all of its content streams joined. */
  contentOf(pageDict) {
    const parts = [].concat(this.get(pageDict.Contents) ?? []).map((c) => this.get(c)).filter(isStream).map((s) => this.decode(s) ?? new Uint8Array());
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; out[at++] = 10; }
    return out;
  }
}

// -- Fonts ---------------------------------------------------------------------

const WIN_ANSI_HIGH = { 128: 0x20ac, 130: 0x201a, 131: 0x192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x2c6, 137: 0x2030, 138: 0x160, 139: 0x2039, 140: 0x152, 142: 0x17d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x2dc, 153: 0x2122, 154: 0x161, 155: 0x203a, 156: 0x153, 158: 0x17e, 159: 0x178 };
/** Mac OS Roman, bytes 128…255. */
const MAC_ROMAN_HIGH = "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u00a0ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uf8ffÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";
const ACCENTS = { acute: "\u0301", grave: "\u0300", circumflex: "\u0302", dieresis: "\u0308", tilde: "\u0303", ring: "\u030a", cedilla: "\u0327", caron: "\u030c" };
const GLYPHS = { space: " ", quoteright: "’", quoteleft: "‘", quotedblleft: "“", quotedblright: "”", endash: "–", emdash: "—", bullet: "•", fi: "fi", fl: "fl", ff: "ff", ffi: "ffi", ffl: "ffl", hyphen: "-", period: ".", comma: ",", colon: ":", semicolon: ";", exclam: "!", question: "?", parenleft: "(", parenright: ")", slash: "/", ampersand: "&", dollar: "$", percent: "%", quotesingle: "'", quotedbl: "\"", asterisk: "*", plus: "+", equal: "=", at: "@", numbersign: "#", underscore: "_", bracketleft: "[", bracketright: "]", ellipsis: "…", degree: "°", copyright: "©", registered: "®", trademark: "™", section: "§", paragraph: "¶", minus: "-", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const glyphToChar = (name) => {
  if (GLYPHS[name]) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const accented = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron)$/.exec(name);
  if (accented) return (accented[1] + ACCENTS[accented[2]]).normalize("NFC");
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1], 16));
  return null;
};

/** Reads a ToUnicode CMap's bfchar/bfrange entries. */
function parseToUnicode(data) {
  const map = new Map();
  const text = latin(data);
  const hexStr = (h) => {
    let s = "";
    for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.substr(i, 4), 16));
    if (h.length === 2) s = String.fromCharCode(parseInt(h, 16));
    return s;
  };
  let codeBytes = 1;
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    const m = /<([0-9a-fA-F]+)>/.exec(block[1]);
    if (m) codeBytes = m[1].length / 2;
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), hexStr(m[2]));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 0xffff) continue;
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexStr(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c += 1) map.set(c, items[c - lo]);
      } else {
        const base = m[3].slice(1, -1);
        const start = parseInt(base.slice(-4) || "0", 16);
        const prefix = hexStr(base.slice(0, -4));
        for (let c = lo; c <= hi; c += 1) map.set(c, prefix + String.fromCharCode(start + c - lo));
      }
    }
  }
  return { map, codeBytes };
}

/** What text drawing needs to know about one font resource. */
function loadFont(doc, fontDict) {
  const dict = doc.get(fontDict) ?? {};
  const subtype = nameOf(dict.Subtype);
  const base = nameOf(dict.BaseFont) ?? "";
  const composite = subtype === "Type0";
  const descendant = composite ? doc.get([].concat(doc.get(dict.DescendantFonts) ?? [])[0]) ?? {} : null;
  const toUnicode = doc.get(dict.ToUnicode);
  const cmap = isStream(toUnicode) ? parseToUnicode(doc.decode(toUnicode) ?? new Uint8Array()) : null;
  /** @type {Map<number, string>} */
  const differences = new Map();
  const encoding = doc.get(dict.Encoding);
  const baseEncoding = nameOf(encoding) ?? nameOf(doc.get(encoding?.BaseEncoding));
  const macRoman = baseEncoding === "MacRomanEncoding";
  if (encoding && typeof encoding === "object" && !(encoding instanceof Name)) {
    let code = 0;
    for (const item of doc.get(encoding.Differences) ?? []) {
      if (typeof item === "number") code = item;
      else if (item instanceof Name) {
        const ch = glyphToChar(item.name);
        if (ch !== null) differences.set(code, ch);
        code += 1;
      }
    }
  }
  /** @type {Map<number, number>} */
  const widths = new Map();
  let defaultWidth = 500;
  if (composite) {
    defaultWidth = Number(doc.get(descendant.DW) ?? 1000);
    const w = doc.get(descendant.W) ?? [];
    for (let i = 0; i < w.length;) {
      const first = doc.get(w[i]);
      const next = doc.get(w[i + 1]);
      if (Array.isArray(next)) { next.forEach((v, k) => widths.set(first + k, Number(doc.get(v)))); i += 2; }
      else { for (let c = first; c <= next; c += 1) widths.set(c, Number(doc.get(w[i + 2]))); i += 3; }
    }
  } else {
    const first = Number(doc.get(dict.FirstChar) ?? 0);
    (doc.get(dict.Widths) ?? []).forEach((v, k) => widths.set(first + k, Number(doc.get(v))));
    const descriptor = doc.get(dict.FontDescriptor);
    if (descriptor?.MissingWidth) defaultWidth = Number(doc.get(descriptor.MissingWidth));
    else if (!widths.size) defaultWidth = /Courier/i.test(base) ? 600 : 520;
  }
  const family = /Courier|Mono|Consol/i.test(base) ? "mono" : /Times|Serif|Roman|Georgia|Garamond|Minion|Cambria|Book/i.test(base) && !/Sans/i.test(base) ? "serif" : "sans";
  return {
    family,
    bold: /Bold|Black|Heavy|Semibold|Demi/i.test(base),
    italic: /Italic|Oblique/i.test(base),
    codeBytes: composite ? cmap?.codeBytes ?? 2 : 1,
    /** @param {Uint8Array} bytes */
    decode(bytes) {
      const out = [];
      const step = this.codeBytes;
      for (let i = 0; i + step <= bytes.length; i += step) {
        const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
        let ch = cmap?.map.get(code);
        if (ch === undefined) ch = differences.get(code);
        if (ch === undefined) ch = composite ? "" : macRoman && code >= 128 ? MAC_ROMAN_HIGH[code - 128] : String.fromCharCode(WIN_ANSI_HIGH[code] ?? code);
        out.push({ ch, width: (widths.get(code) ?? defaultWidth) / 1000, space: step === 1 && code === 32 });
      }
      return out;
    },
  };
}

// -- Content -------------------------------------------------------------------

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const toRgb = (values) => {
  const v = values.map((n) => Math.max(0, Math.min(1, Number(n) || 0)));
  const hex = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
  if (v.length === 1) return `#${hex(v[0])}${hex(v[0])}${hex(v[0])}`;
  if (v.length === 3) return `#${hex(v[0])}${hex(v[1])}${hex(v[2])}`;
  if (v.length === 4) return `#${hex((1 - v[0]) * (1 - v[3]))}${hex((1 - v[1]) * (1 - v[3]))}${hex((1 - v[2]) * (1 - v[3]))}`;
  return "#000000";
};

/**
 * @typedef {{ x: number, y: number, size: number, text: string, family: string, bold: boolean, italic: boolean, color: string, width: number }} TextRun
 * @typedef {{ segments: (["M", number, number] | ["L", number, number] | ["C", number, number, number, number, number, number] | ["Z"])[], fill: string | null, stroke: string | null, lineWidth: number }} PathShape
 * @typedef {{ width: number, height: number, texts: TextRun[], paths: PathShape[], images: { x: number, y: number, w: number, h: number }[], truncated: boolean }} PageModel
 */

const LIMITS = { texts: 6000, paths: 3000, ops: 400000 };

/**
 * Interprets one page into runs and shapes, in points measured from the
 * top-left corner of the page as displayed (rotation applied).
 * @param {PdfDocument} doc
 * @param {ReturnType<PdfDocument["pages"]>[number]} page
 * @returns {PageModel}
 */
export function interpretPage(doc, page) {
  const [x0, y0, x1, y1] = page.mediaBox;
  const w = x1 - x0, h = y1 - y0;
  const rotated = page.rotate === 90 || page.rotate === 270;
  const width = rotated ? h : w, height = rotated ? w : h;
  /** Page space to top-left display space. */
  const view = displayMatrix(page);
  /** @type {PageModel} */
  const model = { width, height, texts: [], paths: [], images: [], truncated: false };
  const fonts = new Map();
  let opCount = 0;

  const run = (bytes, resources, baseCtm, depth) => {
    const lexer = new Lexer(bytes);
    /** @type {any[]} */
    let operands = [];
    let gs = { ctm: baseCtm, fill: "#000000", stroke: "#000000", lineWidth: 1 };
    const stack = [];
    let ts = { font: null, size: 12, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0, mode: 0 };
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
    /** @type {PathShape["segments"]} */
    let path = [];
    let cur = [0, 0];

    const pt = (x, y) => apply(gs.ctm, x, y);
    const paint = (fill, stroke) => {
      if (path.length && model.paths.length < LIMITS.paths) {
        const scale = Math.hypot(gs.ctm[0], gs.ctm[1]) || 1;
        model.paths.push({ segments: path.map((s) => /** @type {any} */ (transformSeg(s, view))), fill: fill ? gs.fill : null, stroke: stroke ? gs.stroke : null, lineWidth: Math.max(0.3, gs.lineWidth * scale) });
      } else if (path.length) model.truncated = true;
      path = [];
    };
    const fontFor = (name) => {
      const fontRes = doc.get(doc.get(resources?.Font)?.[name]);
      if (!fontRes) return null;
      if (!fonts.has(fontRes)) fonts.set(fontRes, loadFont(doc, fontRes));
      return fonts.get(fontRes);
    };
    const show = (bytes) => {
      if (!ts.font) return;
      const glyphs = ts.font.decode(bytes);
      const trm = mul([ts.size * ts.scale, 0, 0, ts.size, 0, ts.rise], mul(tm, gs.ctm));
      let advance = 0;
      let text = "";
      for (const g of glyphs) {
        text += g.ch;
        advance += (g.width * ts.size + ts.charSpace + (g.space ? ts.wordSpace : 0)) * ts.scale;
      }
      if (ts.mode !== 3 && text.trim() && model.texts.length < LIMITS.texts) {
        const full = mul(trm, view);
        const [x, y] = apply(view, trm[4], trm[5]);
        const size = Math.hypot(full[2], full[3]);
        const [ex, ey] = apply(mul(mul([1, 0, 0, 1, advance, 0], mul(tm, gs.ctm)), view), 0, 0);
        if (Math.abs(full[1]) < Math.abs(full[0]) * 0.2) {
          model.texts.push({ x, y, size, text, family: ts.font.family, bold: ts.font.bold, italic: ts.font.italic, color: gs.fill, width: Math.hypot(ex - x, ey - y) });
        }
      } else if (model.texts.length >= LIMITS.texts) model.truncated = true;
      tm = mul([1, 0, 0, 1, advance, 0], tm);
    };

    for (;;) {
      const t = lexer.token();
      if (t === null) break;
      if (++opCount > LIMITS.ops) { model.truncated = true; break; }
      if (!(t && typeof t === "object" && t[KEYWORD] !== undefined)) {
        operands.push(lexer.fromToken(t, doc));
        continue;
      }
      const op = t[KEYWORD];
      const n = operands.map((v) => (typeof v === "number" ? v : 0));
      switch (op) {
        case "true": case "false": case "null": operands.push(op === "true"); continue;
        case "q": stack.push({ ...gs }); break;
        case "Q": if (stack.length) gs = stack.pop(); break;
        case "cm": gs.ctm = mul(n.slice(0, 6), gs.ctm); break;
        case "w": gs.lineWidth = n[0]; break;
        case "g": gs.fill = toRgb(n.slice(0, 1)); break;
        case "G": gs.stroke = toRgb(n.slice(0, 1)); break;
        case "rg": gs.fill = toRgb(n.slice(0, 3)); break;
        case "RG": gs.stroke = toRgb(n.slice(0, 3)); break;
        case "k": gs.fill = toRgb(n.slice(0, 4)); break;
        case "K": gs.stroke = toRgb(n.slice(0, 4)); break;
        case "sc": case "scn": if ([1, 3, 4].includes(operands.filter((v) => typeof v === "number").length)) gs.fill = toRgb(operands.filter((v) => typeof v === "number")); break;
        case "SC": case "SCN": if ([1, 3, 4].includes(operands.filter((v) => typeof v === "number").length)) gs.stroke = toRgb(operands.filter((v) => typeof v === "number")); break;
        case "m": cur = [n[0], n[1]]; path.push(["M", ...pt(n[0], n[1])]); break;
        case "l": cur = [n[0], n[1]]; path.push(["L", ...pt(n[0], n[1])]); break;
        case "c": cur = [n[4], n[5]]; path.push(["C", ...pt(n[0], n[1]), ...pt(n[2], n[3]), ...pt(n[4], n[5])]); break;
        case "v": path.push(["C", ...pt(cur[0], cur[1]), ...pt(n[0], n[1]), ...pt(n[2], n[3])]); cur = [n[2], n[3]]; break;
        case "y": path.push(["C", ...pt(n[0], n[1]), ...pt(n[2], n[3]), ...pt(n[2], n[3])]); cur = [n[2], n[3]]; break;
        case "h": path.push(["Z"]); break;
        case "re": {
          const [x, y, rw, rh] = n;
          path.push(["M", ...pt(x, y)], ["L", ...pt(x + rw, y)], ["L", ...pt(x + rw, y + rh)], ["L", ...pt(x, y + rh)], ["Z"]);
          break;
        }
        case "S": paint(false, true); break;
        case "s": path.push(["Z"]); paint(false, true); break;
        case "f": case "F": case "f*": paint(true, false); break;
        case "B": case "B*": paint(true, true); break;
        case "b": case "b*": path.push(["Z"]); paint(true, true); break;
        case "n": path = []; break;
        case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case "Tf": ts.font = fontFor(nameOf(operands[0])); ts.size = n[1]; break;
        case "Tc": ts.charSpace = n[0]; break;
        case "Tw": ts.wordSpace = n[0]; break;
        case "Tz": ts.scale = n[0] / 100; break;
        case "TL": ts.leading = n[0]; break;
        case "Ts": ts.rise = n[0]; break;
        case "Tr": ts.mode = n[0]; break;
        case "Td": tlm = mul([1, 0, 0, 1, n[0], n[1]], tlm); tm = tlm; break;
        case "TD": ts.leading = -n[1]; tlm = mul([1, 0, 0, 1, n[0], n[1]], tlm); tm = tlm; break;
        case "Tm": tlm = n.slice(0, 6); tm = tlm; break;
        case "T*": tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm); tm = tlm; break;
        case "Tj": if (operands[0] instanceof Uint8Array) show(operands[0]); break;
        case "'": tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm); tm = tlm; if (operands[0] instanceof Uint8Array) show(operands[0]); break;
        case "\"": ts.wordSpace = n[0]; ts.charSpace = n[1]; tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm); tm = tlm; if (operands[2] instanceof Uint8Array) show(operands[2]); break;
        case "TJ":
          for (const part of Array.isArray(operands[0]) ? operands[0] : []) {
            if (part instanceof Uint8Array) show(part);
            else if (typeof part === "number") tm = mul([1, 0, 0, 1, (-part / 1000) * ts.size * ts.scale, 0], tm);
          }
          break;
        case "Do": {
          const xobject = doc.get(doc.get(resources?.XObject)?.[nameOf(operands[0])]);
          if (!isStream(xobject)) break;
          const subtype = nameOf(xobject.dict.Subtype);
          if (subtype === "Image") {
            const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => apply(view, ...apply(gs.ctm, x, y)));
            const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
            model.images.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
          } else if (subtype === "Form" && depth < 8) {
            const data = doc.decode(xobject);
            if (data) {
              const matrix = (doc.get(xobject.dict.Matrix) ?? [1, 0, 0, 1, 0, 0]).map(Number);
              run(data, doc.get(xobject.dict.Resources) ?? resources, mul(matrix, gs.ctm), depth + 1);
            }
          }
          break;
        }
        case "BI": {
          // Inline image: skip to EI.
          const end = indexOf(bytes, "EI", lexer.pos);
          lexer.pos = end < 0 ? bytes.length : end + 2;
          break;
        }
      }
      operands = [];
    }
  };

  run(doc.contentOf(page.dict), page.resources, [1, 0, 0, 1, 0, 0], 0);
  model.texts = mergeRuns(model.texts);
  return model;
}

/**
 * Joins runs that continue one another on a line. A PDF often positions every
 * word or kerning pair separately; drawn in a substitute font, separate runs
 * would leave gaps or overlaps where the original font was wider or narrower.
 * @param {TextRun[]} runs
 */
export function mergeRuns(runs) {
  /** @type {TextRun[]} */
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - run.y) < run.size * 0.2 && Math.abs(last.size - run.size) < 0.01
      && last.family === run.family && last.bold === run.bold && last.italic === run.italic && last.color === run.color) {
      const gap = run.x - (last.x + last.width);
      if (gap > -run.size * 0.3 && gap < run.size * 1.2) {
        const space = gap > run.size * 0.18 && !/\s$/.test(last.text) && !/^\s/.test(run.text) ? " " : "";
        last.text += space + run.text;
        last.width = run.x + run.width - last.x;
        continue;
      }
    }
    out.push({ ...run });
  }
  return out;
}

function transformSeg(seg, m) {
  if (seg[0] === "Z") return seg;
  const out = [seg[0]];
  for (let i = 1; i < seg.length; i += 2) out.push(...apply(m, seg[i], seg[i + 1]));
  return out;
}

/**
 * The matrix from PDF page space (y up, origin at MediaBox lower-left, before
 * /Rotate) to display space (y down, origin at the top-left of the page as
 * it is shown). Its inverse maps a placed item back into the PDF.
 */
export function displayMatrix(page) {
  const [x0, y0, x1, y1] = page.mediaBox;
  const w = x1 - x0, h = y1 - y0;
  const shift = [1, 0, 0, 1, -x0, -y0];
  switch (page.rotate) {
    case 90: return mul(shift, [0, 1, 1, 0, 0, 0]);
    case 180: return mul(shift, [-1, 0, 0, 1, w, 0]);
    case 270: return mul(shift, [0, -1, -1, 0, h, w]);
    default: return mul(shift, [1, 0, 0, -1, 0, h]);
  }
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export { mul, apply };

/** Opens a file and interprets every page. @param {Uint8Array} bytes */
export function openPdf(bytes) {
  const doc = new PdfDocument(bytes);
  const pages = doc.pages();
  if (!pages.length) throw new Error("the document has no pages");
  return { doc, pages, models: pages.map((page) => interpretPage(doc, page)) };
}
