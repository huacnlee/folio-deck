// Drives the real view (main.js) against a stand-in host: the signing flow
// from an empty library to a signed copy on disk, parsed back afterwards.
// `gpui-shell check` separately renders the same view with native elements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { openPdf } from "../pdfparse.js";
import { buildPdf } from "../pdf.js";
import { layout, docFromText } from "../doc.js";

const storage = new Map();
const files = new Map();
const runs = [];
const toasts = [];
const context = vm.createContext({
  // Only what gpui-shell provides: QuickJS has no TextEncoder or TextDecoder.
  console,
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
  window: { push_toast: (t) => toasts.push(t), paint_path: () => ({}) },
});
const InnerUint8Array = vm.runInContext("Uint8Array", context);

/** Swappable, because a linked module keeps the function it imported. */
const fsMock = {
  async readFile(path) {
    if (!files.has(path)) throw new Error(`ENOENT ${path}`);
    return InnerUint8Array.from(files.get(path));
  },
};
const state = () => {
  const handlers = {};
  let value = "";
  return { on: (e, f) => { handlers[e] = f; }, value: () => value, set_value: (v) => { value = v; handlers.change?.({}, cx); }, set_soft_wrap() {}, release() {}, handlers };
};
const host = {
  "gpui-kit": { View: class {}, div() {}, PathBuilder: {} },
  "gpui-base": { h_flex() {}, v_flex() {}, Textarea: {}, Input: {}, InputState: { new: (o) => { const s = state(); s.set_value(o?.value ?? ""); return s; } }, TextareaState: { new: (o) => { const s = state(); s.set_value(o?.value ?? ""); return s; } } },
  "gpui-component": Object.fromEntries(["Button", "Icon", "Kbd", "TitleBar", "Input", "Separator"].map((n) => [n, class {}])),
  "fs/promises": {
    mkdir: async () => {},
    unlink: async (path) => { files.delete(path); },
    writeFile: async (path, data) => { files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data)); },
    readFile: (path) => fsMock.readFile(path),
  },
  process: { default: { platform: "darwin", run: async (command, args) => { runs.push([command, ...args]); return { code: 0, stdout: "/Users/tester/\n", stderr: "" }; } } },
};

