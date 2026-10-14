# Omanta — native files for gpui-shell

A functional file browser inspired by Omanta and Finder, built entirely with gpui-shell JavaScript and native GPUI elements. The interface follows gpui-omarchy: compact controls, square corners, restrained panels, and the current Omarchy palette with Tokyo Night fallback. There is no browser or Node.js runtime dependency.

## Reference

- [28allday/omanta](https://github.com/28allday/omanta): places, tabs, split browsing, file operations and keyboard conventions. This is an independent benchmark implementation, not the original Qt/GIO application.
- [gpui-omarchy](https://github.com/longbridge/gpui-omarchy): the Omarchy design language and default palette. The library's Rust components are not exposed by gpui-shell; the app styles `gpui-base` primitives with the same conventions.
- [Finder](https://support.apple.com/guide/mac-help/organize-files-in-the-finder-mchlp2605/mac): familiar navigation and file organization.

## Run

Install the latest gpui-shell Git build as described in the repository README. On Linux, install GNU coreutils (`cp`, `mv`, `realpath`, `rm`, `readlink`) and `xdg-utils` for opening files. These are normally present on Omarchy.

```sh
gpui-shell types -d apps/omanta
gpui-shell dev apps/omanta
```

The entry starts at your home directory. Tabs, bookmarks, view, sort, sidebar and hidden-file preferences persist across restarts. Missing optional places report an error with Retry. It loads real directory contents and metadata; no sample files are created in your home directory.

## Features

- Places and bookmarks, back/forward/up navigation, editable location, tabs, and split panes. Click a split pane's path to activate it.
- Native virtual list view for large directories, plus a responsive icon grid. The grid initially renders 240 items and offers Show more.
- Folder-first natural name sorting; sort by size or modification time. Search filters the current directory; show/hide hidden files.
- Single selection, Ctrl-click toggle and Shift-click range selection. Double-click/Enter opens folders or launches a file in its default app.
- New folder, rename, copy, cut and paste. Conflicting names are refused; existing files are never overwritten. Operations report partial successes and retain failed sources.
- Trash asks for confirmation, stores the item with its original location, and survives restart. Trash → Restore puts items back only if the original name is free and its parent still exists. Rename, move and trash support one-step Undo.
- Space preview: bounded text/code/Markdown/SVG text, image previews up to 8 MiB, and file metadata. Other formats open in their system application.
- Clipboard copy of selected paths. Copy/Cut/Paste of files is local to this app; it does not implement the system file-transfer clipboard.
- Omarchy theme changes are checked every 2.5 seconds; invalid or absent themes fall back to Tokyo Night.

## Shortcuts

| Key | Action |
| --- | --- |
| Ctrl+L / Ctrl+F | Go to folder / search |
| Alt+Left / Right / Up | Back / forward / parent |
| Ctrl+T / Ctrl+W | New / close tab |
| Ctrl+D | Add or remove current bookmark |
| Ctrl+H / F9 / F3 | Hidden files / sidebar / split |
| Ctrl+Shift+N / F2 | New folder / rename |
| Ctrl+C / X / V | Copy / cut / paste files |
| Ctrl+Z | Undo last rename, move or trash |
| Ctrl+A / Up / Down | Select all / move selection |
| Enter / Space / Delete | Open / preview / confirm trash |
| F5 / Escape | Reload / dismiss or clear selection |

File shortcuts operate when the browser has focus; native text fields keep their own editing shortcuts. Clicking a file returns keyboard focus to the browser.

## Permissions

| Grant | Purpose |
| --- | --- |
| `fs.read` `/` and `${dataDir}` | Browse local paths allowed by OS permissions and read app trash records |
| `fs.write` `${homeDir}`, `${dataDir}` | New folders, app settings and recoverable trash; mutations outside home are refused |
| `fs.write` `${pluginDir}/omanta/cache` | A temporary image asset for preview; the native image loader only resolves app assets |
| Execute `cp`, `mv`, `realpath`, `readlink` | Preserve symlinks in transfers and verify real parents before mutation |
| Execute `rm` | Clean only app-created transfer staging folders and image preview files; never delete a selected user item |
| Execute `xdg-open`, `open` | Open selected files in their default application |
| Storage, clipboard write | Persist UI preferences and copy file paths |

Arguments are passed as arrays, with no shell interpolation. Mutations check the real parent against the user's home and app data directory, and protect the home/data roots and ancestors of app data. Directory copies preserve symlinks rather than following them. Folder self-copy, including through a destination link, is refused.

Omanta Trash is private to this application; it does not empty or replace the desktop Trash. There is no permanent-delete action. Undo intentionally refuses collisions instead of replacing newer files. The current native runtime resolves symlinks before certain `fs` operations, so transfers use GNU coreutils to preserve the selected link itself.

## Limits

- Linux with GNU coreutils is the supported target. The opener has a macOS branch, but GNU `mv -nT` is not supplied by stock macOS.
- No network mounts, device mount/unmount, full-text search, archives, drag-and-drop, thumbnails in the grid, or desktop file chooser/D-Bus replacement.
- The app directory must be writable for image previews. `omanta/cache/` is ignored by git and excluded from releases. Text previews stop at 12,000 characters and 2 MiB.
- Directory metadata follows symlinks; broken links show their read error. Transfers and trash preserve link identity.
- Directory loads are snapshots: use F5/Refresh after changes made in other applications.

## Validation

```sh
mkdir -p ~/.cache/gpui-shell-benchs-test-tmp
TMPDIR=~/.cache/gpui-shell-benchs-test-tmp node --test apps/omanta/tests/*.test.mjs
gpui-shell check -d apps/omanta
python3 apps/omanta/tests/check-views.py
```

Tests use disposable fixtures outside the checkout and cover binary/Unicode files, name conflicts, partial moves, nested symlinks, self-copy through aliases, writable parent confinement, trash persistence/restore, preview bounds and theme fallback. Node is used only for tests. A check materializes eager elements; it does not establish paint/layout or later interaction correctness. No application window was launched during development.
