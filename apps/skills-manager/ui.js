// @ts-check
import { div, svg } from "gpui-kit";
import { h_flex, Button } from "gpui-base";
import { palette } from "./theme.js";

/** @param {string} name @param {number} [size] */
export const icon = (name, size = 16) => svg(`skills-manager/icons/${name}.svg`).size(size).flex_shrink_0();

/** Muted text. @param {string} value */
export const muted = (value, cx, size = 13) =>
  div().text_size(size).text_color(cx.theme().colors.muted_foreground).child(value);

/** The small square mark beside an author or folder name. @param {string} who */
export function mark(who, size = 16) {
  const style = palette.marks[who] ?? { bg: "#8a8a8a", fg: "#ffffff", letter: who.slice(0, 1).toUpperCase() };
  return div()
    .flex()
    .flex_shrink_0()
    .items_center()
    .justify_center()
    .size(size)
    .rounded(4)
    .bg(style.bg)
    .text_color(style.fg)
    .text_size(Math.round(size * 0.62))
    .font_semibold()
    .child(style.letter);
}

/** "by ▢ Author", as on each card. @param {string} who */
export const byline = (who, cx, prefix = "by") =>
  h_flex()
    .gap(6)
    .items_center()
    .text_size(14)
    .when(Boolean(prefix), (el) => el.child(muted(prefix, cx, 14)))
    .child(mark(who))
    .child(div().text_color(cx.theme().colors.foreground).child(who));

/**
 * A bordered button with an optional leading icon.
 * @param {string} id @param {string} label @param {(cx: any) => void} onClick
 * @param {{ icon?: string, primary?: boolean, danger?: boolean, disabled?: boolean, small?: boolean }} [options]
 */
export function button(id, label, onClick, cx, options = {}) {
  const colors = cx.theme().colors;
  const bg = options.primary ? colors.primary : options.danger ? colors.destructive : colors.surface;
  const fg = options.primary ? colors.primary_foreground : options.danger ? colors.destructive_foreground : colors.foreground;
  return Button.new(id)
    .flex()
    .flex_shrink_0()
    .items_center()
    .gap(6)
    .h(options.small ? 28 : 34)
    .px(options.small ? 10 : 12)
    .rounded(7)
    .border(1)
    .border_color(options.primary || options.danger ? bg : colors.input)
    .bg(bg)
    .text_color(fg)
    .text_size(options.small ? 13 : 14)
    .font_medium()
    .when(!options.disabled, (el) =>
      el.cursor_pointer()
        .hover((s) => s.opacity(0.88))
        .on_click((_event, cx) => onClick(cx)))
    .when(Boolean(options.disabled), (el) => el.opacity(0.45))
    .when(Boolean(options.icon), (el) => el.child(icon(options.icon, 15)))
    .child(label);
}

/** A square bordered icon button, like the + on each card. */
export function iconButton(id, name, onClick, cx, options = {}) {
  const colors = cx.theme().colors;
  return Button.new(id)
    .flex()
    .flex_shrink_0()
    .items_center()
    .justify_center()
    .size(options.size ?? 26)
    .rounded(6)
    .border(1)
    .border_color(colors.input)
    .bg(colors.surface)
    .text_color(options.color ?? colors.foreground)
    .when(!options.disabled, (el) =>
      el.cursor_pointer()
        .hover((s) => s.bg(colors.muted))
        .on_click((event, cx) => {
          cx.stop_propagation();
          onClick(cx, event);
        }))
    .when(Boolean(options.disabled), (el) => el.opacity(0.5))
    .when(Boolean(options.tooltip), (el) => el.tooltip(options.tooltip))
    .child(icon(name, options.iconSize ?? 15));
}

/** A small pill. @param {string} label */
export function pill(label, cx, tone = "neutral") {
  const colors = cx.theme().colors;
  const fg = tone === "warning" ? palette.warning : tone === "danger" ? colors.destructive : tone === "success" ? palette.success : colors.muted_foreground;
  return div()
    .flex_shrink_0()
    .px(6)
    .py(1)
    .rounded(5)
    .border(1)
    .border_color(colors.border)
    .bg(colors.muted)
    .text_size(11)
    .font_medium()
    .text_color(fg)
    .child(label);
}