const modules = new Map();
/** Cached as a promise, so two imports of one file in flight share a module. */
function moduleAt(url) {
  if (!modules.has(url.href)) modules.set(url.href, readFile(url, "utf8").then((source) => new vm.SourceTextModule(source, { context, identifier: url.href })));
  return modules.get(url.href);
}
/** Node links the whole graph; the linker only has to name each module. */
async function linker(specifier, referencing) {
  if (specifier.startsWith("./")) return moduleAt(new URL(specifier, referencing.identifier));
  const exports = host[specifier];
  if (!exports) throw new Error(`unexpected import ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
  }, { context });
}

const tasks = [];
const cx = {
  notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
  timer: { after() {} },
  spawn: (body) => { tasks.push(body(cx)); },
};
const settle = async () => { while (tasks.length) await tasks.shift(); };

const main = await moduleAt(new URL("../main.js", import.meta.url));
await main.link(linker);
await main.evaluate();
const Signed = main.namespace.default;
const view = new Signed();
view.init(undefined, cx);
await settle();

test("the sample opens through the parser and the home folder is learned", () => {
  assert.equal(view.pdf.name, "sample-agreement.pdf");
  assert.equal(view.pdf.pages.length, 1);
  assert.equal(view.home, "/Users/tester");
  assert.deepEqual(runs[0], ["osascript", "-e", "POSIX path of (path to home folder)"]);
});

test("with no saved signature, Signature opens the pad; drawing saves and places one", () => {
  view.signatureShortcut(cx);
  assert.equal(view.overlay, "pad");
  view.pad.ink = "#1d4ed8";
  view.pad.weight = "bold";
  view.pad.strokes = [[[20, 120], [60, 40], [100, 120], [140, 60]], [[30, 140], [200, 130]]];
  view.pad.strokes.push([[5, 5]]); // a click, not a stroke
  view.pad.strokes.pop();
  view.padName.set_value("Initials");
  view.saveSignature(cx);
  assert.equal(view.overlay, null);
  assert.equal(view.signatures.length, 1);
  assert.equal(view.signatures[0].color, "#1d4ed8");
  assert.ok(view.signatures[0].weight > 0);
  assert.equal(JSON.parse(storage.get("signed.signatures")).length, 1, "the library is persisted");
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].kind, "signature");
  assert.ok(view.dirty);
});

test("a typed name becomes a second saved signature", () => {
  view.openPad(cx);
  view.pad.mode = "type";
  view.padName.set_value("Alex Morgan");
  assert.ok(view.padResult());
  view.saveSignature(cx);
  assert.equal(view.signatures.length, 2);
  assert.equal(view.signatures[1].name, "Alex Morgan");
  assert.equal(view.items.length, 2);
  // S now places the most recent signature without opening the pad.
  view.signatureShortcut(cx);
  assert.equal(view.overlay, null);
  assert.equal(view.items.length, 3);
  view.remove(view.items[2].id, cx);
});

test("items move, resize and are edited with the keyboard", () => {
  const item = view.items[1];
  const { x, y, w, h } = item;
  view.startDrag(item, "move", { position: { x: 100, y: 100 }, click_count: 1 }, cx);
  view.onPointerMove({ position: { x: 130, y: 140 } }, cx);
  assert.deepEqual([item.x, item.y], [x + 30, y + 40]);
  view.drag = null;
  view.startDrag(item, "resize", { position: { x: 0, y: 0 }, click_count: 1 }, cx);
  view.onPointerMove({ position: { x: 50, y: 0 } }, cx);
  assert.equal(item.w, w + 50);
  assert.ok(Math.abs(item.h - (h * (w + 50)) / w) <= 1, "a signature keeps its proportions");
  view.drag = null;
  view.onKey({ key: "]", keystroke: "]", modifiers: {} }, cx);
  assert.ok(item.w > w + 50);
  view.onKey({ key: "d", keystroke: "d", modifiers: {} }, cx);
  assert.equal(view.items[view.items.length - 1].kind, "date");
  view.onKey({ key: "t", keystroke: "t", modifiers: {} }, cx);
  const text = view.items[view.items.length - 1];
  assert.equal(view.editor.id, text.id);
  view.editor.state.set_value("Alex Morgan\n221 Harbor Street");
  assert.equal(text.text, "Alex Morgan\n221 Harbor Street");
  view.onKey({ key: "escape", keystroke: "escape", modifiers: {} }, cx);
  assert.equal(view.editor, null);
});

test("Save signed copy writes a signed PDF and Finder can show it", async () => {
  const before = view.pdf.bytes;
  view.save(cx);
  await settle();
  const path = "Signed copies/sample-agreement-signed.pdf";
  assert.ok(files.has(path), "written into the data directory");
  const bytes = files.get(path);
  assert.deepEqual(bytes.subarray(0, before.length), Uint8Array.from(before), "incremental: the original is a prefix");
  const signed = openPdf(bytes);
  const model = signed.models[0];
  assert.ok(model.paths.some((p) => p.stroke === "#1d4ed8"), "drawn signature is in the PDF");
  assert.ok(model.texts.some((t) => t.text === "221 Harbor Street"));
  assert.equal(view.dirty, false);
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  assert.equal(view.savedPath, `/Users/tester/Library/Application Support/gpui-shell/apps/${main.namespace.dataDirName(root, "/Users/tester")}/${path}`);
  assert.equal(view.notice.level, "success");
  assert.match(view.notice.description, /sample-agreement-signed\.pdf/);
  view.reveal(false, cx);
  view.reveal(true, cx);
  await settle();
  assert.deepEqual(runs.at(-2), ["open", "-R", view.savedPath]);
  assert.deepEqual(runs.at(-1), ["open", view.savedPath]);
});

test("opening a PDF and a text file by path, with ~ expanded", async () => {
  files.set("/Users/tester/Downloads/note.txt", new TextEncoder().encode("Short note\n\nPlease sign below."));
  await view.openPath("~/Downloads/note.txt", cx);
  assert.equal(view.pdf.name, "note.pdf");
  assert.equal(view.items.length, 0);
  assert.ok(view.pdf.models[0].texts.some((t) => t.text === "Short note"));
  files.set("/tmp/x.pdf", buildPdf({ title: "x", pages: layout(docFromText("x", "A\n\nB")), items: [] }));
  await view.openPath("/tmp/x.pdf", cx);
  assert.equal(view.pdf.name, "x.pdf");
  assert.deepEqual(JSON.parse(JSON.stringify(view.recent.slice(0, 2))), ["/tmp/x.pdf", "/Users/tester/Downloads/note.txt"]);
  await view.openPath("/tmp/missing.pdf", cx);
  assert.match(view.error, /Could not open missing.pdf/);
  assert.equal(view.overlay, "open");
  // Reopening the sample brings back the items saved for that exact file.
  view.openSample(cx);
  assert.equal(view.items.length, 4);
  assert.equal(view.dirty, false);
});

test("deleting a saved signature updates the library", () => {
  view.deleteSignature(view.signatures[0].id, cx);
  assert.equal(view.signatures.length, 1);
  assert.equal(JSON.parse(storage.get("signed.signatures")).length, 1);
});

test("files outside the data directory are read through base64", async () => {
  const pdf = buildPdf({ title: "far", pages: layout(docFromText("far", "Far away\n\nSign here.")), items: [] });
  const host64 = Buffer.from(pdf).toString("base64").replace(/(.{76})/g, "$1\n");
  const realRead = fsMock.readFile;
  fsMock.readFile = async () => { throw new Error("`/Volumes/x/far.pdf` is outside every granted read root"); };
  host.process.default.run = async (command, args) => { runs.push([command, ...args]); return { code: 0, stdout: host64, stderr: "" }; };
  try {
    await view.openPath("/Volumes/x/far.pdf", cx);
    assert.deepEqual(runs.at(-1), ["base64", "-i", "/Volumes/x/far.pdf"]);
    assert.equal(view.pdf.name, "far.pdf");
    assert.ok(view.pdf.models[0].texts.some((t) => t.text === "Far away"));
  } finally {
    fsMock.readFile = realRead;
  }
});

test("the data directory is named the way gpui-shell names it", () => {
  const { dataDirName } = main.namespace;
  // Digests observed from gpui-shell 0.7.3 for directories run with `run -d`.
  assert.equal(dataDirName("/Users/jason/work/gpui-shell-benchs/apps/signed", "/Users/jason"), "signed-955b346349947b71");
  assert.equal(dataDirName("/Users/jason/.gpui-shell/apps/signed", "/Users/jason"), "com.huacnlee.signed");
  assert.equal(dataDirName("/Applications/Signed.app/Contents/Resources/app", "/Users/jason"), "com.huacnlee.signed");
});

test("Save As writes where the save dialog points, through base64", async () => {
  view.openSample(cx);
  view.placeText("date", cx);
  const staged = [];
  host.process.default.run = async (command, args) => {
    runs.push([command, ...args]);
    if (command === "osascript") return { code: 0, stdout: "/Users/tester/Desktop/agreement\n", stderr: "" };
    if (command === "base64") {
      staged.push(Buffer.from(new TextDecoder().decode(files.get(".save-as.b64")), "base64"));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  view.saveAs(cx);
  await settle();
  const decode = runs.at(-1);
  assert.equal(decode[0], "base64");
  assert.deepEqual(decode.slice(1, 3), ["-D", "-i"]);
  assert.ok(decode[3].endsWith("/.save-as.b64"));
  assert.deepEqual(decode.slice(4), ["-o", "/Users/tester/Desktop/agreement.pdf"]);
  assert.ok(!files.has(".save-as.b64"), "the staged copy is removed");
  assert.equal(view.savedPath, "/Users/tester/Desktop/agreement.pdf");
  const signed = openPdf(new Uint8Array(staged[0]));
  assert.ok(signed.models[0].texts.some((t) => /^\d\d\/\d\d\/\d{4}$/.test(t.text)), "the staged bytes are the signed PDF");
});
