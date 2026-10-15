# Chat — your local Claude and Codex in one window

A desktop chat client in the shape of ChatGPT and Claude Desktop, built entirely with gpui-shell JavaScript and native GPUI elements. It does not call any API itself: every reply comes from the `claude` or `codex` command-line tool already installed and signed in on this computer, so it uses your own subscription, models and configuration. The interface is built from [zion-ui](https://github.com/huacnlee/zion-ui), declared as a Git dependency in `gpui-shell.json`: near-black surfaces, a muted green accent, sans-serif for words and monospace for data. The welcome screen and the sidebar check which of the two tools are installed and show their versions. On a Chinese system the interface font is a CJK family that also draws Latin (Noto Sans CJK SC, or PingFang SC on macOS), because GPUI lowers a mixed line's baseline for a fallback font and Chinese text would otherwise sit low.

<img width="2121" height="1592" alt="image" src="https://github.com/user-attachments/assets/20d66c24-ad48-4138-b301-3949c53e125e" />

## Reference

- [ChatGPT desktop app](https://openai.com/chatgpt/desktop/) and [Claude Desktop](https://claude.ai/download): a sidebar of chats grouped by date, a centered transcript, and a composer at the bottom with the model choice.
- [Claude Code headless mode](https://docs.anthropic.com/en/docs/claude-code/headless) (`claude -p --output-format stream-json`) and [Codex](https://github.com/openai/codex)'s app server (`codex app-server`, JSON-RPC over stdio), with `codex exec --json` as the fallback: the back ends.

## Run

Install and sign in to at least one of the tools. Chat starts them through your login shell (`zsh -l` on macOS, `sh -l` elsewhere), so it finds them as a terminal would, also when opened from Finder or a desktop launcher; `~/.local/bin`, Homebrew, `/usr/local/bin`, bun, npm and cargo folders are searched after your own `PATH`:

```sh
claude --version && codex --version
gpui-shell types -d apps/chat
gpui-shell dev apps/chat
```

## Features

- A sidebar that slides shut (Ctrl+B, or the toggle at the left of the header) and drags wider or narrower, with New chat, search across titles and messages, and chats grouped as Today, Yesterday, Previous 7 days and Older. Right-click a chat to rename or delete it; deleting asks first and offers Undo.
- Claude or Codex per message, chosen in the composer. Claude offers Default, Opus, Sonnet and Haiku (the CLI's own aliases); Codex uses the model in `~/.codex/config.toml`.
- Multi-turn conversations continue the tool's own session: `claude -p --resume <session>` and `codex exec resume <thread>`. Switching provider in the middle of a chat, or a session the tool no longer knows, starts a new session that receives the earlier messages as context.
- Replies stream in as they are written, render as Markdown and can be selected. The latest reply has Copy and Retry icons under it. While a reply is generated, an activity bar above the composer keeps moving and says what the turn is doing and waiting for, from the tools' own events: starting the CLI, opening or resuming the session, starting MCP servers, waiting for the model, the latest line of its reasoning, a command or web search, how many words are written so far, and how long it has been quiet. A clock counts the whole turn, and a scan line runs along the composer's top edge.
- Each reply records its provider, model, duration and, for Claude, its cost.
- Web links open beside the chat in a link pane: click one in a reply, or one of the latest reply's link chips in the bar under the transcript. The pane is a native WebView with Back, Forward, Reload, zoom (50–200 %, remembered), Maximize to fill the chat area, Open in browser and Close (Esc). It renders in the app's dark theme. Drag its left edge to resize it; the page gives way to a placeholder until the drag ends, and the width is remembered. The pane reuses one page, so later links load into it, and a closed pane keeps it for the next link.
- Chats are saved to `conversations.json` in the app's data directory after every change and survive restarts, and the open chat reopens. While a reply streams, its session and the words written so far are saved every 1.5 seconds. A reply cut off by a reload, a crash or quitting is kept as far as it got and marked as interrupted; Continue asks the tool to carry on from the tail of what it wrote and appends the rest to the same message. A reply cut off less than two minutes before the app started again — a reload — continues by itself, at most twice per reply. A damaged entry in the file is skipped instead of discarding the rest; a file that cannot be read is never overwritten.
- Safety: Claude runs with all tools turned off (`--tools ""`) and every Codex turn, new or resumed, runs in its read-only sandbox with approvals off, so a chat never edits files. (`codex exec resume` has no `--sandbox` flag and otherwise falls back to the user's configured sandbox, which can be full access; the app pins `sandbox_mode="read-only"` for every turn.) Prompts are passed after `--`, so a message beginning with `-` is never read as an option.

## Shortcuts

| Key | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| Escape | Stop the reply, or close a menu or dialog |
| Ctrl+N | New chat |
| Ctrl+B | Show or hide the sidebar |

## Permissions

| Grant | Purpose |
| --- | --- |
| `fs.read` / `fs.write` `${dataDir}` | Save and load chats; `workspace/` inside it is the working directory the tools run in, so their sessions are filed under one project and resume reliably |
| Execute `/usr/bin/env` | Start `claude` and `codex` through your login shell, with HOME and USER set, to generate replies with your local sign-in and read their versions. gpui-shell gives a child process an empty environment and resolves commands on its own `PATH`, which for an app opened from Finder holds only the system folders |
| Execute `fc-match`, `fc-list` | Resolve the system `monospace` family for data, and find a CJK sans family for words |
| Storage | Remember the chosen provider, model, and the sidebar's state and width |
| Clipboard write | Copy a reply |

gpui-shell starts commands with an empty environment. Both tools still find their sign-in in your home directory, but anything they read from environment variables (API keys, proxies) is not passed on.

## Differences and limits

- Replies stream through gpui-shell's `process.spawn` with no time limit: Claude's text from `stream-json` partial messages, Codex's from the app server's `item/agentMessage/delta` notifications (`codex exec --json` only prints a reply once it is complete). One app server serves every Codex turn: it starts when Codex is chosen, so the first message does not wait for a cold start. Stop (or Escape) interrupts a Codex turn and kills Claude's process group. On an older gpui-shell without `process.spawn` the app falls back to `process.run`, which shows the reply all at once, stops after 30 seconds and cannot be stopped early.
- No attachments, images, voice, projects or artifacts. No tools: these chats cannot read or change files.
- Model lists are the tools' aliases; there is no account or usage view.
- The transcript's rows are drawn by gpui-shell's `MessageScroller`, which builds them without event handlers, so Copy, Retry and Continue sit in a bar under the transcript and act on the latest reply only; earlier replies can be selected and copied as text.
- A killed tool never saves its partial reply in its own session, so Continue sends the reply's last 2,000 characters back with the request; a continuation can repeat or drop a few words at the seam.
- The link pane needs a gpui-shell with `WebView` ([longbridge/gpui-kit#3532](https://github.com/longbridge/gpui-kit/pull/3532), after 0.7.3); on Linux it also needs an X11 window, so start gpui-shell with `WAYLAND_DISPLAY=` in a Wayland session. Without either, links open in the system browser.
- The transcript has no jump-to-latest button: the virtual list's own button is drawn in gpui-component's light theme and cannot be restyled from script, and its state does not expose the scroll position for a replacement.
- The activity bar's dots and scan line move through native transitions that the app re-targets every 450 ms, so the window redraws about twice a second during a turn.
- `tests/check-views.py` renders each screen state with `gpui-shell check`, but `check` does not lay out the transcript's rows, so their contents are verified only in a running window.

## Tests

```sh
node --test apps/chat/tests/*.test.mjs
python3 apps/chat/tests/check-views.py
gpui-shell check -d apps/chat
```

The unit tests cover argument building, both tools' JSONL event streams (deltas, final messages, results, errors, command activity), the Codex app-server session (handshake, read-only thread start and resume, streamed deltas, refused server requests, failures and interrupts), error messages for timeouts, exit codes and a missing executable, context prompts, titles, date grouping, search, the file format and its recovery from damaged entries. They run on fixtures and never start either tool.

The Claude and OpenAI marks in `chat/icons/` come from [Simple Icons](https://simpleicons.org) (CC0) and are trademarks of Anthropic and OpenAI, used here to name the tool each reply came from.
