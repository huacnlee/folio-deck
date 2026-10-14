# Skills — an agent skills manager built with gpui-shell

A native desktop manager for agent skills (folders holding a `SKILL.md`), written in JavaScript for [gpui-shell](https://gpui-kit.com/shell/) and rendered with GPUI. It manages the skills your coding agents actually load, and installs new ones from public GitHub repositories.

<img width="2080" height="1440" alt="image" src="https://github.com/user-attachments/assets/f9624187-797f-4e42-bae9-46438e5e7459" />

## Reference

- Recreated from a design shot of a "Skills — Manage all your agent skills" page (Installed / Discover tabs, Recommended / New skills / Most installed card groups). *Original design link: to be added.*
- Design and product ideas belong to their original author. The code is MIT; see the [repository README](../../README.md#license) for the licence terms, including no commercial use of the design.

## Run it

Both Installed and Discover work straight from a checkout with the latest Git build of gpui-shell; Node.js is only used for tests:

```bash
gpui-shell types -d apps/skills-manager
gpui-shell run -d apps/skills-manager
```

The application obtains the home and data directories from gpui-shell and reads 20 default user-level Skills locations directly. Folders are created when a skill is added. gpui-shell currently reports a missing read-grant root as a permission denial; unavailable optional folders are summarized in a collapsed notice, and accessible folders still load. No installer or generated machine-specific configuration is needed.

## Agent folders

The defaults cover Claude, Codex, shared `.agents`, Cursor, Gemini CLI, Antigravity, GitHub Copilot, OpenCode, Amp/shared config, Goose, Continue, Roo Code, Kilo Code, Kiro CLI, Droid, Windsurf, Qwen Code, Trae, OpenHands and OpenClaw. Shared `.agents/skills` also covers agents such as Cline, Pi and Zed without duplicate scans. The default paths follow the [Vercel Skills agent registry](https://github.com/vercel-labs/skills/blob/main/src/agents.ts); this app does not depend on that CLI. See `lib/agents.js` for the full list. Custom environment-based locations and project-level folders are not scanned.

After changing filesystem grants, restart dev: source hot reload retains the process's original permissions.

## What it does

**Installed** — every skill in your agent folders, grouped by folder.

- Reads each `SKILL.md` frontmatter (`name`, `description`); shows linked skills (symlinks, e.g. `~/.claude/skills/x → ../../.agents/skills/x`), broken links, and the skill file's modification time.
- The switch on each card enables or disables a skill. Disabling renames `SKILL.md` to `SKILL.md.disabled`, which agents do not load; enabling renames it back.
- Click a card to read its `SKILL.md`, enable/disable it, or uninstall it.
- **Uninstall** asks for confirmation, then *moves* the skill into the app's trash (a linked skill is moved as a link — its target folder is left alone). **Trash** in the rail restores it to where it was, or deletes it for good after a second confirmation. Nothing in an agent folder is ever deleted.

**Discover** — skills published in [anthropics/skills](https://github.com/anthropics/skills), [openai/skills](https://github.com/openai/skills) (`.curated`) and [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills).

- Repository metadata and trees load concurrently. Cards appear as each repository arrives, then descriptions fill in with up to eight downloads in flight. Unchanged `SKILL.md` files reuse cached descriptions by SHA. The catalog is cached for six hours; **Refresh** reloads it, and a failed refresh keeps the cached catalog and offers **Retry**.
- Groups: **Recommended** is a curated list (`RECOMMENDED` in `lib/catalog.js`). **New skills** are the ones this app first saw most recently (it records when each skill first appeared; the first refresh is the baseline). **Most installed** ranks by the source repository's stars, because GitHub publishes no per-skill install counts. Everything else is under **All skills**.
- **+** installs into the folder you pick, after showing how many files and bytes it will download. Text files come from raw.githubusercontent.com; binary files (fonts, images) come as base64 blobs from the API so their bytes are exact. The download is staged in the app's data folder and moved into place in one step, so a failed install leaves nothing behind.

**Add skill** creates `<folder>/<name>/SKILL.md` from a name (validated: lowercase letters, digits, hyphens), a description and Markdown instructions. **Import** copies a folder containing `SKILL.md` into an agent folder.

Scan and Discover refresh errors show a short summary by default; View details expands a bounded, scrollable list.

The toolbar and card grid wrap as the window narrows; folder menus and destination pickers scroll when needed.

**Search** matches name, folder name, description and author/folder. **Filter** narrows by folder and status (Installed) or source (Discover). **Sort** orders by name or recency, or keeps Discover's group ranking.

## Permissions

| Grant | Why |
| --- | --- |
| `fs` read/write `${dataDir}` | Staging downloads and new skills, the trash, the catalog cache |
| `fs` read/write the 20 `${homeDir}` Skills directories listed in the manifest | Scan, add, enable/disable, trash and restore skills directly |
| `fs` read `/usr/share/omarchy/default/agents/skills` | Read system-provided Skills linked into agent folders on Omarchy |
| `fs` read `${homeDir}/Downloads` | Import downloaded skill folders |
| `network` GET | `api.github.com/repos/{the three repos}` and `/git/…` under them; `raw.githubusercontent.com/{the three repos}/…` |

No process execution grants are needed. A symlink target outside the granted folders remains inaccessible and is shown as unreadable; other entries still load. Add an explicit grant for a shared skills folder if needed.

## Tests

```bash
mkdir -p ~/.cache/gpui-shell-benchs-test-tmp
TMPDIR=~/.cache/gpui-shell-benchs-test-tmp node --test apps/skills-manager/tests/*.test.mjs
gpui-shell check -d apps/skills-manager
```

`tests/logic.test.mjs` covers frontmatter, name validation, grouping, search/filter/sort and path handling. `tests/library.test.mjs` exercises native file operations against disposable folders and GitHub requests against mocks, including progressive catalog loading and cached descriptions. Tests never touch real agent folders.

## Limits

- Unauthenticated GitHub API access allows 60 requests an hour; a refresh costs 6, and installing a skill costs one per binary file (canvas-design has ~40 fonts). When the limit is hit, Discover shows GitHub's message and keeps the cached catalog.
- No authentication, private repositories, updates of installed skills, or editing of an existing `SKILL.md` in the app.
- Import follows a linked source folder but rejects nested symlinks and special files, leaving no partial installation.
- Moving skills to/from trash requires the source and data directory to be on the same filesystem. A failed move preserves the source.
