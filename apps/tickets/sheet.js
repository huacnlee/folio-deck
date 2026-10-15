// @ts-check
// The ticket detail panel, and the conversation pieces the inbox shares with it.
import { div } from "gpui-kit";
import { h_flex, v_flex, Button, Textarea, Popup } from "gpui-base";
import { tone, monoFont } from "./theme.js";
import {
  icon, avatar, initialsBadge, iconButton, textButton, menuPanel, menuItem, labelled, field, selectTrigger, pill, slaColor,
  frame, gloss, scrim, slidePanel, slaPill,
} from "./ui.js";
import {
  statuses, ticketTypes, people, me, senders, templates, channels,
  person, statusOf, priorityOf, channelOf, code, isActive, slaOf, slaLabels, relative, stamp, initialsOf,
} from "./data.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Element} Element */
/** @typedef {import("./data.js").Ticket} Ticket */
/** @typedef {import("./main.js").default} App */

/** The four priorities the panel offers, with the dot colour of each. */
const priorityButtons = /** @type {const} */ (["low", "medium", "high", "urgent"]);

/** @param {string} id */
function priorityDot(id, cx) {
  if (id === "low") return cx.theme().colors.primary;
  if (id === "medium") return tone.orange;
  if (id === "high") return tone.pink;
  return tone.red;
}

/**
 * A select whose list opens beneath it.
 * @param {App} app @param {string} id @param {Element | string} value
 * @param {Element[]} items
 */
export function dropdown(app, id, value, items, cx, { wide = false, width = 220, chevron = "chevron-down", h = 34 } = {}) {
  const open = app.menu === id;
  return Popup.new(`${id}-popup`, selectTrigger(id, value, (cx) => app.toggleMenu(id, cx), cx, { open, wide, chevron, h }))
    .anchor("top_left")
    .when(open, (el) => el.content(app.popIn(id, menuPanel(items, cx, width))));
}

/**
 * One entry of a ticket's history: a message with its author, or an event.
 * @param {import("./data.js").Activity} a @param {Ticket} t @param {string} key
 */
export function activityRow(a, t, key, now, cx) {
  const colors = cx.theme().colors;
  const agent = person(a.who);
  /** @param {string} label */
  const chip = (label) => div().px(8).h(22).flex().items_center().rounded_full().border(1).border_color(colors.border)
    .text_size(12).text_color(colors.muted_foreground).child(label);
  if (a.kind === "event") {
    return h_flex()
      .id(`activity-${key}`)
      .items_start()
      .gap(14)
      .child(div().size(36).flex_shrink_0().flex().items_center().justify_center().rounded_full().border(1).border_color(colors.border)
        .text_color(colors.muted_foreground).child(icon("ticket", 15)))
      .child(v_flex().flex_1().min_w_0().pt(1).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().child(a.text))
          .child(div().text_size(13).text_color(colors.muted_foreground).child(relative(a.at, now))))
        .child(div().text_size(13).text_color(colors.muted_foreground).child(agent ? `by ${agent.name}` : "Automatic")));
  }
  const note = a.kind === "note";
  return h_flex()
    .id(`activity-${key}`)
    .items_start()
    .gap(14)
    .child(agent ? avatar(agent.id, cx, 36) : initialsBadge(initialsOf(a.who), cx, 36))
    .child(v_flex().flex_1().min_w_0().gap(6)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child(agent?.name ?? a.who))
        .child(div().text_size(13).text_color(colors.muted_foreground).child(stamp(a.at)))
        .child(chip(channelOf(t.channel).label))
        .child(note
          ? div().px(8).h(22).flex().items_center().rounded_full().bg(`${tone.orange}1f`).text_size(12).text_color(tone.orange).child("Internal note")
          : chip(agent ? "Reply" : "Customer")))
      .child(div()
        .when(note, (el) => el.p(10).rounded(10).bg(`${tone.orange}12`).border(1).border_color(`${tone.orange}33`))
        .line_height(1.5)
        .child(a.text)));
}

/**
 * The reply box: sender, text and templates. `extra` goes beside the
 * template menu, `actions` at the right of the toolbar.
 * @param {App} app @param {string} prefix
 * @param {import("gpui-base").TextareaState} state
 * @param {Element[]} actions
 */
