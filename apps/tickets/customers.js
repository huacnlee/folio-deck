// @ts-check
// Customer accounts: a filterable table (or cards), a detail panel and a form.
import { div } from "gpui-kit";
import { h_flex, v_flex, Button, Input, Popup } from "gpui-base";
import { tone, monoFont } from "./theme.js";
import {
  icon, avatar, initialsBadge, iconButton, textButton, menuPanel, menuItem, sectionLabel, sidebarRow,
  pill, chips, labelled, field, checkbox, scrim, priorityIcon, frame, gloss, slidePanel, riseIn,
} from "./ui.js";
import {
  segments, lifecycles, healths, people, me,
  person, segmentOf, lifecycleOf, healthOf, statusOf, code, isActive, relative, initialsOf, slug, customersCsv,
} from "./data.js";

/** @typedef {import("./main.js").default} App */
/** @typedef {import("./data.js").Customer} Customer */
/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {"all" | "mine" | "risk" | "renewal" | "hightouch"} CustomerView */

export const customerViews = /** @type {const} */ ([
  { id: "all", label: "All Customers", icon: "users" },
  { id: "mine", label: "My Accounts", icon: "user" },
  { id: "risk", label: "At Risk", icon: "alert" },
  { id: "renewal", label: "Renewal", icon: "clock" },
  { id: "hightouch", label: "High Touch", icon: "heart" },
]);

const sorts = /** @type {const} */ ([
  { id: "risk", label: "Risk first" },
  { id: "tickets", label: "Most open tickets" },
  { id: "csat", label: "Lowest CSAT" },
  { id: "name", label: "Name" },
]);

/** Columns that can be hidden from the table. */
export const optionalColumns = /** @type {const} */ ([
  { id: "email", label: "Email", icon: "mail", w: 0 },
  { id: "organization", label: "Organization", icon: "building", w: 210 },
  { id: "plan", label: "Plan", icon: "layers", w: 190 },
  { id: "health", label: "Health", icon: "warning", w: 120 },
  { id: "tickets", label: "Open tickets", icon: "ticket", w: 120 },
  { id: "owner", label: "Owner", icon: "user", w: 140 },
  { id: "csat", label: "CSAT", icon: "heart", w: 80 },
]);

/** Account brand colours, picked by name. */
const brandHues = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#0ea5e9", "#3b82f6", "#8b5cf6", "#d946ef", "#ec4899"];

/** @param {string} name */
const hueOf = (name) => brandHues[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % brandHues.length];

/** A round brand mark with the account's initial. @param {string} name */
export const orgMark = (name, size = 24) =>
  div()
    .flex_shrink_0()
    .size(size)
    .flex()
    .items_center()
    .justify_center()
    .rounded_full()
    .bg(/** @type {`#${string}`} */ (hueOf(name)))
    .text_color("#ffffff")
    .text_size(size >= 32 ? 14 : 11)
    .font_bold()
    .child(name[0] ?? "?");

/** @param {string} health */
function healthColor(health, cx) {
  if (health === "at_risk") return tone.pink;
  if (health === "watch") return tone.orange;
  return tone.green;
}

/** @param {string} health */
const healthPill = (health, cx) => pill(healthOf(health).label, healthColor(health, cx), cx);

/** @param {Customer} c @param {CustomerView} view */
export function inCustomerView(c, view) {
  if (view === "mine") return c.owner === me.id;
  if (view === "risk") return c.health === "at_risk";
  if (view === "renewal") return c.lifecycle === "renewal";
  if (view === "hightouch") return c.segment === "strategic" || c.segment === "enterprise";
  return true;
}

/** @param {App} app */
export function visibleCustomers(app) {
  const q = app.custQuery;
  const list = app.customers.filter((c) =>
    inCustomerView(c, app.custView)
    && (!app.custSegment || c.segment === app.custSegment)
    && (!app.custLifecycle || c.lifecycle === app.custLifecycle)
    && (!app.custHealth || c.health === app.custHealth)
    && (!q || `${c.name} ${c.email} ${c.organization} ${person(c.owner)?.name ?? ""}`.toLowerCase().includes(q)));
  const by = app.custSort;
  return list.sort((a, b) => {
    if (by === "name") return a.name.localeCompare(b.name);
    if (by === "csat") return a.csat - b.csat;
    if (by === "tickets") return app.openTicketsOf(b).length - app.openTicketsOf(a).length;
    return healthOf(a.health).rank - healthOf(b.health).rank || app.openTicketsOf(b).length - app.openTicketsOf(a).length || a.name.localeCompare(b.name);
  });
}

