import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { palette, monoFont } from "./theme.js";

/** @param {string} name @param {number} [size] */
export const icon = (name, size = 15) => svg(`tendra/icons/${name}.svg`).size(size).flex_shrink_0();

/** Text in the mono face. @param {string} value */
export const mono = (value) => div().font_family(monoFont).child(value);

/** A small monospace status tag. @param {string} label @param {keyof typeof palette.tone} tone */
export function tag(label, tone) {
  const style = palette.tone[tone];
  return div()
    .flex_shrink_0()
    .px(6)
    .py(2)
    .rounded(4)
    .border(1)
    .border_color(style.border)
    .bg(style.bg)
    .text_color(style.fg)
    .text_size(10)
    .font_medium()
    .font_family(monoFont)
    .child(label);
}

/**
 * A teammate's initials in a tinted circle, inside a ring of the surface
 * colour so overlapping avatars stay distinct.
 * @param {string} initials
 */
export function avatar(initials, cx, size = 25) {
  const person = palette.people[initials] ?? palette.people.MK;
  return div()
    .flex_shrink_0()
    .p(2)
    .rounded_full()
    .bg(cx.theme().colors.surface)
    .child(
      div()
        .flex()
        .items_center()
        .justify_center()
        .size(size)
        .rounded_full()
        .border(1)
        .border_color(person.ring)
        .bg(person.bg)
        .text_color(person.fg)
        .text_size(size > 28 ? 11 : 9)
        .font_medium()
        .font_family(monoFont)
        .child(initials),
    );
}

/** Overlapping avatars. @param {string[]} owners */
export function avatarStack(owners, cx) {
  return h_flex().children(owners.map((initials, index) => avatar(initials, cx).when(index > 0, (el) => el.ml(-9))));
}

/**
 * The tick meter on a summary tile: `ticks` thin bars, the first `filled` of
 * them in the stage's colour.
 */
export function meter(filled, color, ticks = 32) {
  return h_flex()
    .h(23)
    .gap(2)
    .children(Array.from({ length: ticks }, (_, index) =>
      div().flex_1().h_full().rounded(1).bg(index < filled ? color : palette.tick)));
}

/** A thin progress bar. @param {number} percent */
export function progressBar(percent, color) {
  return div()
    .flex_1()
    .h(3)
    .rounded_full()
    .bg(palette.track)
    .child(div().h_full().rounded_full().bg(color).w(`${Math.max(0, Math.min(100, percent))}%`));
}

/** Muted text. @param {string} value */
export const muted = (value, cx, size = 13) =>
  div().text_size(size).text_color(cx.theme().colors.muted_foreground).child(value);
