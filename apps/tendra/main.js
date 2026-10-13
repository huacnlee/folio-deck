// @ts-check
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState } from "gpui-base";
import { applyTheme, palette } from "./theme.js";
import { icon, mono, tag, avatar, avatarStack, meter, progressBar, muted } from "./ui.js";
import {
  me, stages, activeStages, seedBids, columnLimit,
  money, total, stageNote, easternTime,
} from "./data.js";

const storageKey = "tendra.bids.v3";

/** @typedef {import("./data.js").Bid} Bid */
/** @typedef {import("./data.js").StageId} StageId */

const nav = {
  workspace: [
    { id: "today", label: "Today", icon: "today" },
    { id: "opportunities", label: "Opportunities", icon: "radar", badge: "3 NEW" },
    { id: "bids", label: "Bids", icon: "bids" },
    { id: "compliance", label: "Compliance", icon: "compliance" },
    { id: "library", label: "Answer library", icon: "library" },
    { id: "partners", label: "Partners", icon: "partners" },
  ],
  insights: [
    { id: "winloss", label: "Win and loss", icon: "chart" },
    { id: "settings", label: "Settings", icon: "settings" },
    { id: "help", label: "Help", icon: "help" },
  ],
};

export default class Tendra extends View {
  init(_props, cx) {
    applyTheme();
    /** @type {Bid[]} */
    this.bids = this.load();
    this.page = "bids";
    this.scope = "team";
    this.layout = "board";
    this.sidebarOpen = true;
    /** @type {Set<StageId>} */
    this.expanded = new Set();
    /** The card being dragged, and the column under the pointer. */
    this.dragId = /** @type {string | null} */ (null);
    this.dropStage = /** @type {StageId | null} */ (null);
    this.query = "";
    /** The bid shown in the detail drawer. */
    this.openId = /** @type {string | null} */ (null);
    /** The transient message in the corner, and a counter that retires it. */
    this.notice = /** @type {{ title: string, body: string } | null} */ (null);
    this.noticeRevision = 0;
    this.now = new Date();
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value().trim().toLowerCase();
      cx.notify();
    });
    cx.timer.every(15_000, (cx) => {
      this.now = new Date();
      cx.notify();
    });
  }

  /** @returns {Bid[]} */
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (Array.isArray(saved) && saved.length) return saved;
    } catch {}
    return seedBids.map((bid) => ({ ...bid }));
  }

  save() {
    localStorage.setItem(storageKey, JSON.stringify(this.bids));
  }

  /** Bids after the Team/Mine scope and the search box. */
  visibleBids() {
    return this.bids.filter((bid) => {
      if (this.scope === "mine" && !bid.owners.includes(me.initials)) return false;
      if (!this.query) return true;
      return `${bid.agency} ${bid.project} ${bid.kind} ${bid.number} ${bid.tag}`.toLowerCase().includes(this.query);
    });
  }

  /** @param {string} id @param {StageId} stage */
  moveBid(id, stage, cx) {
    const bid = this.bids.find((b) => b.id === id);
    if (!bid || bid.stage === stage) return;
    bid.stage = stage;
    // A card dropped on the end of a column joins it last.
    this.bids = [...this.bids.filter((b) => b.id !== id), bid];
    this.save();
    const label = stages.find((s) => s.id === stage)?.label ?? stage;
    this.toast(`Moved to ${label}`, bid.agency, cx);
    cx.notify();
  }

  addBid(cx) {
    const count = this.bids.filter((b) => b.id.startsWith("new-")).length + 1;
    /** @type {Bid} */
    const bid = {
      id: `new-${Date.now()}`, stage: "gonogo", tag: "NEW", tone: "blue", due: "30 days",
      agency: `New opportunity ${count}`, kind: "RFP", number: "—", project: "Scope to be confirmed",
      status: "Not started", owners: [me.initials], value: 500_000,
    };
    this.bids = [...this.bids, bid];
    this.page = "bids";
    this.save();
    this.openBid(bid.id);
    cx.notify();
  }

  /** Shows a short message for a few seconds. @param {string} title @param {string} body */
  toast(title, body, cx) {
    this.notice = { title, body };
    const revision = ++this.noticeRevision;
    cx.timer.after(2600, (cx) => {
      if (revision !== this.noticeRevision) return;
      this.notice = null;
      cx.notify();
    });
  }

  resetDemo(cx) {
    this.bids = seedBids.map((bid) => ({ ...bid }));
    this.expanded.clear();
    this.save();
    this.toast("Demo data restored", "Every bid is back where it started.", cx);
    cx.notify();
  }

  // ---------------------------------------------------------------- sidebar

  sidebar(cx) {
    const colors = cx.theme().colors;
    const bidCount = this.bids.filter((b) => activeStages.includes(b.stage)).length;
    return v_flex()
      .w(236)
      .h_full()
      .flex_shrink_0()
      .px(11)
      .pb(11)
      .gap(11)
      .child(div().flex_shrink_0().h(24).window_control_area("drag"))
      .child(
        h_flex()
          .h(36)
          .items_center()
          .justify_between()
          .px(3)
          .child(
            h_flex()
              .flex_1()
              .self_stretch()
              .items_center()
              .gap(8)
              .window_control_area("drag")
              .child(
                div()
                  .relative()
                  .size(28)
                  .rounded(7)
                  .bg(colors.primary)
                  .flex()
                  .items_center()
                  .justify_center()
                  .text_color(colors.primary_foreground)
                  .text_size(16)
                  .font_bold()
                  .child("T")
                  .child(icon("check", 9).absolute().right(4).bottom(5).text_color(palette.alert)),
              )
              .child(div().text_size(15).font_semibold().child("Tendra")),
          )
          .child(this.iconButton("collapse", "sidebar", (cx) => {
            this.sidebarOpen = false;
            cx.notify();
          }, cx)),
      )
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .p(8)
          .rounded(10)
          .bg(colors.surface)
          .border(1)
          .border_color(colors.border)
          .shadow_xs()
          .child(
            div()
              .size(33)
              .rounded(7)
              .bg("#2a2f3a")
              .flex()
              .items_center()
              .justify_center()
              .text_color(colors.primary_foreground)
              .text_size(9)
              .font_semibold()
              .child("H&P"),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .child(div().text_size(13).font_medium().truncate().child("Harbor & Pike Civil"))
              .child(muted("Capture team", cx, 12)),
          )
          .child(icon("chevrons-up-down", 13).text_color(colors.muted_foreground)),
      )
      .child(
        h_flex()
          .h(33)
          .items_center()
          .gap(7)
          .px(10)
          .rounded(10)
          .bg(colors.secondary)
          .border(1)
          .border_color(colors.border)
          .text_color(colors.muted_foreground)
          .child(icon("search", 13))
          .child(Input.new(this.search).flex_1().min_w_0().text_size(11).text_color(colors.foreground))
          .child(
            div()
              .px(4)
              .py(1)
              .rounded(4)
              .border(1)
              .border_color(colors.border)
              .bg(colors.surface)
              .text_size(8)
              .child("⌘K"),
          ),
      )
      .child(this.navSection("WORKSPACE", nav.workspace, bidCount, cx).mt(11))
      .child(this.navSection("INSIGHTS", nav.insights, bidCount, cx).mt(7))
      .child(div().flex_1())
      .child(
        v_flex()
          .gap(5)
          .p(11)
          .rounded(10)
          .bg(colors.surface)
          .border(1)
          .border_color(colors.border)
          .child(
            h_flex()
              .items_center()
              .gap(7)
              .child(div().size(7).rounded_full().bg(palette.live))
              .child(div().text_size(11).font_medium().child("Watching 15 portals")),
          )
          .child(muted("SAM.gov and 14 state and city portals · checked 6 min ago", cx, 10).line_height(1.45)),
      )
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .px(3)
          .child(avatar(me.initials, cx, 33))
          .child(
            v_flex()
              .flex_1()
              .child(div().text_size(13).font_medium().child(me.name))
              .child(muted(me.role, cx, 12)),
          )
          .child(this.iconButton("reset-demo", "history", (cx) => this.resetDemo(cx), cx).tooltip("Reset demo data")),
      );
  }

  /** @param {string} title @param {typeof nav.workspace} items @param {number} bidCount */
  navSection(title, items, bidCount, cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .gap(2)
      .child(mono(title).px(11).pb(7).text_size(9).text_color(colors.muted_foreground))
      .children(items.map((item) => {
        const selected = this.page === item.id;
        return Button.new(`nav-${item.id}`)
          .h(38)
          .px(11)
          .gap(10)
          .flex()
          .items_center()
          .rounded(10)
          .text_size(12)
          .border(1)
          .border_color(selected ? colors.border : "#00000000")
          .when(selected, (el) => el.bg(colors.surface).shadow_xs().font_medium())
          .when(!selected, (el) => el.hover((h) => h.bg(colors.accent)))
          .selected(selected)
          .on_click((_event, cx) => {
            this.page = item.id;
            cx.notify();
          })
          .child(icon(item.icon, 16).text_color(selected ? colors.foreground : colors.secondary_foreground))
          .child(div().flex_1().child(item.label))
          .when(item.badge, (el) => el.child(tag(item.badge ?? "", "red")))
          .when(item.id === "bids", (el) => el.child(muted(String(bidCount), cx, 12)));
      }));
  }

  /** @param {string} id @param {string} name @param {(cx: any) => void} onClick */
  iconButton(id, name, onClick, cx) {
    const colors = cx.theme().colors;
    return Button.new(id)
      .size(28)
      .flex()
      .items_center()
      .justify_center()
      .rounded(7)
      .border(1)
      .border_color(colors.border)
      .bg(colors.surface)
      .text_color(colors.secondary_foreground)
      .hover((h) => h.bg(colors.accent))
      .on_click((_event, cx) => onClick(cx))
      .child(icon(name, 14));
  }

  // ------------------------------------------------------------------ header

  header(bids, cx) {
    const colors = cx.theme().colors;
    const active = bids.filter((b) => activeStages.includes(b.stage));
    const stuck = bids.filter((b) => b.stuck).length;
    return v_flex()
      .gap(21)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .when(!this.sidebarOpen, (el) => el.child(this.iconButton("expand", "sidebar", (cx) => {
            this.sidebarOpen = true;
            cx.notify();
          }, cx).mr(5)))
          .child(icon("bids", 15).text_color(colors.muted_foreground))
          .child(div().text_size(12).child("Bids"))
          .child(icon("chevron-right", 11).text_color(colors.muted_foreground))
          .child(muted(this.layout === "board" ? "Pipeline" : "List", cx, 12))
          .child(div().flex_1().self_stretch().window_control_area("drag"))
          .child(muted(easternTime(this.now), cx, 11))
          .child(
            Button.new("notifications")
              .relative()
              .size(34)
              .ml(7)
              .flex()
              .items_center()
              .justify_center()
              .rounded_full()
              .border(1)
              .border_color(colors.border)
              .bg(colors.surface)
              .hover((h) => h.bg(colors.accent))
              .on_click((_event, cx) => {
                this.toast(`${stuck} bids are stuck`, "Bond issues on Kingsport and TVA need you today.", cx);
                cx.notify();
              })
              .child(icon("bell", 15))
              .child(div().absolute().top(7).right(8).size(7).rounded_full().bg(palette.alert).border(1).border_color(colors.surface)),
          ),
      )
      .child(
        h_flex()
          .items_end()
          .gap(13)
          .child(
            v_flex()
              .flex_1()
              .gap(8)
              .child(div().text_size(31).font_semibold().line_height(1.1).child("Bid pipeline"))
              .child(
                h_flex()
                  .text_size(14)
                  .child(`${active.length} active bids worth ${money(total(active))}.`)
                  .when(stuck > 0, (el) => el.child(div().ml(4).font_semibold().child(`${stuck} ${stuck === 1 ? "is" : "are"} stuck and need you today.`))),
              ),
          )
          .child(this.segmented("scope", [["team", "Team"], ["mine", "Mine"]], this.scope, (value) => { this.scope = value; }, cx))
          .child(this.segmented("layout", [["board", icon("board", 14)], ["list", icon("rows", 14)]], this.layout, (value) => { this.layout = value; }, cx))
          .child(
            Button.new("add-bid")
              .h(39)
              .px(16)
              .gap(8)
              .flex()
              .items_center()
              .rounded(10)
              .bg(colors.primary)
              .text_color(colors.primary_foreground)
              .text_size(12)
              .font_medium()
              .shadow_sm()
              .hover((h) => h.bg("#2e2e33"))
              .on_click((_event, cx) => this.addBid(cx))
              .child(icon("plus", 14))
              .child("Add a bid"),
          ),
      );
  }

  /**
   * A pill of mutually exclusive options.
   * @param {string} id @param {[string, any][]} options @param {string} value
   * @param {(value: string) => void} onChange
   */
  segmented(id, options, value, onChange, cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .h(39)
      .p(3)
      .gap(2)
      .rounded(10)
      .bg(colors.muted)
      .border(1)
      .border_color(colors.border)
      .children(options.map(([key, label]) => {
        const on = key === value;
        return Button.new(`${id}-${key}`)
          .h_full()
          .px(typeof label === "string" ? 16 : 10)
          .flex()
          .items_center()
          .justify_center()
          .rounded(7)
          .text_size(12)
          .text_color(on ? colors.foreground : colors.muted_foreground)
          .when(on, (el) => el.bg(colors.surface).border(1).border_color(colors.border).shadow_xs())
          .when(!on, (el) => el.hover((h) => h.text_color(colors.foreground)))
          .selected(on)
          .on_click((_event, cx) => {
            onChange(key);
            cx.notify();
          })
          .child(label);
      }));
  }

  // ---------------------------------------------------------------- summary

  summary(bids, cx) {
    const colors = cx.theme().colors;
    const max = Math.max(1, ...stages.map((stage) => total(bids.filter((b) => b.stage === stage.id))));
    return h_flex().gap(10).children(stages.map((stage) => {
      const inStage = bids.filter((b) => b.stage === stage.id);
      const value = total(inStage);
      const color = palette.stage[stage.id];
      return div()
        .flex_1()
        .min_w_0()
        .p(4)
        .rounded(16)
        .bg(colors.secondary)
        .border(1)
        .border_color(colors.border)
        .child(
          v_flex()
            .gap(11)
            .px(15)
            .pt(15)
            .pb(13)
            .rounded(13)
            .bg(colors.surface)
            .border(1)
            .border_color(colors.border)
            .child(
              h_flex()
                .justify_between()
                .child(mono(stage.summary).text_size(10).text_color(colors.muted_foreground))
                .child(muted(`${inStage.length} ${inStage.length === 1 ? "bid" : "bids"}`, cx, 11)),
            )
            .child(
              div()
                .text_size(30)
                .line_height(1.1)
                .text_color(stage.id === "gonogo" ? colors.secondary_foreground : color)
                .child(money(value)),
            )
            .child(meter(Math.round((value / max) * 32), color))
            .child(muted(stageNote(stage.id, inStage), cx, 11).truncate()),
        );
    }));
  }

  // ------------------------------------------------------------------ board

  board(bids, cx) {
    return h_flex()
      .items_start()
      .gap(10)
      .children(stages.map((stage) => this.column(stage, bids.filter((b) => b.stage === stage.id), cx)));
  }

  /** @param {typeof stages[number]} stage @param {Bid[]} bids */
  column(stage, bids, cx) {
    const colors = cx.theme().colors;
    const color = palette.stage[stage.id];
    const dragging = this.dragId !== null;
    const target = dragging && this.dropStage === stage.id
      && this.bids.find((b) => b.id === this.dragId)?.stage !== stage.id;
    const expanded = this.expanded.has(stage.id);
    const shown = expanded ? bids : bids.slice(0, columnLimit);
    const hidden = bids.length - shown.length;

    return v_flex()
      .id(`column-${stage.id}`)
      .flex_1()
      .min_w_0()
      .p(6)
      .gap(7)
      .rounded(16)
      .bg(target ? palette.tone.neutral.bg : colors.secondary)
      .border(target ? 2 : 1)
      .border_color(target ? color : colors.border)
      .on_hover((hovered, cx) => {
        if (!this.dragId) return;
        if (hovered) this.dropStage = stage.id;
        else if (this.dropStage === stage.id) this.dropStage = null;
        cx.notify();
      })
      .on_mouse_up("left", (_event, cx) => {
        if (this.dragId) this.moveBid(this.dragId, stage.id, cx);
      })
      .child(
        h_flex()
          .h(33)
          .px(11)
          .items_center()
          .gap(8)
          .child(div().size(7).rounded_full().bg(color))
          .child(div().text_size(14).font_medium().child(stage.label))
          .child(
            div()
              .px(7)
              .rounded_full()
              .border(1)
              .border_color(colors.border)
              .bg(colors.surface)
              .text_size(11)
              .text_color(colors.muted_foreground)
              .child(String(bids.length)),
          )
          .child(div().flex_1())
          .child(
            Button.new(`menu-${stage.id}`)
              .size(21)
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .text_color(colors.muted_foreground)
              .hover((h) => h.bg(colors.accent))
              .on_click((_event, cx) => {
                if (expanded) this.expanded.delete(stage.id);
                else this.expanded.add(stage.id);
                cx.notify();
              })
              .tooltip(expanded ? "Collapse column" : "Show every bid")
              .child(icon("more", 15)),
          ),
      )
      .children(shown.map((bid) => this.card(bid, cx)))
      .when(stage.id === "gonogo", (el) => el.child(this.promo("matches", "radar", "3 new matches", "Sevier County fits 92", "Review matches", "opportunities", cx)))
      .when(stage.id === "awarded", (el) => el.child(this.promo("winrate", "trophy", "35% win rate", "9 of 26 decided this year", "See win and loss", "winloss", cx)))
      .child(
        hidden > 0
          ? Button.new(`more-${stage.id}`)
            .h(43)
            .flex()
            .items_center()
            .justify_center()
            .rounded(11)
            .bg(colors.surface)
            .border(1)
            .border_color(colors.border)
            .text_size(12)
            .hover((h) => h.bg(colors.accent))
            .on_click((_event, cx) => {
              this.expanded.add(stage.id);
              cx.notify();
            })
            .child(`${hidden} more`)
          : div()
            .h(43)
            .flex()
            .items_center()
            .justify_center()
            .rounded(11)
            .border(1)
            .border_dashed()
            .border_color(target ? color : colors.border)
            .text_size(12)
            .text_color(colors.muted_foreground)
            .child(target ? "Drop to move here" : "Drag a bid here"),
      );
  }

  /** @param {Bid} bid */
  card(bid, cx) {
    const colors = cx.theme().colors;
    const tracked = typeof bid.progress === "number";
    const fill = bid.tone === "orange" ? palette.stage.review : bid.stage === "drafting" ? palette.stage.drafting : colors.foreground;
    const lifted = this.dragId === bid.id;
    return v_flex()
      .id(`card-${bid.id}`)
      .min_w_0()
      .overflow_hidden()
      .px(15)
      .pt(13)
      .pb(11)
      .rounded(11)
      .bg(colors.surface)
      .border(1)
      .border_color(lifted ? palette.stage[bid.stage] : colors.border)
      .shadow_xs()
      .cursor_pointer()
      .when(lifted, (el) => el.opacity(0.55))
      .hover((h) => h.border_color(colors.ring))
      .on_mouse_down("left", (_event, cx) => {
        this.dragId = bid.id;
        this.dropStage = bid.stage;
        cx.notify();
      })
      .on_mouse_up("left", (_event, cx) => {
        // Released where it was picked up: that was a click, not a drag.
        if (this.dragId === bid.id) {
          this.dragId = null;
          this.dropStage = null;
          cx.stop_propagation();
          this.openBid(bid.id);
          cx.notify();
        }
      })
      .child(
        h_flex()
          .items_center()
          .gap(5)
          .child(tag(bid.tag, bid.tone).min_w_0().flex_shrink(1).truncate())
          .child(div().flex_1())
          .child(
            h_flex()
              .flex_shrink_0()
              .items_center()
              .gap(5)
              .child(icon("calendar", 12).text_color(colors.muted_foreground))
              .child(muted(bid.due, cx, 11).whitespace_nowrap()),
          ),
      )
      .child(div().mt(11).text_size(14).font_medium().truncate().child(bid.agency))
      .child(
        h_flex()
          .mt(5)
          .gap(4)
          .text_size(11)
          .text_color(colors.muted_foreground)
          .child(mono(`${bid.kind} ${bid.number}`).flex_shrink_0())
          .child(div().flex_shrink_0().child("·"))
          .child(div().min_w_0().truncate().child(bid.project)),
      )
      .child(
        h_flex()
          .mt(15)
          .h(16)
          .items_center()
          .gap(11)
          .when(tracked, (el) => el
            .child(progressBar(bid.progress ?? 0, fill))
            .child(muted(`${bid.progress}%`, cx, 11)))
          .when(!tracked, (el) => el.child(muted(bid.status ?? "", cx, 11).min_w_0().truncate())),
      )
      .child(div().mt(11).h(1).bg(colors.border))
      .child(
        h_flex()
          .mt(11)
          .h(26)
          .items_center()
          .child(h_flex().flex_1().min_w_0().overflow_hidden().child(bid.owners.length ? avatarStack(bid.owners, cx) : muted("No owner", cx, 11)))
          .child(div().flex_shrink_0().ml(8).text_size(14).font_semibold().child(money(bid.value))),
      );
  }

  /** A suggestion tile at the foot of a column. */
  promo(id, iconName, title, note, action, page, cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .items_center()
      .gap(5)
      .px(13)
      .py(20)
      .rounded(11)
      .border(1)
      .border_dashed()
      .border_color(colors.border)
      .child(
        div()
          .size(36)
          .mb(8)
          .rounded_full()
          .flex()
          .items_center()
          .justify_center()
          .bg(id === "matches" ? palette.tone.blue.bg : palette.tone.green.bg)
          .border(1)
          .border_color(id === "matches" ? palette.tone.blue.border : palette.tone.green.border)
          .text_color(id === "matches" ? palette.tone.blue.fg : palette.tone.green.fg)
          .child(icon(iconName, 16)),
      )
      .child(div().text_size(14).font_medium().child(title))
      .child(muted(note, cx, 11))
      .child(
        Button.new(`promo-${id}`)
          .mt(11)
          .h(31)
          .px(13)
          .gap(7)
          .flex()
          .items_center()
          .rounded(8)
          .bg(colors.surface)
          .border(1)
          .border_color(colors.border)
          .shadow_xs()
          .text_size(11)
          .font_medium()
          .hover((h) => h.bg(colors.accent))
          .on_click((_event, cx) => {
            this.page = page;
            cx.notify();
          })
          .child(action)
          .child(icon("chevron-right", 11)),
      );
  }

  // ------------------------------------------------------------------- list

  list(bids, cx) {
    const colors = cx.theme().colors;
    const columns = [["Bid", 3], ["Stage", 1.3], ["Status", 1.4], ["Due", 1], ["Owners", 1.1], ["Value", 0.8]];
    const cell = (flex, child) => div().flex_grow(flex).flex_basis(0).min_w_0().child(child);
    const order = stages.map((s) => s.id);
    const sorted = [...bids].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
    return v_flex()
      .rounded(13)
      .border(1)
      .border_color(colors.border)
      .overflow_hidden()
      .child(
        h_flex()
          .h(34)
          .px(16)
          .gap(13)
          .items_center()
          .bg(colors.secondary)
          .border_b(1)
          .border_color(colors.border)
          .children(columns.map(([label, flex]) => cell(flex, mono(String(label).toUpperCase()).text_size(9).text_color(colors.muted_foreground)))),
      )
      .children(sorted.map((bid, index) => {
        const stage = stages.find((s) => s.id === bid.stage);
        return Button.new(`row-${bid.id}`)
          .h(52)
          .px(16)
          .gap(13)
          .flex()
          .items_center()
          .when(index > 0, (el) => el.border_t(1).border_color(colors.border))
          .hover((h) => h.bg(colors.secondary))
          .on_click((_event, cx) => {
            this.openBid(bid.id);
            cx.notify();
          })
          .child(cell(3, v_flex()
            .gap(2)
            .child(div().text_size(12).font_medium().truncate().child(bid.agency))
            .child(muted(`${bid.kind} ${bid.number} · ${bid.project}`, cx, 11).truncate())))
          .child(cell(1.3, h_flex().items_center().gap(7)
            .child(div().size(7).rounded_full().bg(palette.stage[bid.stage]))
            .child(div().text_size(11).child(stage?.label ?? ""))))
          .child(cell(1.4, h_flex().child(tag(bid.tag, bid.tone))))
          .child(cell(1, muted(bid.due, cx, 11)))
          .child(cell(1.1, bid.owners.length ? avatarStack(bid.owners, cx) : muted("No owner", cx, 11)))
          .child(cell(0.8, div().text_size(12).font_semibold().text_right().child(money(bid.value))));
      }));
  }

  // ------------------------------------------------------------ bid sheet

  /** @param {string} id */
  openBid(id) {
    this.openId = id;
  }

  /** @param {string} id */
  bidSheet(id, cx) {
    const bid = this.bids.find((b) => b.id === id);
    const index = stages.findIndex((s) => s.id === bid?.stage);
    const next = stages[index + 1];
    const colors = cx.theme().colors;
    if (!bid) return div();
    const row = (label, value) => h_flex()
      .py(10)
      .border_b(1)
      .border_color(colors.border)
      .child(div().w(98).text_size(11).text_color(colors.muted_foreground).child(label))
      .child(div().flex_1().text_size(11).child(value));
    return v_flex()
      .w(361)
      .h_full()
      .p(23)
      .gap(16)
      .bg(colors.surface)
      .text_color(colors.foreground)
      .child(
        h_flex()
          .items_center()
          .child(div().text_size(11).text_color(colors.muted_foreground).child(`${stages[index]?.label ?? ""}  ·  ${bid.kind} ${bid.number}`))
          .child(div().flex_1())
          .child(
            Button.new("sheet-close")
              .size(25)
              .flex()
              .items_center()
              .justify_center()
              .rounded(7)
              .hover((h) => h.bg(colors.accent))
              .on_click((_event, cx) => {
                this.openId = null;
                cx.notify();
              })
              .child(icon("close", 13)),
          ),
      )
      .child(
        v_flex()
          .gap(7)
          .child(div().text_size(21).font_semibold().child(bid.agency))
          .child(div().text_size(12).text_color(colors.muted_foreground).child(bid.project)),
      )
      .child(h_flex().gap(7).child(tag(bid.tag, bid.tone)))
      .child(
        v_flex()
          .child(row("Value", money(bid.value)))
          .child(row("Due", bid.due))
          .child(row("Readiness", typeof bid.progress === "number" ? `${bid.progress}%` : bid.status ?? "—"))
          .child(row("Owners", bid.owners.length ? bid.owners.join(", ") : "No owner")),
      )
      .child(div().flex_1())
      .when(next, (el) => el.child(
        Button.new("sheet-advance")
          .h(38)
          .flex()
          .items_center()
          .justify_center()
          .gap(7)
          .rounded(10)
          .bg(colors.foreground)
          .text_color(colors.primary_foreground)
          .text_size(12)
          .font_medium()
          .on_click((_event, cx) => {
            this.openId = null;
            this.moveBid(bid.id, next.id, cx);
          })
          .child(`Move to ${next?.label}`)
          .child(icon("chevron-right", 12)),
      ));
  }

  // --------------------------------------------------------------- pages

  placeholder(cx) {
    const colors = cx.theme().colors;
    const item = [...nav.workspace, ...nav.insights].find((i) => i.id === this.page);
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(10)
      .child(
        div()
          .size(46)
          .rounded(13)
          .flex()
          .items_center()
          .justify_center()
          .bg(colors.secondary)
          .border(1)
          .border_color(colors.border)
          .child(icon(item?.icon ?? "bids", 24)),
      )
      .child(div().text_size(18).font_semibold().child(item?.label ?? ""))
      .child(muted("This screen is not part of the demo. The pipeline lives under Bids.", cx, 12))
      .child(
        Button.new("back-to-bids")
          .mt(7)
          .h(33)
          .px(15)
          .flex()
          .items_center()
          .rounded(8)
          .bg(colors.primary)
          .text_color(colors.primary_foreground)
          .text_size(11)
          .on_click((_event, cx) => {
            this.page = "bids";
            cx.notify();
          })
          .child("Open the bid pipeline"),
      );
  }

  pipeline(cx) {
    const colors = cx.theme().colors;
    const bids = this.visibleBids();
    const submitted = total(bids.filter((b) => b.stage === "submitted"));
    const won = total(bids.filter((b) => b.stage === "awarded"));
    return v_flex()
      .gap(21)
      .child(this.header(bids, cx))
      .child(this.summary(bids, cx))
      .child(this.layout === "board" ? this.board(bids, cx) : this.list(bids, cx))
      .child(
        h_flex()
          .justify_between()
          .child(muted(this.layout === "board" ? "Drag cards between stages, or click one to open it." : "Click a row to open the bid.", cx, 11))
          .child(muted(`Submitted ${money(submitted)} · won ${money(won)} this quarter`, cx, 11)),
      )
      .when(this.query && bids.length === 0, (el) => el.child(
        muted(`Nothing matches “${this.query}”.`, cx, 12).text_center().text_color(colors.muted_foreground),
      ));
  }

  render(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .relative()
      .size_full()
      .bg(colors.background)
      .text_color(colors.foreground)
      .on_mouse_up("left", (_event, cx) => {
        if (this.dragId) {
          this.dragId = null;
          this.dropStage = null;
          cx.notify();
        }
      })
      .child(
        h_flex()
          .flex_1()
          .min_h_0()
          .when(this.sidebarOpen, (el) => el.child(this.sidebar(cx)))
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .h_full()
              .mr(10)
              .when(!this.sidebarOpen, (el) => el.ml(10))
              // The gaps around the panel stand in for a title bar: drag them
              // to move the window, double-click to zoom or minimise it.
              .child(div().flex_shrink_0().h(this.sidebarOpen ? 10 : 34).window_control_area("drag"))
              .child(
            div()
              .relative()
              .flex_1()
              .min_h_0()
              // Two layers, as in the concept: a wide soft shadow cast by a
              // backing plate, and a tight one on the panel itself.
              .child(div().absolute().inset(0).rounded(16).bg(colors.surface).shadow_lg())
              .child(
            v_flex()
              .id("main")
              .size_full()
              .rounded(16)
              .bg(colors.surface)
              .border(1)
              .border_color(palette.panelBorder)
              .shadow_xs()
              .overflow_hidden()
              .child(
                v_flex()
                  .id("main-scroll")
                  .size_full()
                  .px(33)
                  .pt(25)
                  .pb(23)
                  .overflow_y_scrollbar()
                  .child(this.page === "bids" ? this.pipeline(cx) : this.placeholder(cx)),
              ),
              ),
              )
              .child(div().flex_shrink_0().h(10).window_control_area("drag")),
          ),
      )
      .when(this.notice, (el) => el.child(
        v_flex()
          .absolute()
          .right(24)
          .bottom(24)
          .w(300)
          .gap(2)
          .px(16)
          .py(12)
          .rounded(12)
          .bg(colors.primary)
          .text_color(colors.primary_foreground)
          .shadow_lg()
          .child(div().text_size(13).font_medium().child(this.notice?.title ?? ""))
          .child(div().text_size(12).opacity(0.7).child(this.notice?.body ?? "")),
      ))
      .when(this.openId, (el) => el.child(
        h_flex()
          .id("drawer")
          .absolute()
          .inset(0)
          .child(
            div()
              .id("drawer-backdrop")
              .flex_1()
              .h_full()
              .bg("#18181b1f")
              .on_mouse_down("left", (_event, cx) => {
                this.openId = null;
                cx.notify();
              }),
          )
          .child(this.bidSheet(this.openId ?? "", cx)),
      ));
  }
}
