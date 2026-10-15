// @ts-check
import { div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Button, Input } from "gpui-base";
import { tone, monoFont, mix } from "./theme.js";
import { person, priorityOf, me } from "./data.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Element} Element */

/** @param {string} name @param {number} [size] */
export const icon = (name, size = 16) => svg(`tickets/icons/${name}.svg`).size(size).flex_shrink_0();

/** Text in the mono face. @param {string} value */
export const mono = (value) => div().font_family(monoFont).child(value);

/** @param {string} id */
export function priorityColor(id, cx) {
  if (id === "urgent") return tone.red;
  if (id === "high") return tone.orange;
  if (id === "medium") return tone.blue;
  return cx.theme().colors.muted_foreground;
}

/** The arrow, dash or dashed circle for a priority. @param {string} id */
export const priorityIcon = (id, cx, size = 15) =>
  icon(priorityOf(id).icon, size).text_color(priorityColor(id, cx));

/** @param {"on_track" | "warning" | "breached"} sla */
export function slaColor(sla, cx) {
  if (sla === "breached") return tone.red;
  if (sla === "warning") return tone.orange;
  return cx.theme().colors.foreground;
}

/**
 * A small dot-and-label pill. `color` tints it; a named tone ("warning",
 * "breached", "neutral") uses the measured palette from the design.
 * @param {string} label @param {string} color
 */
export function pill(label, color, cx, tinted = true) {
  const colors = cx.theme().colors;
  const named = !tinted ? tone.neutral : null;
  const look = named ?? {
    dot: color,
    fg: mix(color, colors.foreground, cx.theme().is_dark ? 0.25 : 0),
    bg: mix(colors.background, color, cx.theme().is_dark ? 0.13 : 0.08),
    edge: mix(colors.background, color, cx.theme().is_dark ? 0.32 : 0.28),
  };
  return h_flex()
    .flex_shrink_0()
    .items_center()
    .gap(5)
    .h(22)
    .px(8)
    .rounded_full()
    .border(1)
    .border_color(/** @type {`#${string}`} */ (look.edge))
    .bg(/** @type {`#${string}`} */ (look.bg))
    .text_size(12.5)
    .text_color(/** @type {`#${string}`} */ (look.fg))
    .child(div().size(6).rounded_full().bg(/** @type {`#${string}`} */ (look.dot)))
    .child(label);
}

/** The SLA pill. @param {"on_track" | "warning" | "breached"} sla @param {string} label */
export function slaPill(sla, label, cx) {
  const look = sla === "on_track" ? tone.neutral : tone[sla];
  return h_flex()
    .flex_shrink_0()
    .items_center()
    .gap(5)
    .h(22)
    .px(8)
    .rounded_full()
    .border(1)
    .border_color(/** @type {`#${string}`} */ (look.edge))
    .bg(/** @type {`#${string}`} */ (look.bg))
    .text_size(12.5)
    .text_color(/** @type {`#${string}`} */ (look.fg))
    .child(div().size(6).rounded_full().bg(/** @type {`#${string}`} */ (look.dot)))
    .child(label);
}

// ---------------------------------------------------------------- surfaces

/**
 * Gives an element the design's layered frame: a dark outer ring as its own
 * border, a hairline edge just inside it, and a lit top edge. The two inner
 * lines are overlays, so the element keeps its own layout and fill.
 * @template {import("gpui-kit").NativeElement} E
 * @param {E} el @param {number} r  the element's outer radius
 */
export function frame(el, r, { ring = tone.ring, edge = tone.edge, sheen = tone.sheen } = {}) {
  return el
    .rounded(r)
    .border(1)
    .border_color(/** @type {`#${string}`} */ (ring))
    .child(div().absolute().inset_0().rounded(Math.max(0, r - 1)).border(1).border_color(/** @type {`#${string}`} */ (edge)))
    // The lit top edge covers only the straight run of the top side: drawn
    // into the corners, a border-only overlay is cut off where it ends.
    .child(div().absolute().top(0).left(Math.max(1, r)).right(Math.max(1, r)).h(1).bg(/** @type {`#${string}`} */ (sheen)));
}

const curve = 0.5522847498;
const paths = new Map();

/**
 * One end of a rounded box, `r` wide and `h` tall, in pixels.
 * @param {"left" | "right"} side @param {number} r @param {number} h
 */
