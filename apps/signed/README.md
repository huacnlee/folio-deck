# Signed

A desktop PDF signing tool for [gpui-shell](https://gpui-kit.com/shell/), written in plain JavaScript with no npm packages. Open a real PDF, place signatures, text and dates on it, and save a signed copy that any PDF reader shows with the signature in place.

Built from scratch by an AI coding agent as one of the gpui-shell AI-friendliness benchmarks in this repository.

<img width="1152" height="980" alt="image" src="https://github.com/user-attachments/assets/cc120a32-939f-4a6c-b330-f89f906bf6c1" />

## Reference

- Inspired by **[omacom/signed](https://github.com/omacom/signed)** — its feature set (place a signature, text and date on a PDF, save a signed copy, S/T/D shortcuts, `[ ]` resizing) and the screenshot it was briefed from.
- The user interface deliberately uses gpui-component's ordinary look (host light/dark theme, standard buttons and keycaps) instead of copying the reference's visual design.
- The design and product ideas belong to the original project. See the repository README for the licence terms.

## Run

```bash
gpui-shell types -d apps/signed     # editor types (gpui-kit.d.ts, not committed)
gpui-shell run -d apps/signed
```

## Features

### Save a signed PDF

1. **Open** (⌘O) a PDF with the native macOS file dialog; the Open menu (▾) has recent files, the sample, and **Enter a path…** (`~/` works; the only way on Linux). `.txt` and `.md` files are turned into a simple PDF first. The built-in *Sample agreement* opens on first launch; it is generated as a real PDF and read back through the same parser as any other file.
2. Place a **Signature** (S), **Text** (T) or **Date** (D). Drag to move, drag the corner (or `[` `]`) to resize, arrows to nudge, Enter or double-click to edit text, ⌫ to delete.
3. **Save** (⌘S) writes `<name>-signed.pdf` to the app's *Signed copies* folder; **Save As…** (⇧⌘S, in the Save menu ▾) asks where with the native save dialog. Both write by **incremental update**: the original bytes are kept unchanged and the new content is appended after them —
   - a content stream per signed page holding the signature as vector Bézier strokes (in the ink colour and weight it was drawn with), and text and dates in Helvetica;
   - the updated page objects (original content wrapped in `q … Q`, then the new stream) and a font resource;
   - a new cross-reference section chained with `/Prev` — a classic table, or a cross-reference stream when the original uses one.

   Coordinates go from screen pixels to PDF user space through the inverse of the page's display matrix, so `/Rotate` 90/180/270 and MediaBox/CropBox origins other than 0,0 land where you placed them.
4. A notice gives the output path with **Show in Finder** and **Open**; the status bar keeps them too.

Signed copies go to `Signed copies/` in the app's data directory — `~/Library/Application Support/gpui-shell/apps/com.huacnlee.signed/` once installed (with `run -d` gpui-shell names it `signed-<hash>`; the app works out and shows the real path).

### Add signatures

- **Signature ▾ → Add signature…** opens the signature pad. With an empty library, clicking Signature (or pressing S) opens it straight away.
- **Draw** with the mouse or trackpad: Undo, Clear, three ink colours and three stroke weights.
- **Type** a name: it is drawn with a built-in single-stroke script alphabet, so it is real vector ink in the PDF too.
- Saved signatures go to a library (persisted in local storage). The Signature menu lists them all to insert again, each with a delete button; S places the most recent one.

## How the PDF support works

All of it is in this directory:

| File | Does |
| --- | --- |
| `pdfparse.js` | Object syntax, classic xref tables and xref streams (with PNG predictors), object streams, `/Prev` chains, recovery by rescanning a damaged file, the page tree with inherited MediaBox/CropBox/Rotate/Resources, and a content interpreter: text (`Tj` `TJ` `'` `"` `Td` `TD` `Tm` `T*` `Tf` `Tc` `Tw` `Tz` `TL` `Ts` `Tr`), paths (`m` `l` `c` `v` `y` `h` `re` `S` `s` `f` `F` `f*` `B` `b` `n`), `cm`/`q`/`Q`, grey/RGB/CMYK colour and form XObjects. Fonts: WinAnsi, MacRoman, `/Differences` and ToUnicode CMaps (including two-byte Type0 fonts) with `/Widths` and `/W` metrics. |
| `inflate.js` | FlateDecode: stored, fixed and dynamic Huffman blocks. ASCIIHex and ASCII85 are in the parser. |
| `pdfupdate.js` | The incremental update writer and the pixel → PDF coordinate mapping. |
| `pdf.js` | A small PDF writer for the built-in sample and for text files. |

Pages are drawn with GPUI elements: each text run is positioned at its baseline, neighbouring runs on one line are joined, and vector shapes are drawn with `PathBuilder` — on the page and in the thumbnails.

### Limits

- Text is drawn in a substitute face (Times, Helvetica or Menlo, chosen from the font name), so line lengths can differ slightly from the original; rotated or skewed text is not drawn.
- Images show as grey placeholders; shading, patterns, clipping and transparency are ignored. Very heavy pages are capped and marked *simplified* in the status bar.
- Encrypted PDFs are refused. The signature is an appearance, not a cryptographic digital signature.
- Non-Latin-1 characters in placed text become `?` (the standard Helvetica has no other glyphs).

## Permissions

```json
"fs": { "read": ["${dataDir}"], "write": ["${dataDir}"], "execute": ["base64", "osascript", "open", "xdg-open"] }
```

- `${dataDir}` — the signed copies.
- `base64` — reads a PDF the user chose outside the data directory, and writes a Save As copy (the bytes are staged in the data directory and decoded to the chosen file). gpui-shell 0.7.3 does not honour absolute `fs.read` roots (only `${pluginDir}` and `${dataDir}`), and `base64` can only copy the files it is given.
- `osascript` — the native open and save dialogs and finding the home folder; `open` / `xdg-open` — Show in Finder and Open.

## Shortcuts

| Key | Action |
| --- | --- |
| S / T / D | Place the latest signature / a text box / today's date |
| `[` `]` | Shrink / grow the selection |
| Arrows (Shift) | Nudge by 1 px (10 px) |
| Enter, double-click | Edit text |
| ⌫ | Delete the selection |
| ⌘O / ⌘S / ⇧⌘S | Open / Save / Save As… |
| Esc | Deselect, close a panel |

## Tests

```bash
node --experimental-vm-modules --test apps/signed/tests/*.test.mjs
gpui-shell check -d apps/signed
```

The tests cover inflate against zlib, the parser on the sample, a hand-built PDF 1.5 file (object stream, compressed xref stream with predictor, Flate content), damaged-xref recovery and real PDFs found on the machine (page counts checked against `pdfinfo`); the pixel → PDF mapping for every rotation and offset boxes; that the signature strokes and text are in the appended content stream and the original bytes are an untouched prefix; signing twice; and that poppler (`pdfinfo`, `pdftotext`) and macOS Quartz (`sips`) open the signed copies. `tests/view.test.mjs` drives the real view through the whole flow — empty library → pad → draw and type signatures → place, move, resize, edit → save → reopen — against a stand-in host that provides only gpui-shell's globals, including Save As.

## Notes on the runtime

Found while building this, and worked around in the app:

- `line_height(n)` takes a multiplier, not pixels.
- gpui-component constructors are `new Button(...)` while gpui-base ones are `Button.new(...)`; gpui-component's `Input` needs gpui-component's own `InputState`, which has no change/submit events — so the app uses gpui-base `Input`.
- `window.push_toast` throws unless the window's root is a ShellRoot, so the app draws its own notices.
- `import.meta.url` is undefined; the module path is read from an error stack to locate the data directory.
