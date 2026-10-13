// @ts-check
import { View, div, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, TextareaState, Textarea } from "gpui-base";
import { Button, Icon, Kbd, TitleBar, Separator } from "gpui-component";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import process from "process";
import { palette, fonts, weights } from "./theme.js";
import { layout, sampleLease, docFromText } from "./doc.js";
import { fontSize, fitText, textBox, formatDate, TEXT_PAD, TEXT_LINE } from "./items.js";
import { smooth, normalize, addPoint } from "./signature.js";
import { typedSignature } from "./handwriting.js";
import { buildPdf, signedName } from "./pdf.js";
import { openPdf } from "./pdfparse.js";
import { signIncrementally } from "./pdfupdate.js";
import { encodeUtf8, decodeUtf8 } from "./utf8.js";

/** @typedef {import("./items.js").Item} Item */
/** @typedef {import("./signature.js").Signature} Signature */
/** @typedef {import("./pdfparse.js").PageModel} PageModel */

const APP_ID = "com.huacnlee.signed";
const OUT_DIR = "Signed copies";
/** Every page is drawn this many pixels wide; items are kept in these pixels. */
const PAGE_WIDTH = 820;
const THUMB_WIDTH = 104;
const PAD = { width: 520, height: 190 };
const mac = process.platform === "darwin" || process.platform === "macos";

const icon = (name) => new Icon(`signed/icons/${name}.svg`).size("small");
const pct = (value) => /** @type {`${number}%`} */ (`${Math.round(value * 100000) / 1000}%`);

/** Strokes in a unit box as native paths filling their parent. */
function ink(strokes, width, color) {
  const out = [];
  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    const { start, curves } = smooth(stroke);
    let path = PathBuilder.stroke(width).move_to(pct(start[0]), pct(start[1]));
    for (const c of curves) path = path.cubic_bezier_to(pct(c[4]), pct(c[5]), pct(c[0]), pct(c[1]), pct(c[2]), pct(c[3]));
    out.push(window.paint_path(path.build(), color).absolute().inset_0());
  }
  return out;
}

/**
 * A page's vector shapes as native paths. Neighbouring shapes with the same
 * paint share one path, so a table of a thousand rules is a few elements.
 * @param {PageModel} model @param {number} scale
 */
