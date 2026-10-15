// @ts-check
// The inbox: active tickets read as conversations, one at a time.
import { div } from "gpui-kit";
import { h_flex, v_flex, Button, Input, Popup } from "gpui-base";
import { tone } from "./theme.js";
import { icon, initialsBadge, iconButton, textButton, menuPanel, menuItem, sectionLabel, sidebarRow, pill, frame } from "./ui.js";
import { me, person, priorityOf, code, isActive, relative, initialsOf } from "./data.js";
import { activityRow, composer, dueBadge } from "./sheet.js";

/** @typedef {import("./main.js").default} App */
/** @typedef {import("./data.js").Ticket} Ticket */
/** @typedef {"mine" | "unassigned" | "open" | "snoozed"} InboxView */

const hour = 3_600_000;

export const inboxViews = /** @type {const} */ ([
  { id: "mine", label: "My inbox", icon: "user" },
  { id: "unassigned", label: "Unassigned", icon: "user-x" },
  { id: "open", label: "All open", icon: "inbox" },
  { id: "snoozed", label: "Snoozed", icon: "clock" },
]);

/** @param {Ticket} t */
const snoozed = (t, now) => (t.snoozedUntil ?? 0) > now;

/** When the customer last wrote. @param {Ticket} t */
export function lastCustomerReply(t) {
  let at = 0;
  for (const a of t.activity) if (a.kind === "reply" && !person(a.who)) at = Math.max(at, a.at);
  return at;
}

/** @param {Ticket} t */
export const isUnread = (t) => lastCustomerReply(t) > (t.seenAt ?? 0);

/** @param {App} app @param {InboxView} view */
export function conversations(app, view) {
  const now = app.now;
  return app.tickets
    .filter((t) => isActive(t))
    .filter((t) => view === "snoozed" ? snoozed(t, now) : !snoozed(t, now))
    .filter((t) => view === "mine" ? t.assignee === me.id : view === "unassigned" ? t.assignee === null : true)
    .sort((a, b) => Number(isUnread(b)) - Number(isUnread(a))
      || priorityOf(a.priority).rank - priorityOf(b.priority).rank
      || b.activity[b.activity.length - 1].at - a.activity[a.activity.length - 1].at);
}

/** The conversations the list shows, after its own filters. @param {App} app */
export function listed(app) {
  const q = app.inboxQuery;
  return conversations(app, app.inboxView)
    .filter((t) => !app.inboxUnreadOnly || isUnread(t))
    .filter((t) => !q || `${t.contact} ${t.customer} ${t.subject} ${code(t.number)}`.toLowerCase().includes(q));
}

/** @param {App} app */
export function inboxSidebar(app, cx) {
  const colors = cx.theme().colors;
  const list = listed(app);
  return v_flex()
    .id("inbox-sidebar")
    .w(300)
    .h_full()
    .flex_shrink_0()
    .border_r(1)
    .border_color(colors.border)
    .child(div().h(14).flex_shrink_0().window_control_area("drag"))
    .child(
      v_flex()
        .px(12)
        .pb(12)
        .gap(2)
        .border_b(1)
        .border_color(colors.border)
        .child(sectionLabel("Views", cx))
        .children(inboxViews.map((v) => sidebarRow(`inbox-view-${v.id}`, v.label, icon(v.icon, 16), app.inboxView === v.id, (cx) => {
          app.inboxView = v.id;
          app.inboxNumber = null;
          cx.notify();
        }, conversations(app, v.id).length, cx))),
    )
    .child(
      h_flex()
        .h(48)
        .pl(20)
        .pr(12)
        .flex_shrink_0()
        .items_center()
        .gap(2)
        .child(div().flex_1().text_color(colors.muted_foreground).child(inboxViews.find((v) => v.id === app.inboxView)?.label ?? ""))
        .child(iconButton("inbox-unread-only", "filter", app.inboxUnreadOnly ? "Show every conversation" : "Show unread only", (cx) => {
          app.inboxUnreadOnly = !app.inboxUnreadOnly;
          cx.notify();
        }, cx, { size: 30, active: app.inboxUnreadOnly }))
        .child(iconButton("inbox-search-toggle", "search", "Search conversations", (cx) => {
          app.inboxSearchOpen = !app.inboxSearchOpen;
          if (!app.inboxSearchOpen) {
            app.inboxSearch.set_value("");
            app.inboxQuery = "";
          }
          cx.notify();
        }, cx, { size: 30, active: app.inboxSearchOpen })),
    )
    .when(app.inboxSearchOpen, (el) => el.child(
      frame(h_flex()
        .mx(12)
        .mb(8)
        .h(34)
        .px(10)
        .gap(8)
        .flex_shrink_0()
        .items_center()
        .bg(tone.well)
        .text_color(colors.muted_foreground), 9)
        .child(icon("search", 14))
        .child(Input.new(app.inboxSearch).flex_1().min_w_0().text_size(13).text_color(colors.foreground)),
    ))
    .child(
      v_flex()
        .id("inbox-list")
        .flex_1()
        .min_h_0()
        .px(12)
        .pb(12)
        .gap(2)
        .overflow_y_scrollbar()
        .children(list.map((t) => conversationRow(app, t, cx)))
        .when(list.length === 0, (el) => el.child(
          div().py(24).text_center().text_size(13).text_color(colors.muted_foreground)
            .child(app.inboxView === "snoozed" ? "Nothing is snoozed." : "No conversations here."),
        )),
    );
}

