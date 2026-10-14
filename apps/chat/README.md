# Chat — your local Claude and Codex in one window

A desktop chat client in the shape of ChatGPT and Claude Desktop, built entirely with gpui-shell JavaScript and native GPUI elements. It does not call any API itself: every reply comes from the `claude` or `codex` command-line tool already installed and signed in on this computer, so it uses your own subscription, models and configuration. The interface follows the Omarchy style used across this repository: the system monospace font, square corners, hairline dividers, foreground-tinted states and the current Omarchy palette with a Tokyo Night fallback.

## Reference

- [ChatGPT desktop app](https://openai.com/chatgpt/desktop/) and [Claude Desktop](https://claude.ai/download): a sidebar of chats grouped by date, a centered transcript, and a composer at the bottom with the model choice.
- [Claude Code headless mode](https://docs.anthropic.com/en/docs/claude-code/headless) (`claude -p --output-format stream-json`) and [Codex non-interactive mode](https://github.com/openai/codex) (`codex exec --json`, `codex exec resume`): the back ends.

## Run

Install and sign in to at least one of the tools, then start gpui-shell from a shell where they are on `PATH`:

```sh
claude --version && codex --version
gpui-shell types -d apps/chat
gpui-shell dev apps/chat
```

## Features

- Sidebar with New chat, search across titles and messages, and chats grouped as Today, Yesterday, Previous 7 days and Older. Right-click a chat to rename or delete it; deleting asks first and offers Undo.
- Claude or Codex per message, chosen in the composer. Claude offers Default, Opus, Sonnet and Haiku (the CLI's own aliases); Codex uses the model in `~/.codex/config.toml`.
- Multi-turn conversations continue the tool's own session: `claude -p --resume <session>` and `codex exec resume <thread>`. Switching provider in the middle of a chat, or a session the tool no longer knows, starts a new session that receives the earlier messages as context.
- Replies render as Markdown and can be selected. The latest reply has Copy and Retry. While a reply is generated the transcript shows the elapsed time, what Codex is running, and any thinking text that has arrived.
- Each reply records its provider, model, duration and, for Claude, its cost.
- Chats are saved to `conversations.json` in the app's data directory after every change and survive restarts. A reply cut off by closing the app is marked as interrupted. A damaged entry in the file is skipped instead of discarding the rest; a file that cannot be read is never overwritten.
- Safety: Claude runs with all tools turned off (`--tools ""`) and Codex starts in its read-only sandbox, so a chat never edits files. Prompts are passed after `--`, so a message beginning with `-` is never read as an option.

## Shortcuts

| Key | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| Ctrl+Enter | Send |
| Escape | Stop the reply (needs streaming, see Limits), or close a menu or dialog |
| Ctrl+N | New chat |
| Ctrl+B | Show or hide the sidebar |

## Permissions

| Grant | Purpose |
| --- | --- |
| `fs.read` / `fs.write` `${dataDir}` | Save and load chats; the working directory the tools run in |
| `fs.read` `~/.local/state/omarchy`, `~/.local/share/omarchy`, `~/.config/omarchy` | Read the current Omarchy theme |
| Execute `claude`, `codex` | Generate replies with your local sign-in |
| Execute `fc-match` | Resolve the system `monospace` font, as the Omarchy shell does |
| Storage | Remember the chosen provider, model and sidebar state |
| Clipboard write | Copy a reply |

gpui-shell starts commands with an empty environment. Both tools still find their sign-in in your home directory, but anything they read from environment variables (API keys, proxies) is not passed on.

## Differences and limits

- **Streaming and long replies depend on the runtime.** The current gpui-shell `process.run` waits for a command to finish and stops it after 30 seconds. Until the runtime has a streaming `process.spawn`, a reply appears all at once, a reply that takes longer than 30 seconds fails with an explanation and Retry, and Stop is disabled. The app already uses `process.spawn` when it exists, with line-by-line output and a working Stop; no change to the app is needed.
- No attachments, images, voice, projects or artifacts. No tools: these chats cannot read or change files.
- Model lists are the tools' aliases; there is no account or usage view.
- The transcript's rows are drawn by a virtual list, which cannot own buttons, so Copy and Retry act on the latest reply only; earlier replies can be selected and copied as text.
- `tests/check-views.py` renders each screen state with `gpui-shell check`, but `check` does not lay out the transcript's rows, so their contents are verified only in a running window.

## Tests

```sh
node --test apps/chat/tests/*.test.mjs
python3 apps/chat/tests/check-views.py
gpui-shell check -d apps/chat
```

The unit tests cover argument building, both tools' JSONL event streams (deltas, final messages, results, errors, command activity), error messages for timeouts, exit codes and a missing executable, context prompts, titles, date grouping, search, the file format and its recovery from damaged entries. They run on fixtures and never start either tool.