function capPath(side, r, h) {
  const key = `${side}:${r}:${h}`;
  if (!paths.has(key)) {
    const k = r * curve;
    const build = side === "left"
      ? PathBuilder.fill().move_to(r, 0).line_to(r, h).line_to(r, h)
        .cubic_bezier_to(0, h - r, r - k, h, 0, h - r + k)
        .line_to(0, r)
        .cubic_bezier_to(r, 0, 0, r - k, r - k, 0)
      : PathBuilder.fill().move_to(0, 0)
        .cubic_bezier_to(r, r, k, 0, r, r - k)
        .line_to(r, h - r)
        .cubic_bezier_to(0, h, r, h - r + k, k, h)
        .line_to(0, 0);
    paths.set(key, build.close().build());
  }
  return paths.get(key);
}

/** The straight middle of a rounded box, as a share of its bounds. */
function middlePath() {
  if (!paths.has("middle")) paths.set("middle", PathBuilder.fill().add_polygon([[0, "0%"], ["100%", "0%"], ["100%", "100%"], [0, "100%"]], true).build());
  return paths.get("middle");
}

/**
 * A vertical gradient filling a rounded box of known height, painted behind
 * an element's content: two rounded ends and a straight middle, each painted
 * with the same gradient so the seams do not show. Add the layers before the
 * content.
 * @param {number} h  inner height @param {number} r  inner radius
 * @param {string} top @param {string} bottom
 */
export function gloss(h, r, top, bottom) {
  const fill = () => Background.linear_gradient(180, Background.stop(/** @type {`#${string}`} */ (top), 0), Background.stop(/** @type {`#${string}`} */ (bottom), 100));
  const radius = Math.min(r, h / 2);
  return [
    window.paint_path(capPath("left", radius, h), fill()).absolute().left(0).top(0).w(radius).h(h),
    window.paint_path(middlePath(), fill()).absolute().left(radius).right(radius).top(0).h(h),
    window.paint_path(capPath("right", radius, h), fill()).absolute().right(0).top(0).w(radius).h(h),
  ];
}

/**
 * A teammate's initials in a circle: tinted for the signed-in agent, an
 * outline for everyone else, an empty dashed ring when nobody owns the ticket.
 * @param {string | null} id
 */
export function avatar(id, cx, size = 24) {
  const colors = cx.theme().colors;
  const who = person(id);
  if (!who) {
    return div()
      .flex_shrink_0()
      .size(size)
      .rounded_full()
      .border(1)
      .border_dashed()
      .border_color(colors.ring);
  }
  return initialsBadge(who.initials, cx, size, who.id === me.id);
}

/** Initials in a circle. @param {string} initials */
export function initialsBadge(initials, cx, size = 24, highlighted = false) {
  const colors = cx.theme().colors;
  return div()
    .flex_shrink_0()
    .flex()
    .items_center()
    .justify_center()
    .size(size)
    .rounded_full()
    .border(1)
    .map((el) => highlighted
      ? el.border_color(`${colors.primary}88`).bg(`${colors.primary}26`).text_color(tone.ink)
      : el.border_color(colors.ring).text_color(colors.muted_foreground))
    .text_size(size >= 30 ? 12 : size >= 22 ? 10 : 8)
    .font_semibold()
    .child(initials);
}

/**
 * A row of choices, one of them current.
 * @template {string} T
 * @param {string} id @param {readonly { id: T, label: string }[]} options @param {T | null} current
 * @param {(value: T, cx: Context) => void} onPick
 * @param {(value: T) => Element | null} [lead]
 */
export function chips(id, options, current, onPick, cx, lead) {
  const colors = cx.theme().colors;
  return h_flex()
    .flex_wrap()
    .gap(6)
    .children(options.map((o) => {
      const on = o.id === current;
      const leading = lead ? lead(o.id) : null;
      return Button.new(`${id}-${o.id}`)
        .h(28)
        .px(10)
        .flex()
        .items_center()
        .gap(6)
        .rounded(7)
        .border(1)
        .border_color(on ? colors.ring : colors.border)
        .bg(on ? colors.accent : "#00000000")
        .text_size(13)
        .text_color(on ? colors.foreground : colors.muted_foreground)
        .when(on, (el) => el.font_medium())
        .hover((h) => h.bg(colors.accent).text_color(colors.foreground))
        .on_click((_event, cx) => onPick(o.id, cx))
        .when(leading !== null, (el) => el.child(leading ?? ""))
        .child(o.label);
    }));
}

/** A label over a control. @param {string} label @param {Element} control */
export const labelled = (label, control, cx) =>
  v_flex()
    .gap(8)
    .child(div().text_size(14).font_semibold().text_color(cx.theme().colors.foreground).child(label))
    .child(control);