/** @param {App} app */
export function customersSidebar(app, cx) {
  const colors = cx.theme().colors;
  /** @param {string} title @param {import("gpui-kit").Element[]} items */
  const section = (title, items) => v_flex().px(12).py(12).gap(2).border_b(1).border_color(colors.border)
    .child(sectionLabel(title, cx)).children(items);
  return v_flex()
    .id("customers-sidebar")
    .w(250)
    .h_full()
    .flex_shrink_0()
    .border_r(1)
    .border_color(colors.border)
    .overflow_y_scrollbar()
    .child(div().h(14).flex_shrink_0().window_control_area("drag"))
    .child(section("Views", customerViews.map((v) => sidebarRow(`customer-view-${v.id}`, v.label, icon(v.icon, 16), app.custView === v.id, (cx) => {
      app.custView = v.id;
      cx.notify();
    }, app.customers.filter((c) => inCustomerView(c, v.id)).length, cx))))
    .child(section("Segment", segments.map((s) => sidebarRow(`segment-${s.id}`, s.label, icon("building", 16), app.custSegment === s.id, (cx) => {
      app.custSegment = app.custSegment === s.id ? null : s.id;
      cx.notify();
    }, app.custSegment === s.id ? app.customers.filter((c) => c.segment === s.id).length : null, cx))))
    .child(section("Lifecycle", lifecycles.map((l) => sidebarRow(`lifecycle-${l.id}`, l.label, icon("layers", 16), app.custLifecycle === l.id, (cx) => {
      app.custLifecycle = app.custLifecycle === l.id ? null : l.id;
      cx.notify();
    }, app.custLifecycle === l.id ? app.customers.filter((c) => c.lifecycle === l.id).length : null, cx))));
}

/**
 * A toolbar button that opens a menu beneath it.
 * @param {App} app @param {string} id @param {string | null} iconName @param {string} label
 * @param {import("gpui-kit").Element[]} items
 */
function toolbarMenu(app, id, iconName, label, items, cx, width = 210) {
  const colors = cx.theme().colors;
  const open = app.menu === id;
  return Popup.new(`${id}-popup`,
    frame(Button.new(id)
      .h(38)
      .px(14)
      .flex()
      .items_center()
      .gap(8)
      .font_medium()
      .when(open, (el) => el.bg(colors.accent))
      .when(!open, (el) => el.children(gloss(36, 9, tone.glossTop, tone.glossBottom)))
      .hover((h) => h.opacity(0.85))
      .on_click((_event, cx) => app.toggleMenu(id, cx))
      .when(iconName !== null, (el) => el.child(icon(iconName ?? "", 15)))
      .child(label), 10))
    .anchor("top_right")
    .when(open, (el) => el.content(app.popIn(id, menuPanel(items, cx, width))));
}

