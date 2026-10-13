# Folio Desk — Mail example by gpui-shell

A native desktop Gmail client and mail demo built with [gpui-shell](https://gpui-kit.com/shell/) and [GPUI Kit](https://github.com/longbridge/gpui-kit). Paper surfaces, geometric avatars, and eight sample conversations, rendered entirely with native GPUI elements in JavaScript.

<img width="1198" height="827" alt="Folio Desk mail interface" src="https://github.com/user-attachments/assets/f95e7983-a61d-4252-a811-440e4d8cbec8" />

## Reference

- The visual design — paper surfaces, narrow icon rail, grouped Correspondence list, context card and letter layout — is recreated from a third-party mail app design shot; colours, illustrations and copy were changed. *Original design link: to be added.*
- Design and product ideas belong to their original author. The code is MIT; see the [repository README](../../README.md#协议) for the licence terms, including no commercial use of the design.

## Install

Install the runtime and mail app with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/gpui-shell-benchs/main/apps/folio-deck/install.sh | sh
```

The installer supports Linux x86_64 and macOS Intel / Apple Silicon. It installs gpui-shell v0.7.3 when no compatible runtime exists in `~/.local/bin`, verifies the release's SHA-256 checksum, downloads the app, and checks it before replacing an existing installation. No sudo, Git, or Rust toolchain is required. Node.js 20 or newer is required for the small localhost OAuth callback listener; no npm packages are installed. The installer records its absolute executable path so authorization also works when launched from macOS Finder. Linux requires `xdg-utils` for launch links; curl, tar, and a SHA-256 utility are required on both platforms.

On Linux, the app lives in `~/.gpui-shell/apps/folio-mail`. On macOS, it installs a complete `~/Applications/Folio Desk.app` containing its own gpui-shell binary and `Contents/Resources/app`; it can be launched from Finder without the copies in `~/.local/bin` or `~/.gpui-shell/apps`. Re-running the installer updates it; locally saved drafts and completed demo actions remain at the same app location. A linked application is preserved rather than overwritten.

To install your local checkout (from `apps/folio-deck`):

```bash
sh install.sh --app-source .
```

Append `--launch` to open it after installation. For example:

```bash
curl -fsSL https://raw.githubusercontent.com/huacnlee/gpui-shell-benchs/main/apps/folio-deck/install.sh | sh -s -- --launch
```

## Launch

After installation, open **[Folio Desk](folio-mail://open)**, select **Folio Desk** from your application launcher, or run:

```bash
~/.local/bin/folio-mail
```

The installer registers the `folio-mail://open` URL scheme with a Linux desktop entry or a self-contained macOS `.app` in `~/Applications`. If your browser or Markdown viewer does not allow custom links, use the terminal command or application launcher. The launch handler accepts only the exact open URI; it does not execute commands from a URL.

## Develop

```bash
git clone https://github.com/huacnlee/gpui-shell-benchs.git
cd gpui-shell-benchs/apps/folio-deck
gpui-shell types -d .
gpui-shell run -d . --watch
```

## Connect Gmail

The original sample workspace stays available. Choose **Connect Gmail…** in the bottom bar, paste the JSON for a **Desktop app** OAuth client from Google Cloud, and choose **Sign in with Google…**. Enable the Gmail API for that project first; add your address as a test user if its consent screen is in Testing mode.

Folio starts a listener on **127.0.0.1:9481** before opening Google. After authorization, the browser shows “Authorization received” and Folio connects automatically. Cancel stops the listener; unused sign-ins expire after ten minutes. Only matching, unpredictable OAuth state values are accepted, with S256 PKCE verified during token exchange. A listener cannot bind if another application already owns this port.

Gmail uses the same paper surfaces, narrow icon rail, grouped Correspondence list, illustrated avatars, context card, From/To rows and letter layout as the original design. It supports Inbox, All, Sent, starred and unread views, Gmail search, pagination, reading plain text and HTML converted to text, local drafts, new messages, replies with threading, starring, marking unread, archive/trash and undo. Remote images are never loaded. Attachments currently show names and sizes; use **Open in Gmail…** to download them. Gmail’s server drafts can be viewed; composed drafts are saved locally.

The application uses lightweight JavaScript and calls Google directly. It does **not** use the omamail backend, Rust backend, Node mail server or third-party npm libraries. The only Node process is a temporary OAuth callback transport using its HTTP standard library; mailbox operations remain in gpui-shell’s JavaScript runtime.

Requested scopes are `gmail.modify` and `gmail.send`. Remembered accounts store the OAuth client and refresh token in the app’s private local storage; access tokens stay in memory. Uncheck **Remember this account** to keep the session in memory. **Disconnect** removes the remembered session. No mail or credentials go to a Folio server. Sending through a connected Gmail account delivers real mail; the separate sample workspace still simulates sending.

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

In the sample workspace, all contacts and addresses are sample data. Sending, rewriting, and attachment previews run locally; no email is delivered, no AI service is called, and no PDF is downloaded. Drafts, sent letters, attachments, and dismissed letters are saved locally. In-progress sends, search filters, and connection simulations reset on restart.

## Validate

```bash
gpui-shell check -d .
node --experimental-vm-modules --test tests/*.test.mjs
python3 tests/install_test.py
python3 scripts/check-states.py
python3 scripts/check-gmail-states.py
python3 scripts/check-oauth-callback.py
```

The installer tests run in disposable directories inside this checkout with mocked downloads and desktop registration. They do not change HOME or PATH, install software, or alter your desktop settings. Native state checks materialize editing, assistant, rewriting, attachment preview, sending, offline, sent, no-results, and dismissed views. `check` verifies loading and materialization; inspect layout and interactions in a real window as well.

The installer workflow builds and validates the actual `.app` on Apple Silicon and Intel macOS runners, including reinstallation, AppleScript compilation, Folio icon conversion, bundle signing, and native runtime checks. Local installer tests mock macOS system tools; they do not replace these platform checks.

The macOS bundle uses the Folio document icon at standard and Retina resolutions. To regenerate its committed PNG icon set after editing `forma/assets/app-icon.svg`, run `python3 scripts/build-icon.py` with `rsvg-convert` installed. End users do not need this tool.
