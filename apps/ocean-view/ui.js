import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { palette } from "./theme.js";

/** @param {string} name @param {number} [size] */
export const icon = (name, size = 16) => svg(`ocean-view/icons/${name}.svg`).size(size).flex_shrink_0();

/** Muted text. @param {string} value */
export const muted = (value, cx, size = 12) =>
  div().text_size(size).text_color(cx.theme().colors.muted_foreground).child(value);

export const tones = {
  green: { bg: "#123524", fg: "#4ade80", dot: palette.online },
  amber: { bg: "#3a2a0f", fg: "#fbbf24", dot: palette.amber },
  red: { bg: "#3b1518", fg: "#f87171", dot: palette.red },
  blue: { bg: "#13284d", fg: "#7aa7ff", dot: palette.blue },
};

/** A rounded status chip. @param {string} label @param {keyof typeof tones} tone */
export function chip(label, tone) {
  const t = tones[tone];
  return div().flex_shrink_0().px(9).py(3).rounded(6).bg(t.bg).text_color(t.fg).text_size(11).font_medium().child(label);
}

export const dot = (color, size = 7) => div().flex_shrink_0().size(size).rounded_full().bg(color);

/** A thin progress bar. @param {number} percent */
export function bar(percent, color, height = 6) {
  return div()
    .w_full()
    .h(height)
    .rounded_full()
    .bg(palette.track)
    .child(div().h_full().rounded_full().bg(color).w(`${Math.max(0, Math.min(100, percent)).toFixed(1)}%`));
}

/** A dashboard card with an icon, a title and an optional link on the right. */
export function card(cx, compact, iconName, title, action, body) {
  const colors = cx.theme().colors;
  return div()
    .flex()
    .flex_col()
    .flex_1()
    .min_w(0)
    .h_full()
    .overflow_hidden()
    .p(compact ? 14 : 18)
    .gap(compact ? 10 : 14)
    .rounded(10)
    .bg(palette.card)
    .border(1)
    .border_color(palette.cardBorder)
    .child(
      h_flex()
        .items_center()
        .gap(10)
        .child(icon(iconName, 20).text_color(colors.foreground))
        .child(div().flex_1().min_w(0).whitespace_nowrap().text_ellipsis().text_size(13).font_medium().child(title))
        .when(Boolean(action), (el) => el.child(action)),
    )
    .child(body);
}

/** "View Details →" in link blue. */
export function link(label) {
  return h_flex().items_center().gap(4).text_size(11).text_color(palette.link).child(label).child(icon("arrow-right", 11));
}