/** @param {App} app */
export function customersPage(app, cx) {
  const colors = cx.theme().colors;
  const list = visibleCustomers(app);
  const ids = list.map((c) => c.id);
  const selectedHere = ids.filter((id) => app.custSelected.has(id));
  /** @param {string} id @param {string} label @param {() => void} apply */
  const pick = (id, label, checked, apply) => menuItem(id, label, (cx) => {
    apply();
    app.menu = null;
    cx.notify();
  }, cx, { checked });

  return v_flex()
    .id("customers-scroll")
    .flex_1()
    .min_h_0()
    .px(28)
    .pt(16)
    .pb(28)
    .gap(20)
    .overflow_y_scrollbar()
    .child(
      h_flex()
        .items_center()
        .gap(10)
        .child(div().flex_1().text_size(31).font_bold().child("Customers"))
        .child(textButton("customers-export", "Export", "download", (cx) => {
          cx.write_to_clipboard(customersCsv(list, (c) => app.openTicketsOf(c).length));
          app.toast(`Copied ${list.length} customers as CSV`, cx);
          cx.notify();
        }, cx, { h: 34 }).tooltip("Copy the shown customers as CSV"))
        .child(textButton("new-customer", "New Customer", "plus", (cx) => app.openCustomerDraft(cx), cx, { primary: true, h: 34 }))
        .child(Popup.new("customers-more-popup",
          iconButton("customers-more", "chevron-down", "More", (cx) => app.toggleMenu("customers-more", cx), cx, { size: 38, round: true, active: app.menu === "customers-more" }))
          .anchor("top_right")
          .when(app.menu === "customers-more", (el) => el.content(app.popIn("customers-more", menuPanel([
            menuItem("customers-copy-emails", "Copy shown emails", (cx) => {
              cx.write_to_clipboard(list.map((c) => c.email).join(", "));
              app.menu = null;
              app.toast(`Copied ${list.length} emails`, cx);
              cx.notify();
            }, cx, { lead: icon("copy", 14) }),
            menuItem("customers-select-all", "Select all shown", (cx) => {
              for (const id of ids) app.custSelected.add(id);
              app.menu = null;
              cx.notify();
            }, cx, { lead: icon("check", 14) }),
            menuItem("customers-reset", "Reset demo data", (cx) => app.resetDemo(cx), cx, { lead: icon("rotate", 14), danger: true }),
          ], cx, 210))))),
    )
    .child(
      h_flex()
        .items_center()
        .gap(10)
        .child(
          frame(h_flex()
            .flex_1()
            .min_w(220)
            .max_w(560)
            .mr_auto()
            .h(38)
            .px(13)
            .items_center()
            .gap(10)
            .bg(tone.well)
            .text_color(colors.muted_foreground), 10)
            .child(icon("search", 16))
            .child(Input.new(app.custSearch).flex_1().min_w_0().text_size(14).text_color(colors.foreground)),
        )
        .child(toolbarMenu(app, "customers-sort", "sort", sorts.find((s) => s.id === app.custSort)?.label ?? "", [
          sectionLabel("Sort by", cx),
          ...sorts.map((s) => pick(`customers-sort-${s.id}`, s.label, app.custSort === s.id, () => { app.custSort = s.id; })),
        ], cx))
        .child(toolbarMenu(app, "customers-lifecycle", null, app.custLifecycle ? lifecycleOf(app.custLifecycle).label : "All lifecycles", [
          pick("customers-lifecycle-all", "All lifecycles", app.custLifecycle === null, () => { app.custLifecycle = null; }),
          div().h(1).my(3).bg(colors.border),
          ...lifecycles.map((l) => pick(`customers-lifecycle-${l.id}`, l.label, app.custLifecycle === l.id, () => { app.custLifecycle = l.id; })),
        ], cx))
        .child(toolbarMenu(app, "customers-columns", "sliders", "Table options", [
          sectionLabel("Columns", cx),
          ...optionalColumns.map((col) => menuItem(`customers-column-${col.id}`, col.label, (cx) => {
            if (app.custColumns.has(col.id)) app.custColumns.delete(col.id);
            else app.custColumns.add(col.id);
            app.save();
            cx.notify();
          }, cx, { checked: app.custColumns.has(col.id), lead: icon(col.icon, 14) })),
        ], cx))
        .child(toolbarMenu(app, "customers-health", "heart", app.custHealth ? healthOf(app.custHealth).label : "All health", [
          pick("customers-health-all", "All health", app.custHealth === null, () => { app.custHealth = null; }),
          div().h(1).my(3).bg(colors.border),
          ...healths.map((h) => pick(`customers-health-${h.id}`, h.label, app.custHealth === h.id, () => { app.custHealth = h.id; })),
        ], cx))
        .child(
          frame(h_flex()
            .h(38)
            .p(3)
            .gap(2)
            .bg(tone.raise), 10)
            .child(iconButton("customers-layout-grid", "grid", "Cards", (cx) => {
              app.custLayout = "grid";
              app.save();
              cx.notify();
            }, cx, { size: 30, active: app.custLayout === "grid" }))
            .child(iconButton("customers-layout-table", "table", "Table", (cx) => {
              app.custLayout = "table";
              app.save();
              cx.notify();
            }, cx, { size: 30, active: app.custLayout === "table" })),
        ),
    )
    .when(selectedHere.length > 0, (el) => el.child(bulkBar(app, selectedHere, cx)))
    .child(app.custLayout === "table" ? table(app, list, cx) : cards(app, list, cx));
}

