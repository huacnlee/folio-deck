# Mail example by gpui-shell

A desktop mail interface demo built with [gpui-shell](https://gpui-kit.com/shell/) and [GPUI Kit](https://github.com/huacnlee/gpui-kit).

A pale paper palette, geometric avatars, and eight sample conversations. Built entirely with native GPUI elements in JavaScript.

<img width="1198" height="827" alt="image" src="https://github.com/user-attachments/assets/f95e7983-a61d-4252-a811-440e4d8cbec8" />

## Install gpui-shell

```bash
curl -fsSL https://gpui-kit.com/shell/install.sh | sh
```

## Run

```bash
git clone https://github.com/huacnlee/gpui-shell-mail-example.git
cd gpui-shell-mail-example
gpui-shell run --dev
```

## Features

| Control | Action |
| --- | --- |
| Conversation | Open its draft and context |
| Sidebar divider | Drag to resize the sidebar |
| Filter | Show ready drafts or all letters |
| Sort | Reverse the conversation order |
| Up / Down | Open the previous or next conversation |
| Dismiss | Remove the current conversation from the list |
| Attachment | Toggle the sample project outline |
| Send email | Mark the draft as sent |
| Restore demo | Reset the demo after dismissing all visible conversations |

All contacts and email addresses are sample data. Sending and attachments are simulated locally; no email is delivered.

## Check

```bash
gpui-shell check
```
