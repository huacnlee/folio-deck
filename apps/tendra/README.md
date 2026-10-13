# Tendra (gpui-shell demo)

> **Disclaimer:** This demo is only an experiment. It borrows the Tendra
> concept design to try building a native desktop UI with gpui-shell. It is not
> a real product, it is not affiliated with the original designer, and all data
> in it is made up.
>
> 声明：本示例仅借用 Tendra 的概念设计稿，尝试用 gpui-shell 做一个 demo，
> 并非真实产品，与原作者无关，数据均为虚构。

<img width="1430" height="881" alt="image" src="https://github.com/user-attachments/assets/2ae8d752-49c2-4373-a66f-f7f90f4481bc" />

## Original design

Tendra is a concept designed and built in code by
**[Suryansh Chourasia](https://x.com/Suryansh777777)**. The design this demo
recreates comes from the original post:

<https://x.com/Suryansh777777/status/2109876865053941837>

All design credit belongs to the original author. The data is made up; the
product thinking is theirs.

## What this demo does

A native re-creation of the "Bid pipeline" screen, written in JavaScript and
rendered by GPUI on the GPU — no DOM, no browser.

- Five pipeline stages with summary tiles (value, tick meter, footnote)
  computed from the bids on the board.
- Drag a card to another column to move it; click a card to open its details
  and move it to the next stage.
- **Team / Mine** scope, board / list layout, sidebar search and collapse.
- Changes persist with `localStorage`; the button beside your name restores
  the demo data.

## Run

Requires `gpui-shell` 0.7.3 or later.

```bash
gpui-shell types -d .         # generate gpui-kit.d.ts for editor type checking
gpui-shell check -d .         # load and render once
gpui-shell run -d . --watch   # run, reloading on save
```

## Layout

```text
main.js     the application view: sidebar, header, summary, board, list, drawer
data.js     demo bids, stages and number formatting
theme.js    palette and gpui-base theme tokens
ui.js       small shared builders: icons, tags, avatars, meters
tendra/     SVG icons
```