/** Actions for the checked rows. @param {App} app @param {string[]} ids */
function bulkBar(app, ids, cx) {
  const colors = cx.theme().colors;
  /** @param {string} label @param {(c: Customer) => void} apply @param {string} done */
  const action = (id, label, apply, done) => textButton(id, label, null, (cx) => {
    for (const c of app.customers) if (ids.includes(c.id)) apply(c);
    app.custSelected.clear();
    app.save();
    app.toast(done, cx);
    cx.notify();
  }, cx, { h: 30 });
  return h_flex()
    .h(46)
    .px(14)
    .gap(8)
    .items_center()
    .rounded(12)
    .bg(`${colors.primary}14`)
    .border(1)
    .border_color(`${colors.primary}40`)
    .child(div().flex_1().font_medium().child(`${ids.length} selected`))
    .child(action("bulk-risk", "Mark at risk", (c) => { c.health = "at_risk"; }, `${ids.length} marked at risk`))
    .child(action("bulk-healthy", "Mark healthy", (c) => { c.health = "healthy"; }, `${ids.length} marked healthy`))
    .child(action("bulk-mine", "Assign to me", (c) => { c.owner = me.id; }, `${ids.length} assigned to you`))
    .child(action("bulk-archive", "Archive", (c) => { c.lifecycle = "archived"; }, `${ids.length} archived`))
    .child(iconButton("bulk-clear", "close", "Clear selection", (cx) => {
      app.custSelected.clear();
      cx.notify();
    }, cx));
}

