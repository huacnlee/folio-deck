# Skills — an agent skills manager built with gpui-shell

A native desktop manager for agent skills (folders holding a `SKILL.md`), written in JavaScript for [gpui-shell](https://gpui-kit.com/shell/) and rendered with GPUI. It manages the skills your coding agents actually load, and installs new ones from public GitHub repositories.

<img width="2080" height="1440" alt="image" src="https://github.com/user-attachments/assets/f9624187-797f-4e42-bae9-46438e5e7459" />

## Reference

- Recreated from a design shot of a "Skills — Manage all your agent skills" page (Installed / Discover tabs, Recommended / New skills / Most installed card groups). *Original design link: to be added.*
- Design and product ideas belong to their original author. The code is MIT; see the [repository README](../../README.md#license) for the licence terms, including no commercial use of the design.

## Run it

Discover works straight from a checkout:

```bash
gpui-shell types -d apps/skills-manager
gpui-shell run -d apps/skills-manager
```

To manage the skills on your machine, install a copy with access to your agent folders:

```bash
node apps/skills-manager/scripts/install.mjs     # --dry-run to see what it grants
gpui-shell run skills-manager
```

The installer copies the app to `~/.gpui-shell/apps/skills-manager`, writes `roots.js` with the folders that exist among `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills` (plus `~/Downloads` as an import source; add more with `--import-dir`), and writes the matching grants into that copy's manifest. Re-run it after updating.

## What it does

**Installed** — every skill in your agent folders, grouped by folder.

- Reads each `SKILL.md` frontmatter (`name`, `description`); shows linked skills (symlinks, e.g. `~/.claude/skills/x → ../../.agents/skills/x`), broken links, and the skill file's modification time.
- The switch on each card enables or disables a skill. Disabling renames `SKILL.md` to `SKILL.md.disabled`, which agents do not load; enabling renames it back.
- Click a card to read its `SKILL.md`, enable/disable it, or uninstall it.
- **Uninstall** asks for confirmation, then *moves* the skill into the app's trash (a linked skill is moved as a link — its target folder is left alone). **Trash** in the rail restores it to where it was, or deletes it for good after a second confirmation. Nothing in an agent folder is ever deleted.

**Discover** — skills published in [anthropics/skills](https://github.com/anthropics/skills), [openai/skills](https://github.com/openai/skills) (`.curated`) and [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills).

- Two API calls per repository (metadata and file tree); each `SKILL.md` comes from raw.githubusercontent.com, which is not API rate-limited. The catalog is cached for six hours; **Refresh** reloads it, and a failed refresh keeps the cached catalog and offers **Retry**.
- Groups: **Recommended** is a curated list (`RECOMMENDED` in `lib/catalog.js`). **New skills** are the ones this app first saw most recently (it records when each skill first appeared; the first refresh is the baseline). **Most installed** ranks by the source repository's stars, because GitHub publishes no per-skill install counts. Everything else is under **All skills**.
- **+** installs into the folder you pick, after showing how many files and bytes it will download. Text files come from raw.githubusercontent.com; binary files (fonts, images) come as base64 blobs from the API so their bytes are exact. The download is staged in the app's data folder and moved into place in one step, so a failed install leaves nothing behind.

**Add skill** creates `<folder>/<name>/SKILL.md` from a name (validated: lowercase letters, digits, hyphens), a description and Markdown instructions. **Import** copies a folder containing `SKILL.md` into an agent folder.

**Search** matches name, folder name, description and author/folder. **Filter** narrows by folder and status (Installed) or source (Discover). **Sort** orders by name or recency, or keeps Discover's group ranking.

## Permissions

| Grant | Why |
| --- | --- |
| `fs` read/write `${dataDir}` | Staging downloads and new skills, the trash, the catalog cache |
| `fs.execute`: `ls`, `stat`, `cat` | Read agent folders: entries, kinds, link targets, times, `SKILL.md` |
| `fs.execute`: `mkdir`, `mv`, `cp` | Move staged skills in, enable/disable (rename), trash/restore (move), import (copy) |
| `fs.execute`: `rm` | Only ever on paths inside the app's data folder — `lib/library.js` refuses anything else |
| `fs.execute`: `find` | Locate the absolute path of the data folder, which the runtime does not expose |
| `network` GET | `api.github.com/repos/{the three repos}` and `/git/…` under them; `raw.githubusercontent.com/{the three repos}/…` |

The committed manifest has only the data folder and network grants; the command grants are added by `scripts/install.mjs` together with the folder list.

## Tests

```bash
node --test apps/skills-manager/tests/*.test.mjs
gpui-shell check -d apps/skills-manager
```

`tests/logic.test.mjs` covers frontmatter parsing and writing, name validation, catalog grouping, search/filter/sort and `stat` parsing. `tests/library.test.mjs` runs the disk layer through the same system commands the app uses, against a temporary folder — scanning with links and broken links, disable/enable, trash/restore of folders and links, delete-forever confinement, create, import, catalog fetch and install against a fake GitHub (including a binary file and a failed download), and data-folder discovery. Neither touches a real agent folder.

## What gpui-shell 0.7.3 made hard

Recorded because this app exists to probe the runtime:

- **Manifest `fs` roots outside the app are ignored.** `gpui-shell run` replaces the manifest's read/write roots with the app folder and its data folder, so `"read": ["/Users/me/.claude/skills"]` never takes effect. The app therefore reaches agent folders through allowlisted commands, and `fs` only writes into its data folder.
- **No `${homeDir}` placeholder, no environment, no data-folder path at run time** — hence the installer that writes absolute paths, and the `find` lookup for the data folder.
- **`fs/promises` has no `stat`, `rename` or `readlink`**, and `fetch` responses have no `arrayBuffer()` (binary downloads go through the API's base64 blobs).
- **`window.open_dialog` and `window.push_toast` fail** in this host ("needs a ShellRoot as the window's first view") because the window is opened with gpui-component's root, so dialogs and toasts are drawn by the view itself.
- **`gpui-component` elements are constructed with `new Spinner()` / `new Switch(id)`**, not `Type.new(...)` as AGENTS.md says for everything else.
- **GitHub requires a `User-Agent`** header, which `fetch` does not send by default.

## Limits

- Unauthenticated GitHub API access allows 60 requests an hour; a refresh costs 6, and installing a skill costs one per binary file (canvas-design has ~40 fonts). When the limit is hit, Discover shows GitHub's message and keeps the cached catalog.
- No authentication, private repositories, updates of installed skills, or editing of an existing `SKILL.md` in the app.
- macOS and Linux only (`stat` output is parsed for both).
