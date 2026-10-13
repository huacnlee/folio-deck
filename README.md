# Folio Desk — Mail example by gpui-shell

A native desktop mail demo built with [gpui-shell](https://gpui-kit.com/shell/) and [GPUI Kit](https://github.com/longbridge/gpui-kit). Paper surfaces, geometric avatars, and eight sample conversations, rendered entirely with native GPUI elements in JavaScript.

<img width="1198" height="827" alt="Folio Desk mail interface" src="https://github.com/user-attachments/assets/f95e7983-a61d-4252-a811-440e4d8cbec8" />

## Install

Install the runtime and mail app with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/folio-mail/main/install.sh | sh
```

The installer supports Linux x86_64 and macOS Intel / Apple Silicon. It installs gpui-shell v0.7.3 when no compatible runtime exists in `~/.local/bin`, verifies the release's SHA-256 checksum, downloads the app, and checks it before replacing an existing installation. No sudo, Git, Node, or Rust toolchain is required. Linux requires `xdg-utils` for launch links; curl, tar, and a SHA-256 utility are required on both platforms.

The app lives in `~/.gpui-shell/apps/folio-mail`. Re-running the installer updates it; locally saved drafts and completed demo actions remain at the same app location. A linked application is preserved rather than overwritten.

To install your local checkout:

```bash
sh install.sh --app-source .
```

Append `--launch` to open it after installation. For example:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/folio-mail/main/install.sh | sh -s -- --launch
```

## Launch

After installation, open **[Folio Desk](folio-mail://open)**, select **Folio Desk** from your application launcher, or run:

```bash
~/.local/bin/folio-mail
```

The installer registers the `folio-mail://open` URL scheme with a Linux desktop entry or a macOS application in `~/Applications`. If your browser or Markdown viewer does not allow custom links, use the terminal command or application launcher. The launch handler accepts only the exact open URI; it does not execute commands from a URL.

## Develop

```bash
git clone https://github.com/huacnlee/folio-mail.git
cd folio-mail
gpui-shell types -d .
gpui-shell run -d . --watch
```

## Demo interactions

| Control | Action |
| --- | --- |
| Search | Filter by sender, company, email address, or subject |
| All / Ready / Sent | Switch mailbox views; sending moves a draft into Sent |
| Sidebar rail | Open all letters, sent letters, saved letters, or the assistant |
| Sidebar divider | Resize the conversation list |
| Sort | Reverse conversation order within each group |
| Edit / Done | Edit the native multiline draft; changes save locally |
| Writing assistant | Simulate a Warm, Concise, or Formal rewrite with a loading state |
| Attachment | Attach a sample outline and expand its inline preview |
| Send email | Simulate sending, prevent duplicate sends, and show completed status |
| Online / Offline | Simulate loss of connection; failed sends offer Retry send |
| Dismiss / Undo dismiss | Remove and restore a conversation |
| Restore sample letters | Reset saved demo changes |
| Alt ↑ / ↓ | Open the previous or next visible letter |
| Ctrl / Command Enter | Send the selected draft |
| Escape | Finish editing or close the assistant / attachment preview |

All contacts and addresses are sample data. Sending, rewriting, and attachment previews run locally; no email is delivered, no AI service is called, and no PDF is downloaded. Drafts, sent letters, attachments, and dismissed letters are saved locally. In-progress sends, search filters, and connection simulations reset on restart.

## Validate

```bash
gpui-shell check -d .
node --experimental-vm-modules --test tests/*.test.mjs
python3 tests/install_test.py
python3 scripts/check-states.py
```

The installer tests run in disposable directories inside this checkout with mocked downloads and desktop registration. They do not change HOME or PATH, install software, or alter your desktop settings. Native state checks materialize editing, assistant, rewriting, attachment preview, sending, offline, sent, no-results, and dismissed views. `check` verifies loading and materialization; inspect layout and interactions in a real window as well.