function shapes(model, scale, limit = Infinity) {
  const out = [];
  const groups = [];
  for (const shape of model.paths.slice(0, limit)) {
    const key = `${shape.fill}|${shape.stroke}|${Math.round(shape.lineWidth * 10)}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key && last.shapes.length < 200) last.shapes.push(shape);
    else groups.push({ key, shapes: [shape], fill: shape.fill, stroke: shape.stroke, lineWidth: shape.lineWidth });
  }
  const px = (x) => pct(x / model.width), py = (y) => pct(y / model.height);
  for (const group of groups) {
    for (const mode of ["fill", "stroke"]) {
      const color = group[mode];
      if (!color) continue;
      try {
        let path = mode === "fill" ? PathBuilder.fill() : PathBuilder.stroke(Math.max(0.5, group.lineWidth * scale));
        let open = false;
        for (const shape of group.shapes) {
          for (const seg of shape.segments) {
            if (seg[0] === "M") { path = path.move_to(px(seg[1]), py(seg[2])); open = true; }
            else if (!open) continue;
            else if (seg[0] === "L") path = path.line_to(px(seg[1]), py(seg[2]));
            else if (seg[0] === "C") path = path.cubic_bezier_to(px(seg[5]), py(seg[6]), px(seg[1]), py(seg[2]), px(seg[3]), py(seg[4]));
            else if (seg[0] === "Z") path = path.close();
          }
        }
        out.push(window.paint_path(path.build(), color).absolute().inset_0());
      } catch {
        // A degenerate shape draws nothing rather than taking the page down.
      }
    }
  }
  return out;
}

/** FNV-1a over a path, as gpui-shell names a development data directory. */
function pathDigest(path) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encodeUtf8(path)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** This application's directory, read from where this module was loaded. */
function appRoot() {
  const match = /(?:file:\/\/)?(\/[^\s():?]*)\/main\.js/.exec(String(new Error().stack ?? ""));
  return match ? match[1] : "";
}

/**
 * The folder name under …/gpui-shell/apps that `${dataDir}` is: the manifest
 * id once installed or bundled, a name plus a digest of the path while it is
 * run from a working directory with `run -d`.
 */
export function dataDirName(root, home) {
  if (!root || root.startsWith(`${home}/.gpui-shell/apps/`) || /\.app\/Contents\/Resources\/app$/.test(root)) return APP_ID;
  const name = (root.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/\.\./g, "-").replace(/^[._-]+|[._-]+$/g, "") || "app";
  return `${name}-${pathDigest(root)}`;
}

/** Bytes to base64. */
export function encodeBase64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? alphabet[n & 63] : "=";
  }
  return out;
}

/** Base64 to bytes; whitespace and line breaks are ignored. */
export function decodeBase64(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0, value = 0, at = 0;
  for (let i = 0; i < clean.length; i += 1) {
    value = (value << 6) | alphabet.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

export default class Signed extends View {
  init(_props, cx) {
    this.focus = cx.focus_handle();
    this.editFocus = cx.focus_handle();
    /** @type {Signature[]} */
    this.signatures = storage.get("signed.signatures", []);
    /** @type {string[]} */
    this.recent = storage.get("signed.recent", []);
    this.seq = 1;
    /** The user's home directory, learned once so `~` paths and Finder work. */
    this.home = "";
    /** @type {string | null} */
    this.selectedId = null;
    /** @type {{ id: string, state: any } | null} */
    this.editor = null;
    /** @type {{ id: string, mode: "move" | "resize", x: number, y: number, rect: { x: number, y: number, w: number, h: number } } | null} */
    this.drag = null;
    this.overlay = /** @type {"signatures" | "openMenu" | "saveMenu" | "open" | "pad" | "help" | null} */ (null);
    this.pad = { mode: /** @type {"draw" | "type"} */ ("draw"), strokes: /** @type {[number, number][][]} */ ([]), drawing: false, ink: palette.inks[0], weight: "medium" };
    this.padName = InputState.new({ placeholder: "Your name", value: "" });
    this.padName.on("change", (_e, cx) => cx.notify());
    this.pathInput = InputState.new({ placeholder: "~/Documents/contract.pdf" });
    this.pathInput.on("submit", (_e, cx) => this.openPath(this.pathInput.value(), cx));
    this.saving = false;
    this.loading = "";
    /** Absolute path of the last signed copy, for Show in Finder. */
    this.savedPath = "";
    this.savedLabel = "";
    this.error = "";
    /** @type {{ title: string, description?: string, level?: string } | null} */
    this.notice = null;

    // The built-in sample is generated as a real PDF and opened through the
    // same parser as any other file.
    this.load(buildPdf({ title: sampleLease.name, pages: layout(sampleLease), items: [] }), sampleLease.name, "");
    cx.timer.after(0, () => this.focus.focus());
    if (mac) {
      cx.spawn(async (cx) => {
        try {
          const out = await process.run("osascript", ["-e", "POSIX path of (path to home folder)"]);
          if (out.code === 0) this.home = out.stdout.trim().replace(/\/$/, "");
        } catch (error) {
          console.error("Signed: cannot find the home folder:", error);
        }
        cx.notify();
      });
    }
  }

  /** Shows a PDF. Throws when it cannot be read. @param {Uint8Array} bytes @param {string} name @param {string} path */
  load(bytes, name, path) {
    const opened = openPdf(bytes);
    this.pdf = { bytes, name, path, ...opened };
    this.docKey = `signed.items.${name}.${bytes.length}`;
    /** @type {Item[]} */
    this.items = storage.get(this.docKey, []);
    this.page = 0;
    this.dirty = false;
    this.selectedId = null;
    this.editor = null;
    this.savedPath = "";
    this.savedLabel = "";
  }

  /** Display pixels per PDF point on page `index`. */
  scaleOf(index) {
    return PAGE_WIDTH / (this.pdf.models[index]?.width || 612);
  }

  get model() {
    return this.pdf.models[this.page];
  }

  get pageHeight() {
    return Math.round(this.model.height * this.scaleOf(this.page));
  }

  get selected() {
    return this.items.find((item) => item.id === this.selectedId) ?? null;
  }

  changed(cx) {
    this.dirty = true;
    cx.notify();
  }

  // -- Placing and editing ---------------------------------------------------

  slot(w, h) {
    const count = this.items.filter((item) => item.page === this.page).length;
    return { x: Math.round((PAGE_WIDTH - w) / 2), y: Math.min(this.pageHeight - h - 20, 240 + (count % 8) * 34) };
  }

  /** @param {Item} item */
  place(item, cx) {
    this.items.push(item);
    this.selectedId = item.id;
    this.overlay = null;
    this.focus.focus();
    this.changed(cx);
  }

  /** @param {Signature} signature */
  placeSignature(signature, cx) {
    const h = 56;
    const w = Math.round(Math.min(380, h * signature.aspect));
    this.place({
      id: `item-${Date.now()}-${this.seq++}`, page: this.page, kind: "signature", ...this.slot(w, h), w, h,
      strokes: signature.strokes, color: signature.color, weight: signature.weight,
    }, cx);
  }

  /** @param {"text" | "date"} kind */
  placeText(kind, cx) {
    const text = kind === "date" ? formatDate(new Date()) : "Text";
    const box = textBox(text, 16);
    const item = /** @type {Item} */ ({ id: `item-${Date.now()}-${this.seq++}`, page: this.page, kind, ...this.slot(box.w, box.h), ...box, text });
    this.place(item, cx);
    if (kind === "text") this.startEditing(item, cx);
  }

  /** @param {Item} item */
  startEditing(item, cx) {
    this.finishEditing(cx);
    const state = TextareaState.new({ value: item.text ?? "" });
    state.set_soft_wrap(false);
    const size = fontSize(item);
    state.on("change", (_event, cx) => {
      item.text = state.value();
      item.h = Math.ceil(item.text.split("\n").length * size * TEXT_LINE + TEXT_PAD * 2);
      fitText(item);
      this.changed(cx);
    });
    this.editor = { id: item.id, state };
    this.selectedId = item.id;
    cx.notify();
    cx.timer.after(0, () => this.editFocus.focus());
  }

  finishEditing(cx) {
    if (!this.editor) return;
    const item = this.items.find((it) => it.id === this.editor?.id);
    this.editor.state.release();
    this.editor = null;
    if (item && !(item.text ?? "").trim()) this.remove(item.id, cx);
    this.focus.focus();
    cx.notify();
  }

  remove(id, cx) {
    this.items = this.items.filter((item) => item.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.changed(cx);
  }

  scale(factor, cx) {
    const item = this.selected;
    if (!item) return;
    item.w = Math.max(16, Math.round(item.w * factor));
    item.h = Math.max(12, Math.round(item.h * factor));
    this.changed(cx);
  }

  // -- Pointer ---------------------------------------------------------------

  /** @param {Item} item @param {"move" | "resize"} mode */
  startDrag(item, mode, event, cx) {
    cx.stop_propagation();
    if (this.editor?.id === item.id && mode === "move") return;
    if (this.editor) this.finishEditing(cx);
    this.selectedId = item.id;
    this.overlay = null;
    if (event.click_count >= 2 && item.kind !== "signature" && mode === "move") return this.startEditing(item, cx);
    this.drag = { id: item.id, mode, x: event.position.x, y: event.position.y, rect: { x: item.x, y: item.y, w: item.w, h: item.h } };
    this.focus.focus();
    cx.notify();
  }

  onPointerMove(event, cx) {
    const drag = this.drag;
    if (!drag) return;
    const item = this.items.find((it) => it.id === drag.id);
    if (!item) return;
    const dx = event.position.x - drag.x;
    const dy = event.position.y - drag.y;
    if (drag.mode === "move") {
      item.x = Math.round(Math.max(-item.w / 2, Math.min(PAGE_WIDTH - item.w / 2, drag.rect.x + dx)));
      item.y = Math.round(Math.max(0, Math.min(this.pageHeight - item.h / 2, drag.rect.y + dy)));
    } else if (item.kind === "signature") {
      // A signature keeps its proportions.
      const ratio = drag.rect.w / drag.rect.h;
      const w = Math.max(30, drag.rect.w + Math.max(dx, dy * ratio));
      item.w = Math.round(w);
      item.h = Math.round(w / ratio);
    } else {
      item.w = Math.round(Math.max(20, drag.rect.w + dx));
      item.h = Math.round(Math.max(14, drag.rect.h + dy));
    }
    if (dx || dy) this.dirty = true;
    cx.notify();
  }

  // -- Keyboard --------------------------------------------------------------

  onKey(event, cx) {
    const key = event.key;
    if (this.editor) {
      if (key === "escape") this.finishEditing(cx);
      return;
    }
    if (event.keystroke === "cmd-shift-s" || event.keystroke === "ctrl-shift-s") return this.saveAs(cx);
    if (event.keystroke === "cmd-s" || event.keystroke === "ctrl-s") return this.save(cx);
    if (event.keystroke === "cmd-o" || event.keystroke === "ctrl-o") return this.showOpen(cx);
    if (this.overlay === "pad" || this.overlay === "open") {
      if (key === "escape") this.closeOverlay(cx);
      return;
    }
    if (event.modifiers.platform || event.modifiers.control) return;
    const item = this.selected;
    const step = event.modifiers.shift ? 10 : 1;
    switch (key) {
      case "s": return this.signatureShortcut(cx);
      case "t": return this.placeText("text", cx);
      case "d": return this.placeText("date", cx);
      case "[": return this.scale(1 / 1.1, cx);
      case "]": return this.scale(1.1, cx);
      case "escape":
        this.overlay = null;
        this.selectedId = null;
        return cx.notify();
      case "backspace":
      case "delete":
        if (item) this.remove(item.id, cx);
        return;
      case "enter":
        if (item && item.kind !== "signature") this.startEditing(item, cx);
        return;
      case "up": case "down": case "left": case "right":
        if (!item) return;
        if (key === "up") item.y -= step;
        if (key === "down") item.y += step;
        if (key === "left") item.x -= step;
        if (key === "right") item.x += step;
        return this.changed(cx);
      case "pageup": return this.goTo(this.page - 1, cx);
      case "pagedown": return this.goTo(this.page + 1, cx);
    }
  }

  /** S places the most recent signature; with none saved yet it opens the pad. */
  signatureShortcut(cx) {
    const latest = this.signatures[this.signatures.length - 1];
    if (latest) this.placeSignature(latest, cx);
    else this.openPad(cx);
  }

  goTo(page, cx) {
    if (page < 0 || page >= this.pdf.pages.length) return;
    this.page = page;
    this.selectedId = null;
    cx.notify();
  }

  closeOverlay(cx) {
    this.overlay = null;
    this.pad.drawing = false;
    this.focus.focus();
    cx.notify();
  }

  // -- Signature library -----------------------------------------------------

  openPad(cx) {
    this.pad.strokes = [];
    this.pad.drawing = false;
    this.overlay = "pad";
    cx.notify();
  }

  /** The signature the pad would save right now, or null. */
  padResult() {
    if (this.pad.mode === "type") {
      const typed = typedSignature(this.padName.value());
      return typed && { ...typed, weight: 0.035 };
    }
    const fitted = normalize(this.pad.strokes);
    const px = weights.find((w) => w.id === this.pad.weight)?.px ?? 2.6;
    return fitted && { aspect: fitted.aspect, strokes: fitted.strokes, weight: px / fitted.height };
  }

  saveSignature(cx) {
    const result = this.padResult();
    if (!result) return;
    const name = this.padName.value().trim() || `Signature ${this.signatures.length + 1}`;
    /** @type {Signature} */
    const signature = { id: `sig-${Date.now()}-${this.seq++}`, name, color: this.pad.ink, ...result };
    this.signatures.push(signature);
    storage.set("signed.signatures", this.signatures);
    this.closeOverlay(cx);
    this.placeSignature(signature, cx);
  }

  deleteSignature(id, cx) {
    this.signatures = this.signatures.filter((s) => s.id !== id);
    storage.set("signed.signatures", this.signatures);
    if (!this.signatures.length && this.overlay === "signatures") this.overlay = null;
    cx.notify();
  }

  // -- Files -----------------------------------------------------------------

  /** Open: the native file dialog on macOS, the path field elsewhere. */
  showOpen(cx) {
    this.finishEditing(cx);
    this.error = "";
    if (mac) {
      this.overlay = null;
      this.choose(cx);
    } else this.overlay = "open";
    cx.notify();
  }

  showPathField(cx) {
    this.overlay = "open";
    this.error = "";
    cx.notify();
  }

  /** The native macOS file chooser, through AppleScript. */
  choose(cx) {
    cx.spawn(async (cx) => {
      try {
        const out = await process.run("osascript", ["-e", 'POSIX path of (choose file with prompt "Open a document to sign" of type {"pdf", "txt", "md"})']);
        if (out.code === 0 && out.stdout.trim()) await this.openPath(out.stdout.trim(), cx);
      } catch (error) {
        this.error = `The file chooser is unavailable: ${error?.message ?? error}`;
        this.overlay = "open";
        cx.notify();
      }
    });
  }

  expand(path) {
    const trimmed = path.trim().replace(/^["']|["']$/g, "");
    return trimmed.startsWith("~/") && this.home ? `${this.home}${trimmed.slice(1)}` : trimmed;
  }

  /**
   * Reads a file the user named. The runtime's fs grants cover the data
   * directory; anywhere else is read through `base64`, a command that can only
   * print the file it is given.
   */
  async readAnywhere(path) {
    try {
      return await readFile(path);
    } catch (error) {
      if (!/outside every granted read root/.test(String(error?.message ?? error))) throw error;
    }
    const out = await process.run("base64", mac ? ["-i", path] : ["-w0", path]);
    if (out.code !== 0) throw new Error(out.stderr.trim() || `cannot read ${path}`);
    return decodeBase64(out.stdout);
  }

  async openPath(raw, cx) {
    const path = this.expand(raw);
    if (!path) return;
    if (!path.startsWith("/")) {
      this.error = "Enter an absolute path, or one starting with ~/";
      return cx.notify();
    }
    const name = path.split("/").pop() ?? "document.pdf";
    this.loading = name;
    this.error = "";
    cx.notify();
    try {
      let bytes = await this.readAnywhere(path);
      let pdfName = name;
      if (/\.(txt|md|markdown)$/i.test(name)) {
        const text = decodeUtf8(bytes);
        pdfName = name.replace(/\.[^.]+$/, ".pdf");
        bytes = buildPdf({ title: pdfName, pages: layout(docFromText(pdfName, text)), items: [] });
      }
      this.load(bytes, pdfName, path);
      this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 8);
      storage.set("signed.recent", this.recent);
      this.overlay = null;
      this.focus.focus();
    } catch (error) {
      this.error = `Could not open ${name}: ${error?.message ?? error}`;
      this.overlay = "open";
    } finally {
      this.loading = "";
      cx.notify();
    }
  }

  openSample(cx) {
    this.load(buildPdf({ title: sampleLease.name, pages: layout(sampleLease), items: [] }), sampleLease.name, "");
    this.overlay = null;
    cx.notify();
  }

  /** Where `${dataDir}` is, as an absolute path, once the home folder is known. */
  dataDir() {
    if (!this.home) return "";
    const folder = dataDirName(appRoot(), this.home);
    return mac ? `${this.home}/Library/Application Support/gpui-shell/apps/${folder}` : `${this.home}/.local/share/gpui-shell/apps/${folder}`;
  }

  /** The signed file, or null after telling the user why there is none. */
  signedBytes(cx) {
    this.finishEditing(cx);
    if (!this.items.length) {
      this.notify(cx, { title: "Nothing to save yet", description: "Place a signature, text or date first.", level: "info" });
      return null;
    }
    try {
      return signIncrementally(this.pdf.bytes, this.pdf.doc, this.pdf.pages, this.items, (i) => this.scaleOf(i));
    } catch (error) {
      this.notify(cx, { title: "Could not sign this PDF", description: String(error?.message ?? error), level: "error" });
      return null;
    }
  }

  /** Runs one save: `write(bytes)` answers the absolute path it wrote. */
  runSave(cx, write) {
    if (this.saving) return;
    const bytes = this.signedBytes(cx);
    if (!bytes) return;
    this.saving = true;
    this.overlay = null;
    cx.notify();
    const items = this.items.map((item) => ({ ...item }));
    cx.spawn(async (cx) => {
      try {
        const path = await write(bytes);
        if (!path) return; // cancelled
        storage.set(this.docKey, items);
        this.dirty = false;
        this.savedPath = path;
        this.savedLabel = path.split("/").pop() ?? path;
        this.notify(cx, { title: "Signed copy saved", description: `${path} · ${Math.round(bytes.length / 102.4) / 10} KB`, level: "success" });
      } catch (error) {
        this.notify(cx, { title: "Could not save the signed copy", description: String(error?.message ?? error), level: "error" });
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  /** Save: `<name>-signed.pdf` in the app's Signed copies folder. */
  save(cx) {
    const name = signedName(this.pdf.name);
    this.runSave(cx, async (bytes) => {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(`${OUT_DIR}/${name}`, bytes);
      const root = this.dataDir();
      return root ? `${root}/${OUT_DIR}/${name}` : `${OUT_DIR}/${name}`;
    });
  }

  /**
   * Save As: the native save dialog picks the place. The app may only write
   * its data directory, so the bytes are staged there as base64 and `base64`
   * decodes them to the chosen file.
   */
  saveAs(cx) {
    if (!mac || !this.dataDir()) {
      this.notify(cx, { title: "Save As needs macOS", description: "Use Save; the copy goes to the Signed copies folder.", level: "info" });
      return;
    }
    const name = signedName(this.pdf.name);
    this.runSave(cx, async (bytes) => {
      const out = await process.run("osascript", ["-e", `POSIX path of (choose file name with prompt "Save the signed copy" default name ${JSON.stringify(name)})`]);
      if (out.code !== 0) return ""; // the dialog was cancelled
      let target = out.stdout.trim();
      if (!/\.pdf$/i.test(target)) target += ".pdf";
      const staged = ".save-as.b64";
      await writeFile(staged, encodeBase64(bytes));
      try {
        const decoded = await process.run("base64", ["-D", "-i", `${this.dataDir()}/${staged}`, "-o", target]);
        if (decoded.code !== 0) throw new Error(decoded.stderr.trim() || `cannot write ${target}`);
      } finally {
        await unlink(staged).catch(() => {});
      }
      return target;
    });
  }

  /** `open -R` shows the file in Finder; plain `open` opens it. */
  reveal(open, cx) {
    if (!this.savedPath) return;
    const args = mac ? (open ? [this.savedPath] : ["-R", this.savedPath]) : [open ? this.savedPath : this.savedPath.replace(/\/[^/]+$/, "")];
    cx.spawn(async (cx) => {
      try {
        const out = await process.run(mac ? "open" : "xdg-open", args);
        if (out.code !== 0) throw new Error(out.stderr || `exit ${out.code}`);
      } catch (error) {
        this.notify(cx, { title: "Could not open Finder", description: String(error?.message ?? error), level: "error" });
      }
    });
  }

  /**
   * A message in the corner that retires itself. (`window.push_toast` needs a
   * host root view this window does not have, so the app draws its own.)
   * @param {{ title: string, description?: string, level?: "info" | "success" | "error" }} notice
   */
  notify(cx, notice) {
    if (notice.level === "error") console.error(`Signed: ${notice.title}: ${notice.description ?? ""}`);
    this.notice = notice;
    const revision = (this.noticeRevision = (this.noticeRevision ?? 0) + 1);
    cx.timer.after(notice.level === "error" ? 9000 : 6000, (cx) => {
      if (this.noticeRevision !== revision) return;
      this.notice = null;
      cx.notify();
    });
    cx.notify();
  }

  // -- Rendering -------------------------------------------------------------

  render(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .relative()
      .size_full()
      .bg(colors.background)
      .text_color(colors.foreground)
      .track_focus(this.focus)
      .key_context("Signed")
      .on_key_down((event, cx) => this.onKey(event, cx))
      .on_mouse_move((event, cx) => this.onPointerMove(event, cx))
      .on_mouse_up("left", (_event, cx) => {
        if (this.drag) {
          this.drag = null;
          cx.notify();
        }
        this.pad.drawing = false;
      })
      .child(this.header(cx))
      .child(h_flex().flex_1().min_h(0).child(this.thumbnails(cx)).child(this.canvas(cx)))
      .child(this.statusBar(cx))
      .when(this.overlay === "signatures", (el) => el.child(this.signatureMenu(cx)))
      .when(this.overlay === "openMenu", (el) => el.child(this.openMenu(cx)))
      .when(this.overlay === "saveMenu", (el) => el.child(this.saveMenu(cx)))
      .when(this.overlay === "help", (el) => el.child(this.helpCard(cx)))
      .when(Boolean(this.notice), (el) => el.child(this.noticeCard(cx)))
      .when(this.overlay === "open", (el) => el.child(this.openDialog(cx)))
      .when(this.overlay === "pad", (el) => el.child(this.padDialog(cx)));
  }

  /**
   * One bar for the window: the document on the left, the three placing tools
   * as a segmented group in the middle, and the file actions on the right. It
   * is the title bar too, so the empty parts of it drag the window.
   */
  header(cx) {
    const colors = cx.theme().colors;
    const keep = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const glyph = (name, color = colors.foreground) => new Icon(`signed/icons/${name}.svg`).size("small").color(color);
    /** A segment of the tool group: icon, label and its one-letter shortcut. */
    const tool = (id, iconName, label, key, active, onClick, trailing = null) =>
      div()
        .id(id)
        .h(32)
        .when(Boolean(label), (el) => el.pl(11).pr(9))
        .when(!label, (el) => el.w(36).justify_center())
        .gap(7)
        .flex()
        .items_center()
        .rounded(7)
        .text_size(13)
        .font_weight(500)
        .cursor_pointer()
        .when(active, (el) => el.bg(colors.background).border(1).border_color(colors.border))
        .when(!active, (el) => el.hover((h) => h.bg(colors.background)))
        .on_click(onClick)
        .child(glyph(iconName))
        .when(Boolean(label), (el) => el.child(label))
        .when(Boolean(trailing), (el) => el.child(trailing));
    /** A header action; `primary` fills it with the accent. */
    const action = (id, iconName, label, primary, onClick, tooltip) =>
      div()
        .id(id)
        .h(34)
        .px(label ? 13 : 0)
        .when(!label, (el) => el.w(34).justify_center())
        .gap(7)
        .flex()
        .items_center()
        .rounded(8)
        .text_size(13)
        .font_weight(primary ? 600 : 500)
        .cursor_pointer()
        .when(primary, (el) => el.bg(colors.primary).text_color(colors.primary_foreground).hover((h) => h.opacity(0.88)))
        .when(!primary, (el) => el.border(1).border_color(colors.border).bg(colors.background).hover((h) => h.bg(colors.secondary)))
        .on_click(onClick)
        .child(glyph(iconName, primary ? colors.primary_foreground : colors.foreground))
        .when(Boolean(label), (el) => el.child(label));
    /** A button with a menu chevron fused to its right edge. */
    const split = (id, label, primary, onClick, menu) => {
      const fg = primary ? colors.primary_foreground : colors.foreground;
      const part = (partId) => div().id(partId).h_full().flex().items_center().cursor_pointer()
        .hover((h) => (primary ? h.bg("#ffffff1f") : h.bg(colors.secondary)));
      return h_flex()
        .h(34)
        .rounded(8)
        .overflow_hidden()
        .text_size(13)
        .font_weight(primary ? 600 : 500)
        .when(primary, (el) => el.bg(colors.primary).text_color(fg))
        .when(!primary, (el) => el.border(1).border_color(colors.border).bg(colors.background))
        .child(part(id).pl(14).pr(12).on_click(onClick).child(label))
        .child(div().w(1).h(18).bg(primary ? "#ffffff33" : colors.border))
        .child(part(`${id}-menu`).px(7).on_click((_e, cx) => {
          this.overlay = this.overlay === menu ? null : menu;
          cx.notify();
        }).child(glyph("chevron-down", fg)));
    };
    return new TitleBar()
      .h(58)
      .bg(colors.background)
      .border_b(1)
      .border_color(colors.border)
      .child(
        h_flex()
          .flex_1()
          .h_full()
          .pr(14)
          .items_center()
          .gap(16)
          .child(
            h_flex().flex_1().gap(10).items_center().min_w(0)
              .child(div().size(30).flex_shrink_0().rounded(8).bg(colors.secondary).flex().items_center().justify_center()
                .child(glyph("file", colors.muted_foreground)))
              .child(div().text_size(13).font_weight(600).truncate().child(this.pdf.name))
              .when(this.dirty, (el) => el.child(div().size(6).flex_shrink_0().rounded_full().bg("#f59e0b"))),
          )
          .child(keep(
            h_flex().flex_shrink_0().h(40).px(4).gap(2).items_center().rounded(10).bg(colors.secondary)
              .child(tool("tool-signature", "signature", "Signature", "S", this.overlay === "signatures", (_e, cx) => {
                if (!this.signatures.length) return this.openPad(cx);
                this.overlay = this.overlay === "signatures" ? null : "signatures";
                cx.notify();
              }, glyph("chevron-down", colors.muted_foreground)))
              .child(div().w(1).h(16).bg(colors.border))
              .child(tool("tool-text", "text", "", "T", false, (_e, cx) => this.placeText("text", cx)))
              .child(div().w(1).h(16).bg(colors.border))
              .child(tool("tool-date", "calendar", "", "D", false, (_e, cx) => this.placeText("date", cx))),
          ))
          .child(keep(
            h_flex().flex_1().justify_end().gap(8).items_center()
              .when(Boolean(this.selected), (el) =>
                el.child(action("delete-item", "trash", "", false, (_e, cx) => this.selected && this.remove(this.selected.id, cx))))
              .child(split("open", "Open", false, (_e, cx) => this.showOpen(cx), "openMenu"))
              .child(split("save", this.saving ? "Saving…" : "Save", false, (_e, cx) => this.save(cx), "saveMenu")),
          )),
      );
  }

  thumbnails(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .id("thumbnails")
      .w(156)
      .flex_shrink_0()
      .h_full()
      .overflow_y_scroll()
      .bg(colors.secondary)
      .border_r(1)
      .border_color(colors.border)
      .items_center()
      .py(16)
      .gap(12)
      .children(this.pdf.models.map((model, index) => {
        const s = THUMB_WIDTH / model.width;
        const ps = this.scaleOf(index);
        return v_flex()
          .items_center()
          .gap(6)
          .child(
            div()
              .id(`page-${index}`)
              .p(3)
              .rounded(6)
              .border(2)
              .border_color(index === this.page ? palette.selection : "#00000000")
              .cursor_pointer()
              .on_click((_e, cx) => this.goTo(index, cx))
              .child(
                div()
                  .relative()
                  .w(THUMB_WIDTH)
                  .h(Math.round(model.height * s))
                  .bg(palette.paper)
                  .border(1)
                  .border_color(colors.border)
                  .overflow_hidden()
                  .children(model.paths.length <= 400 ? shapes(model, s) : [])
                  .children(model.texts.slice(0, 400).map((t) =>
                    div().absolute().left(t.x * s).top((t.y - t.size * 0.6) * s).w(Math.max(1, t.width * s)).h(Math.max(0.8, t.size * s * 0.45)).bg(palette.thumbBar)))
                  .children(this.items.filter((item) => item.page === index).map((item) => {
                    const k = s / ps;
                    return div().absolute().left(item.x * k).top(item.y * k).w(item.w * k).h(item.h * k)
                      .when(item.kind === "signature", (el) => el.children(ink(item.strokes ?? [], 0.8, item.color ?? palette.inks[0])))
                      .when(item.kind !== "signature", (el) => el.child(div().mt(item.h * k * 0.3).h(Math.max(1, item.h * k * 0.35)).w_full().bg("#666")));
                  })),
              ),
          )
          .child(div().text_size(12).text_color(colors.muted_foreground).child(String(index + 1)));
      }));
  }

  canvas(cx) {
    const colors = cx.theme().colors;
    const model = this.model;
    const s = this.scaleOf(this.page);
    const familyOf = (family) => (family === "serif" ? fonts.serif : family === "mono" ? fonts.mono : fonts.sans);
    return div()
      .id(`canvas-${this.page}`)
      .flex_1()
      .h_full()
      .overflow_y_scroll()
      .bg(colors.muted)
      .child(
        h_flex().justify_center().py(24).child(
          div()
            .relative()
            .flex_shrink_0()
            .w(PAGE_WIDTH)
            .h(this.pageHeight)
            .bg(palette.paper)
            .shadow_md()
            .overflow_hidden()
            .text_color(palette.paperInk)
            .on_mouse_down("left", (_event, cx) => {
              this.overlay = null;
              this.selectedId = null;
              this.finishEditing(cx);
              this.focus.focus();
              cx.notify();
            })
            .children(model.images.map((image) =>
              div().absolute().left(image.x * s).top(image.y * s).w(image.w * s).h(image.h * s).bg(palette.placeholder)
                .flex().items_center().justify_center().text_size(11).text_color("#8a8a92").child("image")))
            .children(shapes(model, s))
            .children(model.texts.map((t) =>
              div()
                .absolute()
                .left(t.x * s)
                .top((t.y - t.size * 0.86) * s)
                .whitespace_nowrap()
                .font_family(familyOf(t.family))
                .text_size(Math.max(1, t.size * s))
                .line_height(1.1)
                .text_color(t.color)
                .when(t.bold, (el) => el.font_weight(700))
                .when(t.italic, (el) => el.italic())
                .child(t.text)))
            .children(this.items.filter((item) => item.page === this.page).map((item) => this.itemView(item))),
        ),
      );
  }

  /** @param {Item} item */
  itemView(item) {
    const selected = item.id === this.selectedId;
    const editing = this.editor?.id === item.id;
    const size = fontSize(item);
    return div()
      .id(item.id)
      .absolute()
      .left(item.x)
      .top(item.y)
      .w(item.w)
      .h(item.h)
      .rounded(2)
      .border(1.5)
      .border_color(selected ? palette.selection : "#00000000")
      .when(!selected, (el) => el.hover((h) => h.border_color(palette.selectionSoft)))
      .when(!editing, (el) => el.cursor_move())
      .on_mouse_down("left", (event, cx) => this.startDrag(item, "move", event, cx))
      .when(item.kind === "signature", (el) =>
        el.child(div().absolute().inset_0().children(ink(item.strokes ?? [], Math.max(0.6, (item.weight ?? 0.035) * item.h), item.color ?? palette.inks[0]))))
      .when(item.kind !== "signature" && !editing, (el) =>
        el.child(
          v_flex()
            .absolute()
            .left(TEXT_PAD - 1.5)
            .top(TEXT_PAD - 1.5)
            .font_family(fonts.sans)
            .text_size(size)
            .line_height(TEXT_LINE)
            .text_color(palette.paperInk)
            .children((item.text ?? "").split("\n").map((line) => div().whitespace_nowrap().child(line || " ")))))
      .when(editing, (el) =>
        el.child(
          Textarea.new(this.editor?.state)
            .track_focus(this.editFocus)
            .absolute()
            .inset_0()
            .px(TEXT_PAD - 1.5)
            .py(TEXT_PAD - 1.5)
            .bg(palette.selectionSoft)
            .font_family(fonts.sans)
            .text_size(size)
            .line_height(TEXT_LINE)
            .text_color(palette.paperInk)))
      .when(selected && !editing, (el) =>
        el.child(
          div()
            .id(`${item.id}-corner`)
            .absolute()
            .right(-6)
            .bottom(-6)
            .size(11)
            .rounded_full()
            .border(2)
            .border_color(palette.paper)
            .bg(palette.selection)
            .cursor_nwse_resize()
            .on_mouse_down("left", (event, cx) => this.startDrag(item, "resize", event, cx))));
  }

  statusBar(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .h(30)
      .flex_shrink_0()
      .px(12)
      .gap(8)
      .items_center()
      .border_t(1)
      .border_color(colors.border)
      .text_size(12)
      .text_color(colors.muted_foreground)
      .child(`Page ${this.page + 1} of ${this.pdf.pages.length}`)
      .when(this.model.truncated, (el) => el.child("· simplified"))
      .when(Boolean(this.savedPath) && !this.dirty, (el) =>
        el
          .child(div().text_color(colors.muted_foreground).child("· Saved"))
          .child(new Button("reveal").ghost().size("xsmall").on_click((_e, cx) => this.reveal(false, cx)).child(mac ? "Show in Finder" : "Show folder")))
      .child(div().flex_1())
      .child(new Button("help").ghost().size("xsmall").tooltip("Keyboard shortcuts").on_click((_e, cx) => {
        this.overlay = this.overlay === "help" ? null : "help";
        cx.notify();
      }).child(icon("help")));
  }

  noticeCard(cx) {
    const colors = cx.theme().colors;
    const notice = this.notice;
    const tone = notice.level === "error" ? colors.destructive : notice.level === "success" ? "#16a34a" : colors.muted_foreground;
    return this.card(cx)
      .bottom(44)
      .right(12)
      .w(380)
      .p(12)
      .gap(4)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded_full().bg(tone))
        .child(div().flex_1().text_size(13).font_weight(600).child(notice.title))
        .child(new Button("notice-close").ghost().size("xsmall").on_click((_e, cx) => { this.notice = null; cx.notify(); }).child(icon("close"))))
      .when(Boolean(notice.description), (el) => el.child(div().pl(16).text_size(12).text_color(colors.muted_foreground).child(notice.description)))
      .when(notice.level === "success" && Boolean(this.savedPath), (el) => el.child(
        h_flex().pl(10).pt(4).gap(4)
          .child(new Button("notice-reveal").outline().size("xsmall").on_click((_e, cx) => this.reveal(false, cx)).child(mac ? "Show in Finder" : "Show folder"))
          .child(new Button("notice-open").outline().size("xsmall").on_click((_e, cx) => this.reveal(true, cx)).child("Open"))));
  }

  /** A one-line text field framed like the host's own inputs. */
  field(state, cx) {
    const colors = cx.theme().colors;
    return Input.new(state).h(32).px(10).rounded(6).border(1).border_color(colors.border).bg(colors.background).text_size(13);
  }

  /** A floating panel that keeps presses from reaching the page beneath it. */
  card(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .absolute()
      .p(6)
      .rounded(8)
      .bg(colors.background)
      .border(1)
      .border_color(colors.border)
      .shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  }

  signatureMenu(cx) {
    const colors = cx.theme().colors;
    return this.card(cx)
      .top(58)
      .left(Math.max(12, Math.round(window.viewport_size().width / 2) - 190))
      .w(300)
      .gap(2)
      .child(div().px(8).pt(4).pb(2).text_size(12).text_color(colors.muted_foreground).child("Saved signatures"))
      .children(this.signatures.map((signature) =>
        h_flex()
          .gap(4)
          .items_center()
          .child(
            div()
              .id(`use-${signature.id}`)
              .flex_1()
              .flex()
              .items_center()
              .gap(10)
              .p(6)
              .rounded(6)
              .cursor_pointer()
              .hover((el) => el.bg(colors.secondary))
              .on_click((_e, cx) => this.placeSignature(signature, cx))
              .child(div().relative().w(112).h(40).flex_shrink_0().rounded(4).bg(palette.paper).border(1).border_color(colors.border)
                .child(div().absolute().top(4).bottom(4).left(6).right(6).children(ink(signature.strokes, 1.4, signature.color ?? palette.inks[0]))))
              .child(div().flex_1().truncate().text_size(13).child(signature.name)),
          )
          .child(new Button(`delete-${signature.id}`).ghost().size("xsmall").tooltip("Delete this signature")
            .on_click((_e, cx) => this.deleteSignature(signature.id, cx)).child(icon("trash")))))
      .child(new Separator().my(4))
      .child(new Button("add-signature").ghost().size("small").on_click((_e, cx) => this.openPad(cx))
        .child(h_flex().gap(6).items_center().child(icon("plus")).child("Add signature…")));
  }

  helpCard(cx) {
    const colors = cx.theme().colors;
    const rows = [
      ["s", "Place the latest signature"], ["t", "Add a text box"], ["d", "Add today's date"],
      ["[", "Shrink the selection"], ["]", "Grow the selection"], ["enter", "Edit text"],
      ["backspace", "Delete the selection"], ["cmd-o", "Open a document"], ["cmd-s", "Save signed copy"], ["escape", "Deselect"],
    ];
    return this.card(cx)
      .bottom(40)
      .right(12)
      .w(300)
      .p(12)
      .gap(8)
      .child(div().text_size(13).font_weight(600).child("Keyboard shortcuts"))
      .children(rows.map(([key, label]) =>
        h_flex().items_center().text_size(13).child(div().w(96).child(new Kbd(key))).child(div().text_color(colors.muted_foreground).child(label))))
      .child(div().text_size(12).text_color(colors.muted_foreground).child("Arrows nudge the selection; hold Shift for 10 px."));
  }

  /** A centred modal over a dimmed window. */
  modal(cx, width, title, body) {
    const colors = cx.theme().colors;
    return div()
      .absolute()
      .inset_0()
      .bg("#00000066")
      .flex()
      .items_center()
      .justify_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(
        v_flex()
          .w(width)
          .p(20)
          .gap(14)
          .rounded(10)
          .bg(colors.background)
          .border(1)
          .border_color(colors.border)
          .shadow_lg()
          .child(h_flex().items_center().child(div().flex_1().text_size(16).font_weight(600).child(title))
            .child(new Button("modal-close").ghost().size("xsmall").on_click((_e, cx) => this.closeOverlay(cx)).child(icon("close"))))
          .children(body),
      );
  }

  /** A row of a drop-down menu. */
  menuItem(id, iconName, label, cx, onClick, hint = "") {
    const colors = cx.theme().colors;
    return div()
      .id(id)
      .h(32)
      .px(8)
      .gap(9)
      .flex()
      .items_center()
      .rounded(6)
      .text_size(13)
      .cursor_pointer()
      .hover((el) => el.bg(colors.secondary))
      .on_click((_e, cx) => onClick(cx))
      .child(icon(iconName))
      .child(div().flex_1().truncate().child(label))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(colors.muted_foreground).child(hint)));
  }

  openMenu(cx) {
    const colors = cx.theme().colors;
    return this.card(cx)
      .top(54)
      .right(130)
      .w(280)
      .gap(1)
      .when(mac, (el) => el.child(this.menuItem("menu-choose", "folder", "Choose a file…", cx, (cx) => this.showOpen(cx), "⌘O")))
      .child(this.menuItem("menu-path", "file", "Enter a path…", cx, (cx) => this.showPathField(cx)))
      .child(new Separator().my(4))
      .child(div().px(8).pt(2).pb(4).text_size(11).text_color(colors.muted_foreground).child("Recent"))
      .child(this.menuItem("menu-sample", "file", "Sample agreement", cx, (cx) => this.openSample(cx)))
      .children(this.recent.map((path, index) =>
        this.menuItem(`menu-recent-${index}`, "file", path.split("/").pop() ?? path, cx, (cx) => this.openPath(path, cx))));
  }

  saveMenu(cx) {
    return this.card(cx)
      .top(54)
      .right(14)
      .w(240)
      .gap(1)
      .child(this.menuItem("menu-save", "check", "Save to Signed copies", cx, (cx) => this.save(cx), "⌘S"))
      .when(mac, (el) => el.child(this.menuItem("menu-save-as", "folder", "Save As…", cx, (cx) => this.saveAs(cx), "⇧⌘S")));
  }

  /** Typing a path: the fallback when no file dialog is available. */
  openDialog(cx) {
    const colors = cx.theme().colors;
    return this.modal(cx, 480, "Open a document", [
      h_flex().gap(8)
        .child(div().flex_1().child(this.field(this.pathInput, cx)))
        .child(new Button("open-path").primary().loading(Boolean(this.loading)).on_click((_e, cx) => this.openPath(this.pathInput.value(), cx)).child("Open")),
      ...(this.error ? [div().text_size(12).text_color(colors.destructive).child(this.error)] : []),
      div().text_size(12).text_color(colors.muted_foreground).child("A PDF, or a .txt / .md file. Paths may start with ~/"),
    ]);
  }

  fileRow(id, title, detail, onOpen, cx) {
    const colors = cx.theme().colors;
    return div()
      .id(id)
      .flex()
      .items_center()
      .gap(10)
      .px(8)
      .py(6)
      .rounded(6)
      .cursor_pointer()
      .hover((el) => el.bg(colors.secondary))
      .on_click((_e, cx) => onOpen(cx))
      .child(icon("file"))
      .child(v_flex().min_w(0).child(div().text_size(13).truncate().child(title))
        .when(Boolean(detail), (el) => el.child(div().text_size(11).truncate().text_color(colors.muted_foreground).child(detail))));
  }

  padDialog(cx) {
    const colors = cx.theme().colors;
    const pad = this.pad;
    const result = this.padResult();
    const weightPx = weights.find((w) => w.id === pad.weight)?.px ?? 2.6;
    const segment = (id, label, active, onClick) => {
      const button = new Button(id).size("small").on_click(onClick).child(label);
      return active ? button.secondary() : button.ghost();
    };
    const live = pad.strokes.map((stroke) => stroke.map(([x, y]) => /** @type {[number, number]} */ ([x / PAD.width, y / PAD.height])));
    const surface = pad.mode === "draw"
      ? div()
        .id("pad")
        .relative()
        .w(PAD.width)
        .h(PAD.height)
        .rounded(8)
        .border(1)
        .border_color(colors.border)
        .bg(palette.paper)
        .cursor_crosshair()
        .on_mouse_down("left", (event, cx) => {
          const p = event.local_position;
          if (!p) return;
          pad.drawing = true;
          pad.strokes.push([[p.x, p.y]]);
          cx.notify();
        })
        .on_mouse_move((event, cx) => {
          if (!pad.drawing) return;
          const stroke = pad.strokes[pad.strokes.length - 1];
          const before = stroke.length;
          addPoint(stroke, [Math.max(0, Math.min(PAD.width, event.local_position.x)), Math.max(0, Math.min(PAD.height, event.local_position.y))]);
          if (stroke.length !== before) cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          pad.drawing = false;
          cx.notify();
        })
        .child(div().absolute().left(28).right(28).bottom(44).h(1).bg("#d4d4d8"))
        .children(ink(live, weightPx, pad.ink))
        .when(!pad.strokes.length, (el) =>
          el.child(div().absolute().top(64).w_full().flex().justify_center().text_size(14).text_color("#a1a1aa").child("Sign here with your mouse or trackpad")))
      : div()
        .relative()
        .w(PAD.width)
        .h(PAD.height)
        .rounded(8)
        .border(1)
        .border_color(colors.border)
        .bg(palette.paper)
        .child(div().absolute().left(28).right(28).bottom(44).h(1).bg("#d4d4d8"))
        .when(Boolean(result), (el) => {
          const r = /** @type {NonNullable<typeof result>} */ (result);
          const h = Math.min(120, (PAD.width - 60) / r.aspect);
          const w = h * r.aspect;
          return el.child(div().absolute().left((PAD.width - w) / 2).top((PAD.height - h) / 2 - 8).w(w).h(h).children(ink(r.strokes, Math.max(1, r.weight * h), pad.ink)));
        })
        .when(!result, (el) => el.child(div().absolute().top(72).w_full().flex().justify_center().text_size(14).text_color("#a1a1aa").child("Type your name below")));

    return this.modal(cx, PAD.width + 40, "Add signature", [
      h_flex().gap(4)
        .child(segment("mode-draw", "Draw", pad.mode === "draw", (_e, cx) => { pad.mode = "draw"; cx.notify(); }))
        .child(segment("mode-type", "Type", pad.mode === "type", (_e, cx) => { pad.mode = "type"; cx.notify(); }))
        .child(div().flex_1())
        .children(palette.inks.map((color, index) =>
          div().id(`ink-${index}`).size(22).rounded_full().p(3).border(2).border_color(pad.ink === color ? palette.selection : "#00000000").cursor_pointer()
            .on_click((_e, cx) => { pad.ink = color; cx.notify(); })
            .child(div().size_full().rounded_full().bg(color))))
        .when(pad.mode === "draw", (el) => el
          .child(div().w(1).h(18).mx(4).bg(colors.border))
          .children(weights.map((w) => segment(`weight-${w.id}`, w.label, pad.weight === w.id, (_e, cx) => { pad.weight = w.id; cx.notify(); })))),
      surface,
      this.field(this.padName, cx),
      h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(colors.muted_foreground)
          .child(pad.mode === "draw" ? "The name labels it in your library." : "Typed names are drawn with a built-in script."))
        .when(pad.mode === "draw", (el) => el
          .child(new Button("pad-undo").ghost().size("small").disabled(!pad.strokes.length).on_click((_e, cx) => { pad.strokes.pop(); cx.notify(); }).child("Undo"))
          .child(new Button("pad-clear").ghost().size("small").disabled(!pad.strokes.length).on_click((_e, cx) => { pad.strokes = []; cx.notify(); }).child("Clear")))
        .child(new Button("pad-save").primary().size("small").disabled(!result).on_click((_e, cx) => this.saveSignature(cx)).child("Save and place")),
    ]);
  }
}