/** @param {App} app @param {Ticket} t */
function conversationRow(app, t, cx) {
  const colors = cx.theme().colors;
  const selected = app.selectedConversation()?.number === t.number;
  const unread = isUnread(t);
  const last = t.activity[t.activity.length - 1].at;
  return Button.new(`conversation-${t.number}`)
    .h(60)
    .px(10)
    .flex()
    .items_center()
    .gap(12)
    .rounded(12)
    .when(selected, (el) => el.bg(colors.accent))
    .hover((h) => h.bg(tone.raise))
    .on_click((_event, cx) => app.selectConversation(t.number, cx))
    .child(initialsBadge(initialsOf(t.contact), cx, 32))
    .child(v_flex().flex_1().min_w_0().gap(2)
      .child(div().truncate().font_medium().when(!unread, (el) => el.text_color(colors.secondary_foreground)).child(t.contact))
      .child(div().truncate().text_size(13).text_color(colors.muted_foreground).child(t.subject)))
    .child(unread
      ? div().size(7).mr(4).rounded_full().bg(colors.primary)
      : div().text_size(12).text_color(colors.muted_foreground).child(relative(last, app.now).replace(" ago", "").replace("in ", "")));
}

/** @param {App} app */
export function inboxPage(app, cx) {
  const colors = cx.theme().colors;
  const t = app.selectedConversation();
  if (!t) {
    return v_flex().flex_1().items_center().justify_center().gap(10)
      .child(icon("inbox", 28).text_color(colors.muted_foreground))
      .child(div().text_size(16).font_semibold().child("Inbox zero"))
      .child(div().text_color(colors.muted_foreground).child("No conversation is waiting in this view."));
  }
  const number = t.number;
  const owner = person(t.assignee);
  const isSnoozed = snoozed(t, app.now);
  /** @param {string} label @param {string} value */
  const meta = (label, value) => h_flex().gap(8).child(div().text_color(colors.muted_foreground).child(label)).child(div().font_medium().child(value));
  const snooze = (/** @type {number} */ until, /** @type {string} */ label, /** @type {import("gpui-kit").Context} */ cx) => {
    app.menu = null;
    app.patch(number, { snoozedUntil: until }, cx, until ? `Snoozed until ${label}` : "Snooze removed");
    app.toast(until ? `Snoozed until ${label}` : "Back in the inbox", cx);
  };
  const tomorrow = new Date(app.now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  return v_flex()
    .flex_1()
    .min_h_0()
    .px(36)
    .pb(24)
    .child(
      h_flex()
        .py(20)
        .gap(16)
        .items_center()
        .border_b(1)
        .border_color(colors.border)
        .child(initialsBadge(initialsOf(t.customer), cx, 44))
        .child(v_flex().flex_1().min_w_0().gap(6)
          .child(h_flex().gap(10).items_center()
            .child(div().text_size(22).font_semibold().child(t.customer))
            .when(t.priority !== "none", (el) => el.child(pill(priorityOf(t.priority).label.toLowerCase(),
              t.priority === "urgent" ? tone.red : t.priority === "high" ? tone.orange : colors.muted_foreground, cx, t.priority === "urgent" || t.priority === "high")))
            .child(dueBadge(t, app.now, cx))
            .when(isSnoozed, (el) => el.child(pill("snoozed", colors.muted_foreground, cx, false))))
          .child(h_flex().gap(14).items_center().text_size(15)
            .child(meta("Ticket", code(number)))
            .child(div().w(1).h(16).bg(colors.border))
            .child(meta("Contact", t.contact))
            .child(div().w(1).h(16).bg(colors.border))
            .child(meta("Owner", owner?.name.split(" ")[0] ?? "Nobody"))))
        .child(h_flex().gap(10)
          .child(iconButton("inbox-assign", "user", t.assignee === me.id ? "Unassign me" : "Assign to me", (cx) => {
            const mine = t.assignee === me.id;
            app.patch(number, { assignee: mine ? null : me.id }, cx, mine ? "Unassigned" : `Assigned to ${me.name}`);
          }, cx, { size: 40, iconSize: 17, round: true, bordered: true, active: t.assignee === me.id }))
          .child(Popup.new("inbox-snooze-popup",
            iconButton("inbox-snooze", "clock", "Snooze", (cx) => app.toggleMenu("inbox-snooze", cx), cx, { size: 40, iconSize: 17, round: true, bordered: true, active: app.menu === "inbox-snooze" || isSnoozed }))
            .anchor("top_right")
            .when(app.menu === "inbox-snooze", (el) => el.content(app.popIn("inbox-snooze", menuPanel([
              sectionLabel("Snooze until", cx),
              menuItem("snooze-1h", "In 1 hour", (cx) => snooze(app.now + hour, "in 1 hour", cx), cx),
              menuItem("snooze-4h", "In 4 hours", (cx) => snooze(app.now + 4 * hour, "in 4 hours", cx), cx),
              menuItem("snooze-tomorrow", "Tomorrow, 9:00", (cx) => snooze(tomorrow.getTime(), "tomorrow", cx), cx),
              menuItem("snooze-week", "Next week", (cx) => snooze(app.now + 7 * 24 * hour, "next week", cx), cx),
              ...(isSnoozed ? [div().h(1).my(3).bg(colors.border), menuItem("snooze-off", "Unsnooze", (cx) => snooze(0, "", cx), cx)] : []),
            ], cx, 200)))))
          .child(iconButton("inbox-resolve", "check", "Resolve", (cx) => {
            app.moveTicket(number, "resolved", cx);
            app.inboxNumber = null;
          }, cx, { size: 40, iconSize: 17, round: true, bordered: true }))
          .child(iconButton("inbox-expand", "expand", "Open ticket details", (cx) => app.openTicket(number, cx), cx, { size: 40, iconSize: 16, round: true, bordered: true }))),
    )
    .child(
      v_flex()
        .id("inbox-thread")
        .flex_1()
        .min_h_0()
        .py(24)
        .gap(26)
        .overflow_y_scrollbar()
        // A newly picked conversation fades up into place.
        .relative()
        .top(app.shown("thread") ? 0 : 12)
        .opacity(app.shown("thread") ? 1 : 0)
        .transition("top", { duration: 260, easing: "ease-out" })
        .transition("opacity", { duration: 220, easing: "ease-out" })
        .child(div().text_size(17).font_semibold().child(t.subject))
        .children(t.activity.map((a, index) => activityRow(a, t, `inbox-${number}-${index}`, app.now, cx))),
    )
    .child(
      h_flex()
        .items_start()
        .gap(14)
        .child(initialsBadge(me.initials, cx, 36, true))
        .child(div().flex_1().min_w_0().child(composer(app, "inbox", app.inboxReply, [
          Button.new("inbox-end")
            .h(38)
            .px(14)
            .flex()
            .items_center()
            .rounded(10)
            .font_medium()
            .hover((h) => h.bg(colors.accent))
            .tooltip("Resolve the ticket")
            .on_click((_event, cx) => {
              app.moveTicket(number, "resolved", cx);
              app.inboxNumber = null;
            })
            .child(t.channel === "chat" ? "End Chat" : "Resolve"),
          textButton("inbox-send", "Send", "send", (cx) => app.postReply(number, "reply", app.inboxReply, cx), cx, { primary: true, h: 38 }),
        ], cx, { via: true }))),
    );
}