export function composer(app, prefix, state, actions, cx, { via = false } = {}) {
  const colors = cx.theme().colors;
  return frame(v_flex()
    .bg(tone.raise), 16)
    .child(
      h_flex()
        .px(14)
        .py(10)
        .gap(10)
        .items_center()
        .border_b(1)
        .border_color(colors.border)
        .text_color(colors.muted_foreground)
        .when(via, (el) => el
          .child("Via")
          .child(h_flex().gap(2).children(channels.filter((c) => c.id !== "web").map((c) =>
            Button.new(`${prefix}-via-${c.id}`)
              .h(30)
              .px(12)
              .flex()
              .items_center()
              .rounded_full()
              .text_size(13)
              .when(app.via === c.id, (el) => el.bg(colors.accent).text_color(colors.foreground))
              .hover((h) => h.text_color(colors.foreground))
              .on_click((_event, cx) => {
                app.via = c.id;
                cx.notify();
              })
              .child(c.label)))))
        .child("From")
        .child(dropdown(app, `${prefix}-from`, app.sender, senders.map((s) => menuItem(`${prefix}-from-${s}`, s, (cx) => {
          app.sender = s;
          app.menu = null;
          cx.notify();
        }, cx, { checked: app.sender === s })), cx, { h: 32 })),
    )
    .child(div().px(14).pt(12).pb(4).min_h(96).child(Textarea.new(state).w_full().text_size(14).text_color(colors.foreground)))
    .child(
      h_flex()
        .px(12)
        .pb(12)
        .gap(8)
        .items_center()
        .child(dropdown(app, `${prefix}-templates`, h_flex().gap(6).items_center().child(icon("template", 14)).child("Templates"),
          templates.map((t) => menuItem(`${prefix}-template-${t.id}`, t.label, (cx) => {
            const current = state.value().trim();
            state.set_value(current ? `${current}\n\n${t.text}` : t.text);
            app.menu = null;
            cx.notify();
          }, cx)), cx, { width: 240, h: 34 }))
        .child(div().flex_1())
        .children(actions),
    );
}

/** The SLA as a pill: "18m left", "2h overdue". @param {Ticket} t */
export function dueBadge(t, now, cx) {
  const sla = slaOf(t, now);
  const colors = cx.theme().colors;
  if (!isActive(t)) return pill(statusOf(t.status).label, colors.muted_foreground, cx, false);
  const text = t.dueAt >= now ? `${relative(t.dueAt, now).replace("in ", "")} left` : `${relative(t.dueAt, now).replace(" ago", "")} overdue`;
  return slaPill(sla, text, cx);
}