/** @param {App} app @param {Customer[]} list */
function table(app, list, cx) {
  const colors = cx.theme().colors;
  const shown = optionalColumns.filter((col) => app.custColumns.has(col.id));
  const allChecked = list.length > 0 && list.every((c) => app.custSelected.has(c.id));
  const someChecked = list.some((c) => app.custSelected.has(c.id));
  const tickets = list.reduce((sum, c) => sum + app.openTicketsOf(c).length, 0);
  const csat = list.length ? list.reduce((sum, c) => sum + c.csat, 0) / list.length : 0;
  /** @param {{ w: number }} col @param {import("gpui-kit").NativeElement} el */
  const sized = (col, el) => col.w ? el.w(col.w).flex_shrink_0() : el.flex_1().min_w(160);
  /** @param {Customer} c @param {string} id */
  const cell = (c, id) => {
    const owner = person(c.owner);
    if (id === "email") return div().truncate().child(c.email);
    if (id === "organization") return h_flex().gap(10).items_center().child(orgMark(c.organization)).child(div().truncate().child(c.organization));
    if (id === "plan") return div().truncate().child(`${c.tier} · ${segmentOf(c.segment).label}`);
    if (id === "health") return h_flex().child(healthPill(c.health, cx));
    if (id === "tickets") return div().child(String(app.openTicketsOf(c).length));
    if (id === "owner") return h_flex().gap(8).items_center().child(avatar(c.owner, cx, 22)).child(div().truncate().child(owner?.name.split(" ")[0] ?? "—"));
    return div().child(c.csat.toFixed(1));
  };
  /** @param {import("gpui-kit").NativeElement} el */
  const divided = (el) => el.h_full().px(12).flex().items_center().border_l(1).border_color(colors.border);
  return frame(v_flex()
    .bg(tone.raise)
    .overflow_hidden(), 14)
    .child(
      h_flex()
        .h(48)
        .items_center()
        .border_b(1)
        .border_color(colors.border)
        .text_color(colors.muted_foreground)
        .child(div().w(48).h_full().flex_shrink_0().flex().items_center().justify_center()
          .child(checkbox("customers-check-all", allChecked ? true : someChecked ? "mixed" : false, (cx) => {
            for (const c of list) {
              if (allChecked) app.custSelected.delete(c.id);
              else app.custSelected.add(c.id);
            }
            cx.notify();
          }, cx)))
        .child(divided(h_flex().flex_1().min_w(180).gap(8)).child(icon("user", 14)).child("Name"))
        .children(shown.map((col) => sized(col, divided(h_flex().gap(8)).child(icon(col.icon, 14)).child(div().truncate().child(col.label))))),
    )
    .children(list.map((c) => {
      const checked = app.custSelected.has(c.id);
      return h_flex()
        .id(`customer-row-${c.id}`)
        .h(56)
        .items_center()
        .border_b(1)
        .border_color(colors.border)
        .bg(checked || app.custOpen === c.id ? colors.accent : tone.well)
        .cursor_pointer()
        .hover((h) => h.bg(colors.accent))
        .on_click((_event, cx) => app.openCustomer(c.id, cx))
        .child(div().w(48).flex_shrink_0().flex().justify_center().child(checkbox(`customer-check-${c.id}`, checked, (cx) => {
          if (checked) app.custSelected.delete(c.id);
          else app.custSelected.add(c.id);
          cx.notify();
        }, cx)))
        .child(h_flex().flex_1().min_w(180).px(12).gap(10).items_center()
          .child(initialsBadge(initialsOf(c.name), cx, 30, c.owner === me.id))
          .child(div().truncate().font_medium().child(c.name))
          .when(c.lifecycle === "archived", (el) => el.child(div().text_size(12).text_color(colors.muted_foreground).child("archived"))))
        .children(shown.map((col) => sized(col, div().px(12).min_w_0()).child(cell(c, col.id))));
    }))
    .when(list.length === 0, (el) => el.child(
      div().h(120).flex().items_center().justify_center().bg(colors.background).text_color(colors.muted_foreground).child("No customers match these filters."),
    ))
    .child(
      h_flex()
        .h(44)
        .px(16)
        .gap(24)
        .items_center()
        .text_size(13)
        .text_color(colors.muted_foreground)
        .child(div().flex_1().child(`${list.length} accounts`))
        .child(`${csat.toFixed(1)} avg CSAT`)
        .child(`${tickets} open tickets`),
    );
}

/** @param {App} app @param {Customer[]} list */
function cards(app, list, cx) {
  const colors = cx.theme().colors;
  return h_flex()
    .flex_wrap()
    .gap(14)
    .children(list.map((c) => {
      const open = app.openTicketsOf(c).length;
      return frame(Button.new(`customer-card-${c.id}`)
        .w(290)
        .p(16)
        .flex()
        .flex_col()
        .gap(14)
        .bg(tone.raise)
        .hover((h) => h.border_color(colors.ring)), 14, app.custSelected.has(c.id) ? { ring: colors.primary } : {})
        .on_click((_event, cx) => app.openCustomer(c.id, cx))
        .child(h_flex().w_full().gap(10).items_center()
          .child(orgMark(c.organization, 34))
          .child(v_flex().flex_1().min_w_0().items_start()
            .child(div().truncate().font_semibold().child(c.organization))
            .child(div().truncate().text_size(13).text_color(colors.muted_foreground).child(`${c.tier} · ${segmentOf(c.segment).label}`)))
          .child(healthPill(c.health, cx)))
        .child(h_flex().w_full().gap(10).items_center()
          .child(initialsBadge(initialsOf(c.name), cx, 26, c.owner === me.id))
          .child(v_flex().flex_1().min_w_0().items_start()
            .child(div().truncate().text_size(13).font_medium().child(c.name))
            .child(div().truncate().text_size(12).text_color(colors.muted_foreground).child(c.email))))
        .child(h_flex().w_full().pt(12).border_t(1).border_color(colors.border).text_size(12).text_color(colors.muted_foreground)
          .child(div().flex_1().text_left().child(`${open} open ${open === 1 ? "ticket" : "tickets"}`))
          .child(div().child(`CSAT ${c.csat.toFixed(1)} · ${lifecycleOf(c.lifecycle).label}`)));
    }))
    .when(list.length === 0, (el) => el.child(div().py(40).w_full().text_center().text_color(colors.muted_foreground).child("No customers match these filters.")));
}