/** A framed single-line input. @param {import("gpui-base").InputState} state */
export const field = (state, cx, h = 40) => {
  const colors = cx.theme().colors;
  return frame(h_flex()
    .h(h)
    .px(14)
    .items_center()
    .bg(tone.well), 10)
    .child(Input.new(state).flex_1().min_w_0().text_size(14).text_color(colors.foreground));
};

/**
 * The face of a dropdown: the current value and a chevron. Pair it with a
 * `Popup` for the list.
 * @param {string} id @param {Element | string} value
 * @param {(cx: Context) => void} onClick
 */
export function selectTrigger(id, value, onClick, cx, { open = false, wide = false, chevron = "chevron-down", h = 34 } = {}) {
  const colors = cx.theme().colors;
  return frame(Button.new(id)
    .h(h)
    .px(12)
    .flex()
    .items_center()
    .gap(8)
    .bg(open ? colors.accent : tone.raise)
    .text_size(14)
    .font_medium()
    .hover((h) => h.bg(colors.accent))
    .on_click((_event, cx) => onClick(cx))
    .when(wide, (el) => el.w_full())
    .child(div().flex_1().min_w_0().truncate().flex().items_center().gap(8).child(value))
    .child(icon(chevron, 15).text_color(colors.muted_foreground)), wide ? 10 : 9);
}

/**
 * An icon button. `bordered` gives it the raised frame and gloss of the
 * header buttons; otherwise it is quiet until hovered.
 * @param {string} id @param {string} name @param {string} tip
 * @param {(cx: Context) => void} onClick
 */
export function iconButton(id, name, tip, onClick, cx, { size = 30, iconSize = 16, round = false, bordered = false, active = false, strong = false } = {}) {
  const colors = cx.theme().colors;
  const r = round ? size / 2 : 8;
  const el = Button.new(id)
    .flex_shrink_0()
    .size(size)
    .flex()
    .items_center()
    .justify_center()
    .rounded(r)
    .text_color(active || bordered || strong ? colors.foreground : colors.muted_foreground)
    .tooltip(tip)
    .on_click((_event, cx) => onClick(cx));
  if (!bordered) {
    return el
      .bg(active ? colors.accent : "#00000000")
      .hover((h) => h.bg(colors.accent).text_color(colors.foreground))
      .child(icon(name, iconSize));
  }
  return frame(el
    .when(active, (b) => b.bg(colors.accent))
    .hover((h) => h.opacity(0.85))
    .when(!active, (b) => b.children(gloss(size - 2, r - 1, tone.glossTop, tone.glossBottom)))
    .child(icon(name, iconSize)), r);
}

/**
 * A labelled button. `primary` fills it with the brand gradient.
 * @param {string} id @param {string} label @param {string | null} iconName
 * @param {(cx: Context) => void} onClick
 */
export function textButton(id, label, iconName, onClick, cx, { primary = false, danger = false, h = 34, pillShape = false } = {}) {
  const colors = cx.theme().colors;
  const r = pillShape ? h / 2 : 9;
  const el = Button.new(id)
    .flex_shrink_0()
    .h(h)
    .px(pillShape ? 16 : 14)
    .flex()
    .items_center()
    .gap(7)
    .text_size(14)
    .font_medium()
    .hover((h) => h.opacity(0.88))
    .on_click((_event, cx) => onClick(cx))
    .children(gloss(h - 2, r - 1, primary ? tone.primaryTop : tone.glossTop, primary ? tone.primaryBottom : tone.glossBottom))
    .text_color(primary ? colors.primary_foreground : danger ? colors.destructive : colors.foreground)
    .when(iconName !== null, (el) => el.child(icon(iconName ?? "", 15)))
    .child(label);
  return primary
    ? frame(el, r, { ring: tone.ring, edge: mix(tone.primaryBottom, "#000000", 0.08), sheen: mix(tone.primaryTop, "#ffffff", 0.4) })
    : frame(el, r);
}

/** The floating surface of a menu or popover. @param {Element[]} items */
export function menuPanel(items, cx, width = 220) {
  const colors = cx.theme().colors;
  return frame(v_flex()
    .w(width)
    .p(5)
    .gap(1)
    .bg(tone.raise)
    .shadow_lg(), 12)
    // Presses inside the panel never reach the backdrop behind it.
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .children(items);
}

/**
 * One row of a menu.
 * @param {string} id @param {string} label
 * @param {(cx: Context) => void} onSelect
 */