/** @param {App} app */
export function ticketSheet(app, cx) {
  const colors = cx.theme().colors;
  const t = app.openNumber === null ? null : app.ticket(app.openNumber);
  if (!t) return div();
  const number = t.number;
  const now = app.now;
  const sla = slaOf(t, now);
  const type = ticketTypes.find((x) => x.id === (t.type ?? "question")) ?? ticketTypes[0];
  const assignee = person(t.assignee);
  const sendReply = (/** @type {"reply" | "note"} */ kind, resolve = false, /** @type {Context} */ cx) => {
    app.menu = null;
    if (app.postReply(number, kind, app.replyInput, cx) && resolve) app.moveTicket(number, "resolved", cx);
  };

  const shown = app.shown("sheet");
  return div()
    .id("sheet")
    .absolute()
    .inset_0()
    .child(scrim("sheet", shown, (cx) => app.closeSheet(cx)))
    .child(
      frame(slidePanel("sheet-panel", shown, app.sheetWide ? window.viewport_size().width - 96 : 540)
        .bg(colors.background), 18)
        .child(
          h_flex()
            .h(68)
            .px(16)
            .flex_shrink_0()
            .items_center()
            .gap(10)
            .border_b(1)
            .border_color(colors.border)
            .child(div().size(36).flex_shrink_0().flex().items_center().justify_center().rounded(10).border(1).border_color(colors.border)
              .child(icon("ticket", 17)))
            .child(div().min_w_0().truncate().text_size(18).font_semibold().child(t.subject))
            .child(div().flex_shrink_0().px(9).h(24).flex().items_center().rounded_full().bg(colors.muted)
              .font_family(monoFont).text_size(12).text_color(colors.muted_foreground).child(code(number)))
            .child(div().flex_1())
            .child(iconButton("sheet-expand", app.sheetWide ? "shrink" : "expand", app.sheetWide ? "Collapse panel" : "Expand panel", (cx) => {
              app.sheetWide = !app.sheetWide;
              cx.notify();
            }, cx, { size: 34, iconSize: 15, round: true, bordered: true }))
            .child(Popup.new("sheet-more-popup",
              iconButton("sheet-more", "more", "More actions", (cx) => app.toggleMenu("sheet-more", cx), cx, { size: 30, active: app.menu === "sheet-more" }))
              .anchor("top_right")
              .when(app.menu === "sheet-more", (el) => el.content(app.popIn("sheet-more", menuPanel([
                menuItem("sheet-copy", "Copy ticket ID", (cx) => {
                  cx.write_to_clipboard(code(number));
                  app.menu = null;
                  app.toast(`Copied ${code(number)}`, cx);
                  cx.notify();
                }, cx, { lead: icon("copy", 14) }),
                menuItem("sheet-inbox", "Open in Inbox", (cx) => app.openInInbox(number, cx), cx, { lead: icon("inbox", 14) }),
                menuItem("sheet-escalate", t.escalated ? "Remove escalation" : "Escalate to tier 2", (cx) => {
                  app.menu = null;
                  app.patch(number, { escalated: !t.escalated }, cx, t.escalated ? "Escalation removed" : "Escalated to tier 2");
                }, cx, { lead: icon("flag", 14) }),
                div().h(1).my(3).bg(colors.border),
                menuItem("sheet-delete", "Delete ticket", (cx) => {
                  app.menu = null;
                  app.deleteTicket(number, cx);
                }, cx, { lead: icon("trash", 14), danger: true }),
              ], cx, 210)))))
            .child(iconButton("close-sheet", "close", "Close (Esc)", (cx) => app.closeSheet(cx), cx, { size: 30 })),
        )
        .child(
          v_flex()
            .id("sheet-scroll")
            .flex_1()
            .min_h_0()
            .px(20)
            .py(20)
            .gap(22)
            .overflow_y_scrollbar()
            .child(labelled("Ticket Name", field(app.sheetTitle, cx, 44), cx))
            .child(labelled("Priority", h_flex().gap(10).children(priorityButtons.map((p) => {
              const on = t.priority === p;
              return Button.new(`sheet-priority-${p}`)
                .flex_1()
                .h(44)
                .flex()
                .items_center()
                .justify_center()
                .gap(8)
                .rounded(12)
                .border(1)
                .border_color(on ? colors.ring : colors.border)
                .bg(on ? colors.accent : colors.secondary)
                .text_color(on ? colors.foreground : colors.muted_foreground)
                .when(on, (el) => el.font_medium())
                .hover((h) => h.bg(colors.accent).text_color(colors.foreground))
                .on_click((_event, cx) => app.patch(number, { priority: p }, cx, `Priority updated to ${priorityOf(p).label}`))
                .child(div().size(7).rounded_full().bg(priorityDot(p, cx)))
                .child(priorityOf(p).label);
            })), cx))
            .child(h_flex().gap(14)
              .child(div().flex_1().child(labelled("Ticket Type", dropdown(app, "sheet-type", type.label, ticketTypes.map((x) => menuItem(`sheet-type-${x.id}`, x.label, (cx) => {
                app.menu = null;
                app.patch(number, { type: x.id }, cx, `Ticket type confirmed as ${x.label}`);
              }, cx, { checked: x.id === type.id })), cx, { wide: true, chevron: "updown", h: 40 }), cx)))
              .child(div().flex_1().child(labelled("Status", dropdown(app, "sheet-status",
                h_flex().gap(8).items_center().child(icon(statusOf(t.status).icon, 14)).child(statusOf(t.status).label),
                statuses.map((s) => menuItem(`sheet-status-${s.id}`, s.label, (cx) => {
                  app.menu = null;
                  app.moveTicket(number, s.id, cx);
                }, cx, { checked: s.id === t.status, lead: icon(s.icon, 14) })), cx, { wide: true, chevron: "updown", h: 40 }), cx))))
            .child(h_flex().gap(14)
              .child(div().flex_1().child(labelled("Requester", h_flex().h(40).px(12).gap(10).items_center().rounded(10).border(1).border_color(colors.border)
                .child(initialsBadge(initialsOf(t.contact), cx, 24))
                .child(div().flex_1().min_w_0().truncate().child(`${t.contact} · ${t.customer}`)), cx)))
              .child(div().flex_1().child(labelled("Assignee", dropdown(app, "sheet-assignee",
                h_flex().gap(8).items_center().child(avatar(t.assignee, cx, 22)).child(assignee?.name ?? "Unassigned"),
                [...people, null].map((p) => menuItem(`sheet-assignee-${p?.id ?? "none"}`, p ? (p.id === me.id ? `${p.name} (you)` : p.name) : "Unassigned", (cx) => {
                  app.menu = null;
                  app.patch(number, { assignee: p?.id ?? null }, cx, p ? `Assigned to ${p.name}` : "Unassigned");
                }, cx, { checked: (p?.id ?? null) === t.assignee, lead: avatar(p?.id ?? null, cx, 20) })), cx, { wide: true, chevron: "updown", h: 40 }), cx))))
            .child(h_flex().gap(10).items_center()
              .child(dueBadge(t, now, cx))
              .child(div().text_size(13).text_color(colors.muted_foreground)
                .child(isActive(t) ? `${slaLabels[sla]} · due ${stamp(t.dueAt)}` : `Opened ${stamp(t.createdAt)}`))
              .when(t.escalated && isActive(t), (el) => el.child(pill("Escalated", tone.orange, cx))))
            .child(div().h(1).bg(colors.border))
            .child(labelled("Message", composer(app, "sheet", app.replyInput, [], cx), cx))
            .child(div().text_size(14).font_semibold().child("Activity"))
            .children(t.activity.slice().reverse().map((a, index) => activityRow(a, t, `sheet-${index}`, now, cx))),
        )
        .child(
          h_flex()
            .h(68)
            .px(20)
            .flex_shrink_0()
            .gap(10)
            .items_center()
            .justify_end()
            .border_t(1)
            .border_color(colors.border)
            .child(Button.new("sheet-cancel").h(38).px(14).flex().items_center().rounded(10).font_medium()
              .hover((h) => h.bg(colors.accent))
              .on_click((_event, cx) => app.closeSheet(cx))
              .child("Cancel"))
            .child(
              frame(h_flex()
                .h(40)
                .text_color(colors.primary_foreground)
                .font_medium()
                .children(gloss(38, 9, tone.primaryTop, tone.primaryBottom)), 10, { ring: tone.ring, edge: tone.primaryBottom, sheen: tone.primaryTop })
                .child(Button.new("sheet-send").h(38).px(18).flex().items_center().gap(8).rounded_l(10)
                  .hover((h) => h.bg("#ffffff26"))
                  .on_click((_event, cx) => sendReply("reply", false, cx))
                  .child("Send Reply")
                  .child(icon("send", 14)))
                .child(div().w(1).h(24).bg(`${colors.primary_foreground}33`))
                .child(Popup.new("sheet-send-popup",
                  Button.new("sheet-send-more").h(38).w(38).flex().items_center().justify_center().rounded_r(10)
                    .hover((h) => h.bg("#ffffff26"))
                    .on_click((_event, cx) => app.toggleMenu("sheet-send-more", cx))
                    .child(icon("chevron-down", 15)))
                  .anchor("bottom_right")
                  .when(app.menu === "sheet-send-more", (el) => el.content(app.popIn("sheet-send-more", menuPanel([
                    menuItem("send-resolve", "Send and resolve", (cx) => sendReply("reply", true, cx), cx, { lead: icon("check", 14) }),
                    menuItem("send-note", "Add as internal note", (cx) => sendReply("note", false, cx), cx, { lead: icon("message", 14) }),
                  ], cx, 220), { up: true })))),
            ),
        ),
    );
}