/** The account panel. @param {App} app */
export function customerSheet(app, cx) {
  const colors = cx.theme().colors;
  const c = app.customers.find((x) => x.id === app.custOpen);
  if (!c) return div();
  const tickets = app.tickets.filter((t) => t.customer === c.organization).sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.createdAt - a.createdAt);
  /** @param {Partial<Customer>} patch @param {string} done */
  const change = (patch, done, /** @type {Context} */ cx) => {
    Object.assign(c, patch);
    app.save();
    app.toast(done, cx);
    cx.notify();
  };
  /** @param {string} label @param {string} value */
  const stat = (label, value) => v_flex().flex_1().gap(2).p(12).rounded(10).bg(colors.secondary).border(1).border_color(colors.border)
    .child(div().text_size(12).font_family(monoFont).text_color(colors.muted_foreground).child(label))
    .child(div().text_size(20).font_semibold().child(value));
  const shown = app.shown("customer");
  return div()
    .id("customer-sheet")
    .absolute()
    .inset_0()
    .child(scrim("customer-sheet", shown, (cx) => app.closeCustomer(cx)))
    .child(
      frame(slidePanel("customer-panel", shown, 520).bg(colors.background), 18)
        .child(h_flex().h(72).px(18).flex_shrink_0().gap(12).items_center().border_b(1).border_color(colors.border)
          .child(orgMark(c.organization, 38))
          .child(v_flex().flex_1().min_w_0()
            .child(div().truncate().text_size(18).font_semibold().child(c.organization))
            .child(div().truncate().text_size(13).text_color(colors.muted_foreground).child(`${c.name} · ${c.email}`)))
          .child(iconButton("customer-copy-email", "copy", "Copy email", (cx) => {
            cx.write_to_clipboard(c.email);
            app.toast(`Copied ${c.email}`, cx);
            cx.notify();
          }, cx))
          .child(iconButton("close-customer", "close", "Close (Esc)", (cx) => app.closeCustomer(cx), cx)))
        .child(
          v_flex()
            .id("customer-scroll")
            .flex_1()
            .min_h_0()
            .p(20)
            .gap(20)
            .overflow_y_scrollbar()
            .child(h_flex().gap(10)
              .child(stat("PLAN", c.tier))
              .child(stat("CSAT", c.csat.toFixed(1)))
              .child(stat("OPEN TICKETS", String(app.openTicketsOf(c).length))))
            .child(labelled("Health", chips("customer-health", healths, c.health, (h, cx) => change({ health: h }, `Health set to ${healthOf(h).label}`, cx), cx,
              (h) => div().size(7).rounded_full().bg(healthColor(h, cx))), cx))
            .child(labelled("Lifecycle", chips("customer-lifecycle", lifecycles, c.lifecycle, (l, cx) => change({ lifecycle: l }, `Moved to ${lifecycleOf(l).label}`, cx), cx), cx))
            .child(labelled("Segment", chips("customer-segment", segments, c.segment, (s, cx) => change({ segment: s }, `Segment set to ${segmentOf(s).label}`, cx), cx), cx))
            .child(labelled("Owner", chips("customer-owner", [...people.map((p) => ({ id: p.id, label: p.name })), { id: "none", label: "Nobody" }], c.owner ?? "none",
              (id, cx) => change({ owner: id === "none" ? null : id }, id === "none" ? "Owner removed" : `Owner set to ${person(id)?.name}`, cx), cx,
              (id) => avatar(id === "none" ? null : id, cx, 16)), cx))
            .child(labelled(`Tickets (${tickets.length})`, v_flex().gap(6)
              .children(tickets.map((t) => Button.new(`customer-ticket-${t.number}`)
                .h(44)
                .px(12)
                .flex()
                .items_center()
                .gap(10)
                .rounded(10)
                .border(1)
                .border_color(colors.border)
                .bg(colors.surface)
                .hover((h) => h.border_color(colors.ring))
                .on_click((_event, cx) => {
                  app.custOpen = null;
                  app.openTicket(t.number, cx);
                })
                .child(priorityIcon(t.priority, cx, 14))
                .child(div().w(46).flex_shrink_0().font_family(monoFont).text_size(12).text_color(colors.muted_foreground).child(code(t.number)))
                .child(div().flex_1().min_w_0().truncate().child(t.subject))
                .child(div().text_size(12).text_color(colors.muted_foreground).child(statusOf(t.status).label))))
              .when(tickets.length === 0, (el) => el.child(div().text_size(13).text_color(colors.muted_foreground).child("No tickets from this account yet."))), cx))
            .child(textButton("customer-new-ticket", "New ticket for this account", "plus", (cx) => {
              app.custOpen = null;
              app.openDraft("open", cx);
              app.customerInput.set_value(c.organization);
              app.contactInput.set_value(c.name);
            }, cx)),
        ),
    );
}