export function menuItem(id, label, onSelect, cx, { checked = false, lead = /** @type {Element | null} */ (null), danger = false, trail = /** @type {string | null} */ (null) } = {}) {
  const colors = cx.theme().colors;
  return Button.new(id)
    .h(30)
    .px(8)
    .flex()
    .items_center()
    .gap(8)
    .rounded(6)
    .text_size(13)
    .text_color(danger ? colors.destructive : colors.foreground)
    .hover((h) => h.bg(colors.accent))
    .on_click((_event, cx) => onSelect(cx))
    .when(lead !== null, (el) => el.child(lead ?? ""))
    .child(div().flex_1().min_w_0().truncate().child(label))
    .when(trail !== null, (el) => el.child(div().text_size(12).text_color(colors.muted_foreground).child(trail ?? "")))
    .child(div().w(16).flex().justify_center().when(checked, (el) => el.child(icon("check", 14))));
}

/** A small mono heading over a menu or sidebar section. @param {string} label */
export const sectionLabel = (label, cx) =>
  div()
    .px(8)
    .pt(6)
    .pb(4)
    .text_size(12)
    .font_family(monoFont)
    .text_color(cx.theme().colors.muted_foreground)
    .child(label);

/**
 * A sidebar navigation row with an optional count.
 * @param {string} id @param {string} label @param {Element} lead @param {boolean} on
 * @param {(cx: Context) => void} onClick @param {number | null} count
 */
export function sidebarRow(id, label, lead, on, onClick, count, cx) {
  const colors = cx.theme().colors;
  const row = Button.new(id)
    .h(32)
    .px(10)
    .flex()
    .items_center()
    .gap(10)
    .rounded(10)
    .text_size(14)
    .on_click((_event, cx) => onClick(cx))
    .when(on, (el) => el.bg(colors.accent).font_medium())
    .when(!on, (el) => el.border(1).border_color("#00000000").text_color(colors.muted_foreground).hover((h) => h.bg(tone.raise).text_color(colors.foreground)))
    .child(lead)
    .child(div().flex_1().min_w_0().truncate().child(label))
    .when(count !== null, (el) => el.child(
      div()
        .min_w(26)
        .h(20)
        .px(7)
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border(1)
        .border_color(on ? tone.sheen : tone.edge)
        .bg(on ? tone.raise : "#00000000")
        .text_size(12)
        .text_color(on ? colors.foreground : colors.muted_foreground)
        .child(String(count)),
    ));
  return on ? frame(row, 10) : row;
}

/** A hand-drawn checkbox. @param {string} id @param {boolean | "mixed"} checked @param {(cx: Context) => void} onToggle */
export function checkbox(id, checked, onToggle, cx) {
  const colors = cx.theme().colors;
  return Button.new(id)
    .size(18)
    .flex_shrink_0()
    .flex()
    .items_center()
    .justify_center()
    .rounded(5)
    .border(1)
    .border_color(checked ? colors.primary : colors.ring)
    .bg(checked ? colors.primary : "#00000000")
    .text_color(colors.primary_foreground)
    .on_click((_event, cx) => {
      cx.stop_propagation();
      onToggle(cx);
    })
    .when(checked === true, (el) => el.child(icon("check", 13)))
    .when(checked === "mixed", (el) => el.child(icon("minus", 13)));
}

/**
 * A dim full-window layer that fades in and closes what sits on it when
 * pressed. Put it first in an `overlay`.
 * @param {string} id @param {boolean} shown @param {(cx: Context) => void} onClose
 */
export const scrim = (id, shown, onClose) =>
  div()
    .id(`${id}-scrim`)
    .absolute()
    .inset_0()
    .bg(tone.scrim)
    .opacity(shown ? 1 : 0)
    .transition("opacity", { duration: 220, easing: "ease-out" })
    .on_mouse_down("left", (_event, cx) => onClose(cx));

/**
 * A side panel that slides in from the right edge of the window.
 * @param {string} id @param {boolean} shown @param {number} width
 */
export function slidePanel(id, shown, width) {
  const viewport = window.viewport_size().width;
  return v_flex()
    .id(id)
    .absolute()
    .top(12)
    .bottom(12)
    .w(width)
    .left(shown ? viewport - width - 12 : viewport + 12)
    .transition("left", { duration: 280, easing: "ease-out" })
    .transition("width", { duration: 280, easing: "ease-out" })
    .rounded(18)
    .shadow_xl()
    .overflow_hidden()
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation());
}

/**
 * A centred dialog box that rises a little as it fades in.
 * @param {string} id @param {boolean} shown @param {Element} panel
 */
export const riseIn = (id, shown, panel) =>
  div()
    .id(`${id}-motion`)
    .relative()
    .top(shown ? 0 : 18)
    .opacity(shown ? 1 : 0)
    .transition("top", { duration: 240, easing: "ease-out" })
    .transition("opacity", { duration: 180, easing: "ease-out" })
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .child(panel);