/** The new-customer form. @param {App} app */
export function customerDialog(app, cx) {
  const colors = cx.theme().colors;
  const draft = app.custDraft;
  if (!draft) return div();
  const shown = app.shown("dialog");
  const close = (/** @type {Context} */ cx) => app.conceal("dialog", cx, () => { app.custDraft = null; }, 180);
  return div()
    .id("customer-dialog")
    .absolute()
    .inset_0()
    .flex()
    .items_center()
    .justify_center()
    .child(scrim("customer-dialog", shown, close))
    .child(riseIn("customer-dialog", shown,
      frame(v_flex()
        .id("customer-dialog-panel")
        .w(540)
        .bg(colors.background)
        .shadow_xl(), 16)
        .child(h_flex().h(56).px(20).items_center().border_b(1).border_color(colors.border)
          .child(div().flex_1().text_size(16).font_semibold().child("New customer"))
          .child(iconButton("close-customer-dialog", "close", "Close (Esc)", close, cx)))
        .child(v_flex().p(20).gap(16)
          .child(h_flex().gap(12)
            .child(div().flex_1().child(labelled("Contact name", field(app.custNameInput, cx), cx)))
            .child(div().flex_1().child(labelled("Organization", field(app.custOrgInput, cx), cx))))
          .child(labelled("Email", field(app.custEmailInput, cx), cx))
          .child(labelled("Segment", chips("customer-draft-segment", segments, draft.segment, (v, cx) => { draft.segment = v; cx.notify(); }, cx), cx))
          .child(labelled("Lifecycle", chips("customer-draft-lifecycle", lifecycles.filter((l) => l.id !== "archived"), draft.lifecycle, (v, cx) => { draft.lifecycle = v; cx.notify(); }, cx), cx)))
        .child(h_flex().px(20).py(14).gap(8).items_center().border_t(1).border_color(colors.border)
          .child(div().flex_1().text_size(13).text_color(draft.error ? colors.destructive : colors.muted_foreground)
            .child(draft.error ?? "You will own the new account."))
          .child(textButton("cancel-customer", "Cancel", null, close, cx))
          .child(textButton("create-customer", "Create customer", "plus", (cx) => createCustomer(app, cx), cx, { primary: true })))),
    );
}

/** @param {App} app */
function createCustomer(app, cx) {
  const draft = app.custDraft;
  if (!draft) return;
  const name = app.custNameInput.value().trim();
  const organization = app.custOrgInput.value().trim();
  const email = app.custEmailInput.value().trim();
  draft.error = !name ? "Name the contact." : !organization ? "Name the organization."
    : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "Enter a valid email address."
    : app.customers.some((c) => c.id === slug(organization)) ? `${organization} is already a customer.` : null;
  if (draft.error) {
    cx.notify();
    return;
  }
  const tier = draft.segment === "strategic" || draft.segment === "enterprise" ? "Enterprise" : draft.segment === "smb" ? "Starter" : "Growth";
  app.customers = [...app.customers, {
    id: slug(organization), name, email, organization, tier,
    segment: draft.segment, lifecycle: draft.lifecycle, health: "healthy", owner: me.id, csat: 5,
  }];
  app.conceal("dialog", cx, () => { app.custDraft = null; }, 180);
  app.save();
  app.toast(`${organization} added`, cx);
  cx.notify();
}
