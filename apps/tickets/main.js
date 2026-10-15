// @ts-check
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState, Textarea, TextareaState, Popup } from "gpui-base";
import { applyTheme, tone, monoFont } from "./theme.js";
import {
  icon, mono, priorityIcon, slaColor, pill, avatar,
  iconButton, textButton, menuPanel, menuItem, sectionLabel, sidebarRow, chips, initialsBadge,
  frame, gloss, slaPill, scrim, riseIn,
} from "./ui.js";
import {
  statuses, priorities, categories, channels, people, me, lastWeek, noticeIcons,
  person, statusOf, priorityOf, categoryOf, channelOf, code, isActive, slaOf, slaLabels,
  relative, seedTickets, seedCustomers, seedNotices, toCsv,
} from "./data.js";
import { ticketSheet } from "./sheet.js";
import { inboxSidebar, inboxPage, listed, isUnread } from "./inbox.js";
import { customersSidebar, customersPage, customerSheet, customerDialog, optionalColumns } from "./customers.js";

/** @typedef {import("./data.js").Ticket} Ticket */
/** @typedef {import("./data.js").Status} Status */
/** @typedef {import("./data.js").Priority} Priority */
/** @typedef {import("./data.js").Category} Category */
/** @typedef {import("./data.js").Channel} Channel */
/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {"all" | "mine" | "unassigned" | "pastdue" | "escalated"} ViewId */
/** @typedef {"number" | "priority" | "due" | "newest"} ColumnSort */

const storageKey = "tickets.state.v1";
const hour = 3_600_000;

/** Response time the SLA allows, by priority. */
const slaHours = { urgent: 4, high: 24, medium: 48, low: 72, none: 120 };

const views = /** @type {const} */ ([
  { id: "all", label: "All Tickets", icon: "ticket" },
  { id: "mine", label: "My Tickets", icon: "user" },
  { id: "unassigned", label: "Unassigned", icon: "user-x" },
  { id: "pastdue", label: "Past Due", icon: "clock" },
  { id: "escalated", label: "Escalated", icon: "alert" },
]);

const rail = /** @type {const} */ ([
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "tickets", label: "Tickets", icon: "ticket" },
  { id: "customers", label: "Customers", icon: "user" },
  { id: "knowledge", label: "Knowledge base", icon: "book" },
  { id: "reports", label: "Reports", icon: "chart" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "admin", label: "Admin", icon: "lock" },
]);

const columnSorts = /** @type {const} */ ([
  { id: "number", label: "Ticket ID" },
  { id: "priority", label: "Priority" },
  { id: "due", label: "Due date" },
  { id: "newest", label: "Newest first" },
]);

/** Sorts in place and returns the array. @param {Ticket[]} list @param {ColumnSort} by */
function sortTickets(list, by) {
  if (by === "priority") return list.sort((a, b) => priorityOf(a.priority).rank - priorityOf(b.priority).rank || a.number - b.number);
  if (by === "due") return list.sort((a, b) => a.dueAt - b.dueAt);
  if (by === "newest") return list.sort((a, b) => b.createdAt - a.createdAt);
  return list.sort((a, b) => a.number - b.number);
}

export default class Tickets extends View {
  init(_props, cx) {
    const saved = this.load();
    /** @type {import("./theme.js").Mode} */
    this.mode = saved.mode ?? "dark";
    applyTheme(this.mode);
    this.now = Date.now();
    /** @type {Ticket[]} */
    this.tickets = saved.tickets ?? seedTickets(this.now);
    this.layout = /** @type {"board" | "table"} */ (saved.layout ?? "board");
    this.sidebarOpen = saved.sidebarOpen ?? true;
    this.statsOpen = saved.statsOpen ?? true;
    /** @type {Record<string, ColumnSort>} */
    this.columnSort = saved.columnSort ?? {};
    /** @type {import("./data.js").Customer[]} */
    this.customers = saved.customers ?? seedCustomers();
    /** @type {import("./data.js").Notice[]} */
    this.notices = saved.notices ?? seedNotices(this.now);
    this.custLayout = /** @type {"table" | "grid"} */ (saved.custLayout ?? "table");
    /** Optional customer table columns that are shown. @type {Set<string>} */
    this.custColumns = new Set(saved.custColumns ?? optionalColumns.filter((c) => c.id !== "owner" && c.id !== "csat").map((c) => c.id));

    this.page = saved.page ?? "tickets";
    /** @type {ViewId} */
    this.view = "all";
    /** @type {Category | null} */
    this.category = null;
    /** @type {Priority | null} */
    this.priority = null;
    /** Statuses the board and table show. @type {Set<Status>} */
    this.shownStatuses = new Set(statuses.map((s) => s.id));
    this.query = "";
    this.tableSort = { key: "number", dir: 1 };

    // Inbox
    /** @type {import("./inbox.js").InboxView} */
    this.inboxView = "mine";
    this.inboxNumber = /** @type {number | null} */ (null);
    this.inboxUnreadOnly = false;
    this.inboxSearchOpen = false;
    this.inboxQuery = "";
    this.via = /** @type {import("./data.js").Channel} */ ("email");
    this.sender = "Support Ops";
    // Customers
    /** @type {import("./customers.js").CustomerView} */
    this.custView = "all";
    this.custSegment = /** @type {import("./data.js").Segment | null} */ (null);
    this.custLifecycle = /** @type {import("./data.js").Lifecycle | null} */ (null);
    this.custHealth = /** @type {import("./data.js").Health | null} */ (null);
    this.custSort = /** @type {"risk" | "tickets" | "csat" | "name"} */ ("risk");
    this.custQuery = "";
    /** @type {Set<string>} */
    this.custSelected = new Set();
    this.custOpen = /** @type {string | null} */ (null);
    this.custDraft = /** @type {{ segment: import("./data.js").Segment, lifecycle: import("./data.js").Lifecycle, error: string | null } | null} */ (null);
    /** Notifications tab. */
    this.noticeTab = /** @type {"all" | "unread"} */ ("all");
    this.sheetWide = false;

    /** Which popover is open: "search", "notify", "messages", "profile", "statuses" or "column-<status>". */
    this.menu = /** @type {string | null} */ (null);
    /** The ticket in the detail sheet. */
    this.openNumber = /** @type {number | null} */ (null);
    /** The new-ticket form, while it is open. */
    this.draft = /** @type {{ status: Status, priority: Priority, category: Category, channel: Channel, assignee: string | null, error: string | null } | null} */ (null);
    /** A card under the pointer that may turn into a drag, and the drag itself. */
    this.press = /** @type {{ number: number, x: number, y: number } | null} */ (null);
    this.drag = /** @type {{ number: number, x: number, y: number } | null} */ (null);
    this.dropStatus = /** @type {Status | null} */ (null);
    this.notice = /** @type {string | null} */ (null);
    this.noticeRevision = 0;
    /**
     * Motion poses. An overlay first draws in its resting pose and is then
     * moved to its shown pose, so the native transitions have a change to
     * animate; leaving runs the same change backwards before it is removed.
     * @type {Map<string, { shown: boolean, revision: number }>}
     */
    this.poses = new Map();

    this.focus = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search tickets by subject, customer, or ID…" });
    this.search.on("change", (_event, cx) => {
      this.query = this.search.value().trim().toLowerCase();
      cx.notify();
    });
    this.quick = InputState.new({ placeholder: "Jump to a ticket…" });
    this.quick.on("change", (_event, cx) => cx.notify());
    this.subjectInput = InputState.new({ placeholder: "What is the customer asking for?" });
    this.customerInput = InputState.new({ placeholder: "Company" });
    this.contactInput = InputState.new({ placeholder: "Contact name" });
    this.descriptionInput = TextareaState.new({ placeholder: "Details, steps to reproduce, links…", rows: 4 });
    this.replyInput = TextareaState.new({ placeholder: "Comment or reply to the customer…", rows: 3 });
    this.inboxReply = TextareaState.new({ placeholder: "Comment or reply to the customer…", rows: 4 });
    this.sheetTitle = InputState.new({ placeholder: "Ticket name" });
    this.sheetTitle.on("change", (_event, cx) => {
      const t = this.openNumber === null ? null : this.ticket(this.openNumber);
      const subject = this.sheetTitle.value().trim();
      if (!t || !subject || subject === t.subject) return;
      t.subject = subject;
      this.save();
      cx.notify();
    });
    this.inboxSearch = InputState.new({ placeholder: "Search conversations…" });
    this.inboxSearch.on("change", (_event, cx) => {
      this.inboxQuery = this.inboxSearch.value().trim().toLowerCase();
      cx.notify();
    });
    this.custSearch = InputState.new({ placeholder: "Search customers by account, owner, or contact…" });
    this.custSearch.on("change", (_event, cx) => {
      this.custQuery = this.custSearch.value().trim().toLowerCase();
      cx.notify();
    });
    this.custNameInput = InputState.new({ placeholder: "Jane Doe" });
    this.custOrgInput = InputState.new({ placeholder: "Company" });
    this.custEmailInput = InputState.new({ placeholder: "jane@company.com" });

    // SLA states and relative times follow the clock.
    cx.timer.every(30_000, (cx) => {
      this.now = Date.now();
      const before = this.notices.length;
      this.checkBreaches();
      if (this.notices.length !== before) this.save();
      cx.notify();
    });
  }

  // ------------------------------------------------------------------ state

  load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved === "object") return saved;
    } catch {}
    return {};
  }

  save() {
    localStorage.setItem(storageKey, JSON.stringify({
      mode: this.mode,
      tickets: this.tickets,
      layout: this.layout,
      sidebarOpen: this.sidebarOpen,
      statsOpen: this.statsOpen,
      columnSort: this.columnSort,
      customers: this.customers,
      notices: this.notices,
      custLayout: this.custLayout,
      custColumns: [...this.custColumns],
      page: this.page,
    }));
  }

  /** @param {number} number */
  ticket(number) {
    return this.tickets.find((t) => t.number === number) ?? null;
  }

  /** @param {Ticket} t @param {ViewId} view */
  inView(t, view) {
    if (view === "mine") return t.assignee === me.id;
    if (view === "unassigned") return t.assignee === null && isActive(t);
    if (view === "pastdue") return slaOf(t, this.now) === "breached";
    if (view === "escalated") return t.escalated && isActive(t);
    return true;
  }

  /** Tickets after the sidebar filters and the search box, before the status filter. */
  filtered() {
    return this.tickets.filter((t) => {
      if (!this.inView(t, this.view)) return false;
      if (this.category && t.category !== this.category) return false;
      if (this.priority && t.priority !== this.priority) return false;
      if (!this.query) return true;
      const haystack = `${t.subject} ${t.customer} ${t.contact} ${code(t.number)} ${t.number}`.toLowerCase();
      return haystack.includes(this.query);
    });
  }

  /**
   * Adds a notification, once per id.
   * @param {Omit<import("./data.js").Notice, "at" | "read">} notice
   */
  notify(notice) {
    if (this.notices.some((n) => n.id === notice.id)) return;
    this.notices = [{ ...notice, at: Date.now(), read: false }, ...this.notices].slice(0, 40);
  }

  /** Raises a notice for every SLA that has just been breached. */
  checkBreaches() {
    for (const t of this.tickets) {
      if (slaOf(t, this.now) !== "breached" || t.dueAt < this.now - 60_000 * 2) continue;
      this.notify({ id: `breach-${t.number}-${t.dueAt}`, kind: "sla", actor: "SLA monitor", action: "reported a breach on",
        target: `Ticket ${code(t.number)}`, body: t.subject, ticket: t.number });
    }
  }

  /** The latest customer replies across every ticket. */
  messages() {
    return this.tickets
      .flatMap((t) => t.activity.filter((a) => a.kind === "reply" && !person(a.who)).map((a) => ({ ticket: t, activity: a })))
      .sort((a, b) => b.activity.at - a.activity.at)
      .slice(0, 6);
  }

  /** @param {string} text */
  toast(text, cx) {
    this.notice = text;
    this.reveal("toast", cx);
    const revision = ++this.noticeRevision;
    cx.timer.after(2400, (cx) => {
      if (revision !== this.noticeRevision) return;
      this.conceal("toast", cx, () => { this.notice = null; }, 180);
    });
  }

  // ---------------------------------------------------------------- motion

  /** Whether `name` is in its shown pose. @param {string} name */
  shown(name) {
    return this.poses.get(name)?.shown ?? true;
  }

  /** Puts `name` in its resting pose now and its shown pose a frame later. @param {string} name */
  reveal(name, cx) {
    const pose = { shown: false, revision: (this.poses.get(name)?.revision ?? 0) + 1 };
    this.poses.set(name, pose);
    cx.timer.after(24, (cx) => {
      if (this.poses.get(name) !== pose) return;
      pose.shown = true;
      cx.notify();
    });
  }

  /**
   * Moves `name` back to its resting pose, then runs `done` — unless it was
   * revealed again in the meantime.
   * @param {string} name @param {(cx: Context) => void} done
   */
  conceal(name, cx, done, ms = 220) {
    const pose = { shown: false, revision: (this.poses.get(name)?.revision ?? 0) + 1 };
    this.poses.set(name, pose);
    cx.notify();
    cx.timer.after(ms, (cx) => {
      if (this.poses.get(name) !== pose) return;
      done(cx);
      cx.notify();
    });
  }

  /**
   * The open menu's panel, dropping into place as it appears.
   * @param {string} id @param {import("gpui-kit").Element} panel
   */
  popIn(id, panel, { up = false } = {}) {
    const shown = this.shown("menu");
    return div()
      .id(`${id}-motion`)
      .relative()
      .when(up, (el) => el.mb(6))
      .when(!up, (el) => el.mt(6))
      .top(shown ? 0 : up ? 8 : -8)
      .opacity(shown ? 1 : 0)
      .transition("top", { duration: 180, easing: "ease-out" })
      .transition("opacity", { duration: 140, easing: "ease-out" })
      .child(panel);
  }

  /**
   * Changes one ticket and logs what changed in its activity.
   * @param {number} number @param {Partial<Ticket>} patch @param {string} [event]
   */
  patch(number, patch, cx, event) {
    const t = this.ticket(number);
    if (!t) return;
    Object.assign(t, patch);
    if (patch.status && patch.status !== "open" && patch.status !== "pending") t.snoozedUntil = 0;
    if (event) t.activity.push({ at: Date.now(), who: me.id, kind: "event", text: event });
    this.save();
    cx.notify();
  }

  /** @param {number} number @param {Status} status */
  moveTicket(number, status, cx) {
    const t = this.ticket(number);
    if (!t || t.status === status) return;
    this.patch(number, { status }, cx, `Status changed to ${statusOf(status).label}`);
    this.toast(`${code(number)} moved to ${statusOf(status).label}`, cx);
  }

  /** @param {Status} status */
  openDraft(status, cx) {
    this.menu = null;
    this.draft = { status, priority: "medium", category: "technical", channel: "email", assignee: me.id, error: null };
    this.reveal("dialog", cx);
    for (const input of [this.subjectInput, this.customerInput, this.contactInput]) input.set_value("");
    this.descriptionInput.set_value("");
    cx.notify();
  }

  closeDraft(cx) {
    this.conceal("dialog", cx, () => { this.draft = null; }, 180);
  }

  createTicket(cx) {
    const draft = this.draft;
    if (!draft) return;
    const subject = this.subjectInput.value().trim();
    const customer = this.customerInput.value().trim();
    if (!subject || !customer) {
      draft.error = !subject ? "Give the ticket a subject." : "Name the customer.";
      cx.notify();
      return;
    }
    const now = Date.now();
    const number = Math.max(0, ...this.tickets.map((t) => t.number)) + 1;
    const contact = this.contactInput.value().trim() || customer;
    const description = this.descriptionInput.value().trim();
    /** @type {Ticket} */
    const t = {
      number, subject, customer, contact, description,
      channel: draft.channel, category: draft.category, priority: draft.priority,
      status: draft.status, assignee: draft.assignee, escalated: false,
      createdAt: now, dueAt: now + slaHours[draft.priority] * hour,
      activity: [
        ...(description ? [{ at: now, who: contact, kind: /** @type {const} */ ("reply"), text: description }] : []),
        { at: now, who: me.id, kind: "event", text: "Created ticket" },
      ],
    };
    this.tickets = [...this.tickets, t];
    this.closeDraft(cx);
    this.save();
    this.toast(`${code(number)} created`, cx);
    cx.notify();
  }

  /** @param {number} number */
  openTicket(number, cx) {
    this.menu = null;
    if (this.openNumber === null) this.reveal("sheet", cx);
    this.openNumber = number;
    this.replyInput.set_value("");
    const t = this.ticket(number);
    if (t) {
      this.sheetTitle.set_value(t.subject);
      t.seenAt = Date.now();
      this.save();
    }
    cx.notify();
  }

  /**
   * Adds a reply or an internal note from the composer; returns whether it did.
   * @param {number} number @param {"note" | "reply"} kind
   * @param {import("gpui-base").TextareaState} state
   */
  postReply(number, kind, state, cx) {
    const t = this.ticket(number);
    const text = state.value().trim();
    if (!t || !text) {
      this.toast("Write a message first", cx);
      cx.notify();
      return false;
    }
    const now = Date.now();
    t.activity.push({ at: now, who: me.id, kind: kind === "reply" ? "reply" : "note", text });
    t.seenAt = now;
    // Answering the customer hands the ticket back to them.
    if (kind === "reply" && t.status === "open") {
      t.status = "pending";
      t.activity.push({ at: now, who: me.id, kind: "event", text: "Status changed to Pending" });
    }
    state.set_value("");
    this.save();
    this.toast(kind === "reply" ? `Reply sent from ${this.sender}` : "Internal note added", cx);
    cx.notify();
    return true;
  }

  /** The conversation the inbox shows: the picked one while it is listed, else the first. */
  selectedConversation() {
    const list = listed(this);
    return list.find((t) => t.number === this.inboxNumber) ?? list[0] ?? null;
  }

  /** @param {number} number */
  selectConversation(number, cx) {
    if (this.inboxNumber !== number) this.reveal("thread", cx);
    this.inboxNumber = number;
    this.inboxReply.set_value("");
    const t = this.ticket(number);
    if (t) {
      t.seenAt = Date.now();
      this.save();
    }
    cx.notify();
  }

  /** @param {number} number */
  openInInbox(number, cx) {
    const t = this.ticket(number);
    this.menu = null;
    this.openNumber = null;
    this.page = "inbox";
    this.inboxUnreadOnly = false;
    if (t && (t.snoozedUntil ?? 0) > this.now) this.inboxView = "snoozed";
    else if (t && t.assignee !== me.id) this.inboxView = t.assignee ? "open" : "unassigned";
    else this.inboxView = "mine";
    if (t && !isActive(t)) this.patch(number, { status: "open" }, cx, "Reopened from the inbox");
    this.selectConversation(number, cx);
  }

  closeSheet(cx) {
    this.menu = null;
    this.conceal("sheet", cx, () => {
      this.openNumber = null;
      this.sheetWide = false;
    });
  }

  /** @param {import("./data.js").Customer} c */
  openTicketsOf(c) {
    return this.tickets.filter((t) => t.customer === c.organization && isActive(t));
  }

  /** @param {string} id */
  openCustomer(id, cx) {
    this.menu = null;
    if (this.custOpen === null) this.reveal("customer", cx);
    this.custOpen = id;
    cx.notify();
  }

  closeCustomer(cx) {
    this.conceal("customer", cx, () => { this.custOpen = null; });
  }

  openCustomerDraft(cx) {
    this.menu = null;
    this.custDraft = { segment: "growth", lifecycle: "onboarding", error: null };
    this.reveal("dialog", cx);
    for (const input of [this.custNameInput, this.custOrgInput, this.custEmailInput]) input.set_value("");
    cx.notify();
  }

  /** @param {number} number */
  deleteTicket(number, cx) {
    this.tickets = this.tickets.filter((t) => t.number !== number);
    this.openNumber = null;
    this.save();
    this.toast(`${code(number)} deleted`, cx);
    cx.notify();
  }

  exportCsv(cx) {
    const list = this.filtered().filter((t) => this.shownStatuses.has(t.status));
    cx.write_to_clipboard(toCsv(sortTickets(list, "number"), this.now));
    this.toast(`Copied ${list.length} tickets as CSV`, cx);
    cx.notify();
  }

  resetDemo(cx) {
    this.now = Date.now();
    this.tickets = seedTickets(this.now);
    this.customers = seedCustomers();
    this.notices = seedNotices(this.now);
    this.custSelected.clear();
    this.custOpen = null;
    this.menu = null;
    this.openNumber = null;
    this.save();
    this.toast("Demo data restored", cx);
    cx.notify();
  }

  toggleTheme(cx) {
    this.mode = this.mode === "dark" ? "light" : "dark";
    applyTheme(this.mode);
    this.save();
    cx.notify();
  }

  /** @param {string} id */
  toggleMenu(id, cx) {
    this.menu = this.menu === id ? null : id;
    if (this.menu) this.reveal("menu", cx);
    if (this.menu === "search") this.quick.set_value("");
    cx.notify();
  }

  /** @param {import("gpui-kit").KeyEvent} event */
  onKey(event, cx) {
    const key = event.key.toLowerCase();
    if (key === "escape") {
      if (this.menu) this.menu = null;
      else if (this.draft) this.closeDraft(cx);
      else if (this.custDraft) this.conceal("dialog", cx, () => { this.custDraft = null; }, 180);
      else if (this.openNumber !== null) this.closeSheet(cx);
      else if (this.custOpen !== null) this.closeCustomer(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    } else if (key === "n" && event.modifiers.platform && !this.draft) {
      if (this.page === "customers") this.openCustomerDraft(cx);
      else this.openDraft("open", cx);
      cx.stop_propagation();
    }
  }

  // ---------------------------------------------------------------- render

  render(cx) {
    const colors = cx.theme().colors;
    const sidebarWidth = this.page === "tickets" || this.page === "customers" ? 242 : this.page === "inbox" ? 300 : 0;
    return h_flex()
      .id("root")
      .relative()
      .size_full()
      .bg(colors.background)
      .text_color(colors.foreground)
      .text_size(14)
      .track_focus(this.focus)
      .key_context("Tickets")
      .on_key_down((event, cx) => this.onKey(event, cx))
      .on_mouse_move((event, cx) => {
        if (this.press && !this.drag) {
          const dx = event.position.x - this.press.x;
          const dy = event.position.y - this.press.y;
          if (dx * dx + dy * dy < 25) return;
          this.drag = { number: this.press.number, x: event.position.x, y: event.position.y };
          cx.notify();
        } else if (this.drag) {
          this.drag.x = event.position.x;
          this.drag.y = event.position.y;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_event, cx) => {
        if (!this.press && !this.drag) return;
        this.press = null;
        this.drag = null;
        this.dropStatus = null;
        cx.notify();
      })
      .child(this.rail(cx))
      .when(sidebarWidth > 0, (el) => el.child(
        // The sidebar folds by animating the width of the frame around it.
        div()
          .id(`sidebar-fold-${this.page}`)
          .h_full()
          .flex_shrink_0()
          .overflow_hidden()
          .w(this.sidebarOpen ? sidebarWidth : 0)
          .transition("width", { duration: 240, easing: "ease-in-out" })
          .child(this.page === "tickets" ? this.sidebar(cx)
            : this.page === "inbox" ? inboxSidebar(this, cx)
            : customersSidebar(this, cx)),
      ))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .h_full()
          .child(this.header(cx))
          .child(this.page === "tickets" ? this.ticketsPage(cx)
            : this.page === "inbox" ? inboxPage(this, cx)
            : this.page === "customers" ? customersPage(this, cx)
            : this.placeholder(cx)),
      )
      .when(this.drag !== null, (el) => el.child(this.ghost(cx)))
      .when(this.custOpen !== null, (el) => el.child(customerSheet(this, cx)))
      .when(this.openNumber !== null, (el) => el.child(ticketSheet(this, cx)))
      .when(this.draft !== null, (el) => el.child(this.dialog(cx)))
      .when(this.custDraft !== null, (el) => el.child(customerDialog(this, cx)))
      // Above the panels, so a press anywhere outside an open menu closes it.
      .when(this.menu !== null, (el) => el.child(
        div()
          .id("menu-backdrop")
          .absolute()
          .inset_0()
          .on_mouse_down("left", (_event, cx) => {
            this.menu = null;
            cx.notify();
          }),
      ))
      .when(this.notice !== null, (el) => el.child(
        // Anchored by its top so it can rise into place: `top` animates, `bottom` does not.
        h_flex()
          .id("toast")
          .absolute()
          .right(24)
          .top(window.viewport_size().height - (this.shown("toast") ? 64 : 48))
          .opacity(this.shown("toast") ? 1 : 0)
          .transition("opacity", { duration: 180, easing: "ease-out" })
          .transition("top", { duration: 240, easing: "ease-out" })
          .items_center()
          .gap(8)
          .px(14)
          .h(40)
          .rounded(10)
          .bg(colors.foreground)
          .text_color(colors.background)
          .text_size(13)
          .font_medium()
          .shadow_lg()
          .child(icon("check", 15))
          .child(this.notice ?? ""),
      ));
  }

  // ------------------------------------------------------------------ rail

  rail(cx) {
    const colors = cx.theme().colors;
    return v_flex()
      .w(56)
      .h_full()
      .flex_shrink_0()
      .items_center()
      .gap(6)
      .border_r(1)
      .border_color(colors.border)
      .child(div().w_full().h(36).flex_shrink_0().window_control_area("drag"))
      .child(
        frame(div()
          .size(34)
          .mb(14)
          .flex()
          .items_center()
          .justify_center()
          .text_color(colors.primary_foreground)
          .children(gloss(32, 16, tone.primaryTop, tone.primaryBottom))
          .child(icon("logo", 17)), 17, { ring: tone.ring, edge: tone.primaryBottom, sheen: tone.primaryTop }),
      )
      .children(rail.map((item) =>
        iconButton(`rail-${item.id}`, item.icon, item.label, (cx) => {
          this.page = item.id;
          this.menu = null;
          cx.notify();
        }, cx, { size: 36, iconSize: 18, round: true, bordered: this.page === item.id })))
      .child(div().flex_1().w_full().window_control_area("drag"));
  }

  // --------------------------------------------------------------- sidebar

  sidebar(cx) {
    const colors = cx.theme().colors;
    /**
     * @param {string} id @param {string} label @param {import("gpui-kit").Element} lead
     * @param {boolean} on @param {(cx: Context) => void} onClick @param {number | null} count
     */
    const row = (id, label, lead, on, onClick, count) => sidebarRow(id, label, lead, on, onClick, count, cx);

    /** @param {string} title @param {import("gpui-kit").Element[]} items */
    const section = (title, items) =>
      v_flex()
        .px(12)
        .py(10)
        .gap(1)
        .border_b(1)
        .border_color(colors.border)
        .child(sectionLabel(title, cx))
        .children(items);

    return v_flex()
      .id("sidebar")
      .w(242)
      .h_full()
      .flex_shrink_0()
      .border_r(1)
      .border_color(colors.border)
      .overflow_y_scrollbar()
      .child(div().h(14).flex_shrink_0().window_control_area("drag"))
      .child(section("Views", views.map((v) => row(
        `view-${v.id}`, v.label, icon(v.icon, 16), this.view === v.id,
        (cx) => { this.view = v.id; cx.notify(); },
        this.tickets.filter((t) => this.inView(t, v.id)).length,
      ))))
      .child(section("Categories", categories.map((c) => row(
        `category-${c.id}`, c.label, icon("folder", 16), this.category === c.id,
        (cx) => { this.category = this.category === c.id ? null : c.id; cx.notify(); },
        this.category === c.id ? this.tickets.filter((t) => t.category === c.id).length : null,
      ))))
      .child(section("Priority", priorities.map((p) => row(
        `priority-${p.id}`, p.label, priorityIcon(p.id, cx, 16), this.priority === p.id,
        (cx) => { this.priority = this.priority === p.id ? null : p.id; cx.notify(); },
        this.priority === p.id ? this.tickets.filter((t) => t.priority === p.id).length : null,
      ))));
  }

  // ---------------------------------------------------------------- header

  header(cx) {
    const colors = cx.theme().colors;
    const unread = this.notices.filter((n) => !n.read).length;
    const hasSidebar = this.page === "tickets" || this.page === "inbox" || this.page === "customers";
    const pageLabel = rail.find((r) => r.id === this.page)?.label ?? "Tickets";
    return h_flex()
      .h(64)
      .flex_shrink_0()
      .px(20)
      .items_center()
      .gap(10)
      .when(hasSidebar, (el) => el.child(iconButton("toggle-sidebar", "sidebar", this.sidebarOpen ? "Hide sidebar" : "Show sidebar", (cx) => {
        this.sidebarOpen = !this.sidebarOpen;
        this.save();
        cx.notify();
      }, cx)))
      .when(hasSidebar, (el) => el.child(div().w(1).h(18).bg(colors.border)))
      .child(div().pl(6).text_color(colors.muted_foreground).child("Workspace"))
      .child(icon("chevron-right", 14).text_color(colors.muted_foreground))
      .child(div().font_medium().child(pageLabel))
      .child(div().flex_1().self_stretch().window_control_area("drag"))
      .child(this.popupButton("search", "search", "Search", this.searchPanel(cx), cx))
      .child(this.popupButton("notify", "bell", "Notifications", this.notifyPanel(cx), cx, unread))
      .child(this.popupButton("messages", "message", "Customer replies", this.messagesPanel(cx), cx))
      .child(iconButton("theme", this.mode === "dark" ? "sun" : "moon", this.mode === "dark" ? "Light mode" : "Dark mode", (cx) => this.toggleTheme(cx), cx, { size: 36, iconSize: 17, round: true, bordered: true }))
      .child(div().w(1).h(22).mx(4).bg(colors.border))
      .child(
        Popup.new("profile-popup",
          Button.new("profile")
            .rounded_full()
            .p(2)
            .border(1)
            .border_color(colors.border)
            .hover((h) => h.border_color(colors.ring))
            .on_click((_event, cx) => this.toggleMenu("profile", cx))
            .child(avatar(me.id, cx, 32)))
          .anchor("top_right")
          .when(this.menu === "profile", (el) => el.content(this.popIn("profile", this.profilePanel(cx)))),
      );
  }

  /**
   * A round header button that opens `panel` beneath it.
   * @param {string} id @param {string} iconName @param {string} tip
   * @param {import("gpui-kit").Element} panel @param {number} [badge]
   */
  popupButton(id, iconName, tip, panel, cx, badge = 0) {
    const colors = cx.theme().colors;
    const trigger = div()
      .relative()
      .child(iconButton(`${id}-button`, iconName, tip, (cx) => this.toggleMenu(id, cx), cx, { size: 36, iconSize: 17, round: true, bordered: true, active: this.menu === id }))
      .when(badge > 0, (el) => el.child(
        div()
          .absolute()
          .top(-3)
          .right(-3)
          .min_w(17)
          .h(17)
          .px(4)
          .flex()
          .items_center()
          .justify_center()
          .rounded_full()
          .bg(colors.primary)
          .border(2)
          .border_color(colors.background)
          .text_color(colors.primary_foreground)
          .text_size(10.5)
          .font_bold()
          .child(String(badge)),
      ));
    return Popup.new(`${id}-popup`, trigger)
      .anchor("top_right")
      .when(this.menu === id, (el) => el.content(this.popIn(id, panel)));
  }

  searchPanel(cx) {
    const colors = cx.theme().colors;
    const q = this.menu === "search" ? this.quick.value().trim().toLowerCase() : "";
    const hits = this.tickets
      .filter((t) => !q || `${t.subject} ${t.customer} ${code(t.number)}`.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 7);
    return menuPanel([
      h_flex()
        .h(34)
        .px(8)
        .mb(2)
        .items_center()
        .gap(8)
        .rounded(7)
        .bg(colors.secondary)
        .border(1)
        .border_color(colors.border)
        .text_color(colors.muted_foreground)
        .child(icon("search", 14))
        .child(Input.new(this.quick).flex_1().min_w_0().text_size(13).text_color(colors.foreground)),
      sectionLabel(q ? `${hits.length} matches` : "Recent tickets", cx),
      ...hits.map((t) => menuItem(`jump-${t.number}`, t.subject, (cx) => this.openTicket(t.number, cx), cx, {
        lead: mono(code(t.number)).w(46).text_size(11).text_color(colors.muted_foreground),
      })),
      ...(hits.length ? [] : [div().px(8).py(10).text_size(13).text_color(colors.muted_foreground).child("No ticket matches.")]),
    ], cx, 380);
  }

  notifyPanel(cx) {
    const colors = cx.theme().colors;
    const unread = this.notices.filter((n) => !n.read).length;
    const items = this.notices.filter((n) => this.noticeTab === "all" || !n.read).slice().sort((a, b) => b.at - a.at);
    const startOfToday = new Date(this.now);
    startOfToday.setHours(0, 0, 0, 0);
    const today = items.filter((n) => n.at >= startOfToday.getTime());
    const earlier = items.filter((n) => n.at < startOfToday.getTime());
    /** @param {string} label */
    const divider = (label) => h_flex().px(22).py(10).gap(14).items_center().text_size(13).text_color(colors.muted_foreground)
      .child(div().flex_1().h(1).bg(colors.border)).child(label).child(div().flex_1().h(1).bg(colors.border));
    /** @param {"all" | "unread"} id @param {string} label */
    const tab = (id, label) => Button.new(`notice-tab-${id}`)
      .h(34)
      .px(14)
      .flex()
      .items_center()
      .rounded_full()
      .border(1)
      .border_color(this.noticeTab === id ? colors.border : "#00000000")
      .bg(this.noticeTab === id ? colors.accent : "#00000000")
      .font_medium()
      .text_color(this.noticeTab === id ? colors.foreground : colors.muted_foreground)
      .hover((h) => h.text_color(colors.foreground))
      .on_click((_event, cx) => {
        this.noticeTab = id;
        cx.notify();
      })
      .child(label);
    /** @param {import("./data.js").Notice} n */
    const card = (n) => frame(Button.new(`notice-${n.id}`)
      .mx(8)
      .p(14)
      .flex()
      .gap(14)
      .bg(tone.well)
      .hover((h) => h.border_color(colors.ring)), 14, { ring: tone.cardRing, edge: tone.cardEdge, sheen: tone.cardSheen })
      .on_click((_event, cx) => {
        n.read = true;
        this.save();
        if (n.ticket !== null && this.ticket(n.ticket)) this.openTicket(n.ticket, cx);
        else {
          this.menu = null;
          cx.notify();
        }
      })
      .child(div().size(40).flex_shrink_0().flex().items_center().justify_center().rounded_full().border(1).border_color(colors.border)
        .text_color(colors.muted_foreground).child(icon(noticeIcons[n.kind], 17)))
      .child(v_flex().flex_1().min_w_0().gap(4)
        .child(div().line_height(1.4).text_color(colors.secondary_foreground)
          .child(h_flex().flex_wrap().gap_x(5)
            .child(div().font_semibold().text_color(colors.foreground).child(n.actor))
            .child(n.action)
            .child(div().font_semibold().text_color(colors.foreground).child(n.target))))
        .child(div().text_size(13).line_height(1.45).text_color(colors.muted_foreground).child(n.body))
        .child(div().pt(2).text_size(12).text_color(colors.muted_foreground).child(relative(n.at, this.now).replace(" ago", ""))))
      .child(div().mt(6).size(8).flex_shrink_0().rounded_full().bg(n.read ? "#00000000" : colors.primary));

    return frame(v_flex()
      .w(420)
      .bg(tone.raise)
      .shadow_xl()
      .overflow_hidden()
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation()), 18)
      .child(h_flex().h(60).pl(20).pr(12).gap(10).items_center().border_b(1).border_color(colors.border)
        .child(div().text_size(18).font_semibold().child("Notifications"))
        .child(div().text_color(colors.muted_foreground).child(String(unread)))
        .child(div().flex_1())
        .child(iconButton("close-notices", "close", "Close", (cx) => {
          this.menu = null;
          cx.notify();
        }, cx)))
      .child(h_flex().h(56).px(12).gap(4).items_center().border_b(1).border_color(colors.border)
        .child(tab("all", "All"))
        .child(tab("unread", "Unread"))
        .child(div().flex_1())
        .child(Button.new("mark-read").px(8).h(30).flex().items_center().rounded(8)
          .text_color(unread ? colors.foreground : colors.muted_foreground)
          .hover((h) => h.bg(colors.accent))
          .on_click((_event, cx) => {
            for (const n of this.notices) n.read = true;
            this.save();
            cx.notify();
          })
          .child("Mark all as read")))
      .child(v_flex()
        .id("notice-list")
        .max_h(560)
        .pb(8)
        .gap(8)
        .overflow_y_scrollbar()
        .when(today.length > 0, (el) => el.child(divider("Today")).children(today.map(card)))
        .when(earlier.length > 0, (el) => el.child(divider("Earlier")).children(earlier.map(card)))
        .when(items.length === 0, (el) => el.child(v_flex().py(40).items_center().gap(8).text_color(colors.muted_foreground)
          .child(icon("bell", 22))
          .child(this.noticeTab === "unread" ? "You're all caught up." : "No notifications yet."))));
  }

  messagesPanel(cx) {
    const colors = cx.theme().colors;
    return menuPanel([
      div().px(8).py(6).font_semibold().text_size(13).child("Customer replies"),
      ...this.messages().map(({ ticket: t, activity: a }) => Button.new(`message-${t.number}-${a.at}`)
        .px(8)
        .py(7)
        .flex()
        .flex_col()
        .items_stretch()
        .gap(2)
        .rounded(7)
        .hover((h) => h.bg(colors.accent))
        .on_click((_event, cx) => this.openTicket(t.number, cx))
        .child(h_flex().w_full().gap(6)
          .child(div().flex_1().min_w_0().truncate().text_size(13).font_medium().child(`${a.who} · ${t.customer}`))
          .child(div().text_size(11).text_color(colors.muted_foreground).child(relative(a.at, this.now))))
        .child(div().w_full().text_size(12).text_color(colors.muted_foreground).truncate().child(a.text))),
    ], cx, 360);
  }

  profilePanel(cx) {
    const colors = cx.theme().colors;
    const mine = this.tickets.filter((t) => t.assignee === me.id && isActive(t)).length;
    return menuPanel([
      h_flex().px(8).py(8).gap(10).items_center()
        .child(avatar(me.id, cx, 34))
        .child(v_flex()
          .child(div().font_semibold().text_size(13).child(me.name))
          .child(div().text_size(12).text_color(colors.muted_foreground).child(`${mine} active tickets`))),
      div().h(1).my(3).bg(colors.border),
      menuItem("profile-mine", "My tickets", (cx) => {
        this.menu = null;
        this.page = "tickets";
        this.view = "mine";
        cx.notify();
      }, cx, { lead: icon("user", 15) }),
      menuItem("profile-theme", this.mode === "dark" ? "Light mode" : "Dark mode", (cx) => {
        this.menu = null;
        this.toggleTheme(cx);
      }, cx, { lead: icon(this.mode === "dark" ? "sun" : "moon", 15) }),
      menuItem("profile-reset", "Reset demo data", (cx) => this.resetDemo(cx), cx, { lead: icon("rotate", 15), danger: true }),
    ], cx, 230);
  }

  placeholder(cx) {
    const colors = cx.theme().colors;
    const item = rail.find((r) => r.id === this.page) ?? rail[0];
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(12)
      .child(div().size(56).flex().items_center().justify_center().rounded(14).bg(colors.surface).border(1).border_color(colors.border)
        .child(icon(item.icon, 24).text_color(colors.muted_foreground)))
      .child(div().text_size(18).font_semibold().child(item.label))
      .child(div().text_color(colors.muted_foreground).child("This part of the workspace is not in the demo."))
      .child(textButton("back-to-tickets", "Back to Tickets", "ticket", (cx) => {
        this.page = "tickets";
        cx.notify();
      }, cx));
  }

  // ------------------------------------------------------------ tickets page

  ticketsPage(cx) {
    return v_flex()
      .id("page-scroll")
      .flex_1()
      .min_h_0()
      .px(20)
      .pt(30)
      .pb(24)
      .overflow_y_scrollbar()
      .child(this.titleRow(cx))
      .child(
        // The summary folds away: its height animates between open and shut.
        div()
          .id("stats-fold")
          .flex_shrink_0()
          .overflow_hidden()
          .h(this.statsOpen ? 139 : 0)
          .opacity(this.statsOpen ? 1 : 0)
          .transition("height", { duration: 260, easing: "ease-in-out" })
          .transition("opacity", { duration: 200, easing: "ease-out" })
          .child(div().pt(17).child(this.stats(cx))),
      )
      .child(div().pt(17).child(this.toolbar(cx)))
      .child(div().pt(17).child(this.layout === "board" ? this.board(cx) : this.table(cx)));
  }

  titleRow(cx) {
    const colors = cx.theme().colors;
    const subtitle = [
      views.find((v) => v.id === this.view)?.label ?? "",
      this.category ? categoryOf(this.category).label : null,
      this.priority ? `${priorityOf(this.priority).label} priority` : null,
    ].filter(Boolean).join(" · ");
    return h_flex()
      .h(36)
      .items_center()
      .gap(10)
      .child(div().text_size(31).font_bold().child("Tickets"))
      .when(this.view !== "all" || this.category !== null || this.priority !== null, (el) => el.child(
        h_flex().pl(6).pt(6).gap(8).items_center()
          .child(div().text_size(13).text_color(colors.muted_foreground).child(subtitle))
          .child(Button.new("clear-filters")
            .text_size(13)
            .text_color(colors.muted_foreground)
            .underline()
            .hover((h) => h.text_color(colors.foreground))
            .on_click((_event, cx) => {
              this.view = "all";
              this.category = null;
              this.priority = null;
              cx.notify();
            })
            .child("Clear filters")),
      ))
      .child(div().flex_1())
      .child(textButton("export", "Export", "download", (cx) => this.exportCsv(cx), cx, { h: 34 }).tooltip("Copy the shown tickets as CSV"))
      .child(textButton("new-ticket", "New Ticket", "plus", (cx) => this.openDraft("open", cx), cx, { primary: true, h: 34 }).tooltip("New ticket (⌘N)"))
      .child(iconButton("toggle-stats", this.statsOpen ? "chevron-up" : "chevron-down", this.statsOpen ? "Hide summary" : "Show summary", (cx) => {
        this.statsOpen = !this.statsOpen;
        this.save();
        cx.notify();
      }, cx, { size: 34, round: true, strong: true }));
  }

  stats(cx) {
    const count = (/** @type {Status} */ s) => this.tickets.filter((t) => t.status === s).length;
    const tiles = [
      { id: "total", label: "TOTAL TICKETS", icon: "ticket", value: this.tickets.length, before: lastWeek.total, goodWhenUp: false },
      { id: "open", label: "OPEN", icon: "alert", value: count("open"), before: lastWeek.open, goodWhenUp: false },
      { id: "pending", label: "PENDING", icon: "clock", value: count("pending"), before: lastWeek.pending, goodWhenUp: false },
      { id: "resolved", label: "RESOLVED", icon: "check", value: count("resolved"), before: lastWeek.resolved, goodWhenUp: true },
    ];
    return h_flex().gap(17).children(tiles.map((tile) => this.statTile(tile, cx)));
  }

  /** @param {{ id: string, label: string, icon: string, value: number, before: number, goodWhenUp: boolean }} tile */
  statTile(tile, cx) {
    const colors = cx.theme().colors;
    const delta = tile.value - tile.before;
    const percent = tile.before ? Math.abs(delta) / tile.before * 100 : 0;
    const good = delta === 0 || (delta > 0) === tile.goodWhenUp;
    const color = delta === 0 ? colors.muted_foreground : good ? tone.green : tone.red;
    const shown = tile.id === "total" ? null : tile.id;
    const only = shown !== null && this.shownStatuses.size === 1 && this.shownStatuses.has(/** @type {Status} */ (shown));
    // Two frames, one inside the other: the label sits on the raised outer
    // one, the figure in a sunk inner one, as in the design.
    return frame(v_flex()
      .flex_1()
      .min_w_0()
      .h(122)
      .p(3)
      .bg(tone.raise), 16)
      .child(
        h_flex()
          .h(30)
          .px(9)
          .items_center()
          .gap(7)
          .text_size(12.5)
          .text_color(colors.muted_foreground)
          .child(icon(tile.icon, 14))
          .child(tile.label),
      )
      .child(
        frame(Button.new(`tile-${tile.id}`)
          .flex_1()
          .flex()
          .flex_col()
          .items_start()
          .justify_center()
          .gap(4)
          .px(14)
          .bg(only ? colors.accent : tone.well)
          .hover((h) => h.border_color(tone.sheen))
          .tooltip(shown ? `Show only ${statusOf(shown).label.toLowerCase()} tickets` : "Show every status")
          .on_click((_event, cx) => {
            this.shownStatuses = new Set(shown && !only ? [/** @type {Status} */ (shown)] : statuses.map((s) => s.id));
            cx.notify();
          })
          .child(div().text_size(30).font_medium().line_height(1.15).child(String(tile.value)))
          .child(
            h_flex()
              .items_center()
              .gap(5)
              .text_size(13)
              .child(icon(delta >= 0 ? "trend-up" : "trend-down", 13).text_color(color))
              .child(div().text_color(color).child(`${Math.abs(delta)} (${percent.toFixed(percent % 1 ? 1 : 0)}%)`))
              .child(div().text_color(colors.muted_foreground).child("vs last week")),
          ), 13, { ring: tone.cardRing, edge: tone.cardEdge, sheen: tone.cardSheen }),
      );
  }

  toolbar(cx) {
    const colors = cx.theme().colors;
    const allShown = this.shownStatuses.size === statuses.length;
    const statusLabel = allShown ? "All Statuses"
      : this.shownStatuses.size === 1 ? statusOf([...this.shownStatuses][0]).label
      : `${this.shownStatuses.size} Statuses`;
    return h_flex()
      .items_center()
      .gap(10)
      .child(
        frame(h_flex()
          .w(440)
          .max_w("50%")
          .h(38)
          .px(13)
          .items_center()
          .gap(10)
          .bg(tone.well)
          .text_color(colors.muted_foreground), 10)
          .child(icon("search", 16))
          .child(Input.new(this.search).flex_1().min_w_0().text_size(14).text_color(colors.foreground))
          .when(this.query.length > 0, (el) => el.child(iconButton("clear-search", "close", "Clear search", (cx) => {
            this.search.set_value("");
            this.query = "";
            cx.notify();
          }, cx, { size: 22, iconSize: 13 }))),
      )
      .child(div().flex_1())
      .child(
        Popup.new("statuses-popup",
          frame(Button.new("statuses")
            .h(38)
            .px(14)
            .flex()
            .items_center()
            .gap(8)
            .font_medium()
            .when(this.menu === "statuses", (el) => el.bg(colors.accent))
            .hover((h) => h.opacity(0.85))
            .when(this.menu !== "statuses", (el) => el.children(gloss(36, 9, tone.glossTop, tone.glossBottom)))
            .on_click((_event, cx) => this.toggleMenu("statuses", cx))
            .child(icon("sliders", 15))
            .child(statusLabel), 10))
          .anchor("top_right")
          .when(this.menu === "statuses", (el) => el.content(this.popIn("statuses", menuPanel([
            sectionLabel("Show statuses", cx),
            ...statuses.map((s) => menuItem(`status-filter-${s.id}`, s.label, (cx) => {
              if (this.shownStatuses.has(s.id)) {
                if (this.shownStatuses.size > 1) this.shownStatuses.delete(s.id);
              } else this.shownStatuses.add(s.id);
              cx.notify();
            }, cx, { checked: this.shownStatuses.has(s.id), lead: icon(s.icon, 15), trail: String(this.filtered().filter((t) => t.status === s.id).length) })),
            div().h(1).my(3).bg(colors.border),
            menuItem("status-filter-all", "Show all", (cx) => {
              this.shownStatuses = new Set(statuses.map((s) => s.id));
              this.menu = null;
              cx.notify();
            }, cx),
          ], cx, 210)))),
      )
      .child(
        frame(h_flex()
          .h(38)
          .p(3)
          .gap(2)
          .bg(tone.raise), 10)
          .child(iconButton("layout-board", "kanban", "Board", (cx) => {
            this.layout = "board";
            this.save();
            cx.notify();
          }, cx, { size: 30, active: this.layout === "board" }))
          .child(iconButton("layout-table", "table", "Table", (cx) => {
            this.layout = "table";
            this.save();
            cx.notify();
          }, cx, { size: 30, active: this.layout === "table" })),
      );
  }

  // ------------------------------------------------------------------ board

  board(cx) {
    const tickets = this.filtered();
    const shown = statuses.filter((s) => this.shownStatuses.has(s.id));
    return h_flex()
      .items_start()
      .gap(17)
      .children(shown.map((s) => this.column(s, sortTickets(tickets.filter((t) => t.status === s.id), this.columnSort[s.id] ?? "number"), cx)));
  }

  /** @param {(typeof statuses)[number]} status @param {Ticket[]} tickets */
  column(status, tickets, cx) {
    const colors = cx.theme().colors;
    const dragged = this.drag ? this.ticket(this.drag.number) : null;
    const target = dragged !== null && this.dropStatus === status.id && dragged.status !== status.id;
    const sort = this.columnSort[status.id] ?? "number";
    const menuId = `column-${status.id}`;
    return frame(v_flex()
      .id(`column-${status.id}`)
      .flex_1()
      .min_w_0()
      .p(8)
      .gap(9)
      .bg(target ? colors.accent : tone.raise), 16, target ? { ring: tone.ring, edge: colors.primary, sheen: colors.primary } : {})
      .on_hover((hovered, cx) => {
        if (!this.drag) return;
        if (hovered) this.dropStatus = status.id;
        else if (this.dropStatus === status.id) this.dropStatus = null;
        cx.notify();
      })
      .on_mouse_up("left", (_event, cx) => {
        if (this.drag) this.moveTicket(this.drag.number, status.id, cx);
      })
      .child(
        h_flex()
          .h(36)
          .pl(6)
          .items_center()
          .gap(8)
          .child(icon(status.icon, 15).text_color(colors.muted_foreground))
          .child(div().text_size(13.5).font_medium().child(status.label))
          .child(div().text_size(13.5).text_color(colors.muted_foreground).child(String(tickets.length)))
          .child(div().flex_1())
          .child(iconButton(`add-${status.id}`, "plus", `New ${status.label.toLowerCase()} ticket`, (cx) => this.openDraft(status.id, cx), cx, { size: 28, strong: true }))
          .child(
            Popup.new(`${menuId}-popup`,
              iconButton(`${menuId}-button`, "more", "Column options", (cx) => this.toggleMenu(menuId, cx), cx, { size: 28, strong: true, active: this.menu === menuId }))
              .anchor("top_right")
              .when(this.menu === menuId, (el) => el.content(this.popIn(menuId, menuPanel([
                sectionLabel("Sort by", cx),
                ...columnSorts.map((s) => menuItem(`${menuId}-sort-${s.id}`, s.label, (cx) => {
                  this.columnSort[status.id] = s.id;
                  this.menu = null;
                  this.save();
                  cx.notify();
                }, cx, { checked: sort === s.id })),
                div().h(1).my(3).bg(colors.border),
                menuItem(`${menuId}-hide`, "Hide column", (cx) => {
                  if (this.shownStatuses.size > 1) this.shownStatuses.delete(status.id);
                  this.menu = null;
                  cx.notify();
                }, cx, { lead: icon("close", 14) }),
              ], cx, 200)))),
          ),
      )
      .children(tickets.map((t) => this.card(t, cx)))
      .when(target || tickets.length === 0, (el) => el.child(
        div()
          .h(64)
          .flex()
          .items_center()
          .justify_center()
          .rounded(13)
          .border(1)
          .border_dashed()
          .border_color(target ? colors.primary : tone.cardEdge)
          .text_size(13)
          .text_color(colors.muted_foreground)
          .child(target ? `Drop to move to ${status.label}` : "No tickets"),
      ));
  }

  /** @param {Ticket} t */
  cardBody(t, cx) {
    const colors = cx.theme().colors;
    const sla = slaOf(t, this.now);
    return [
      h_flex()
        .items_center()
        .gap(8)
        .text_color(colors.muted_foreground)
        .child(icon(channelOf(t.channel).icon, 17))
        .child(priorityIcon(t.priority, cx, 17))
        .when(t.escalated && isActive(t), (el) => el.child(icon("flag", 15).text_color(tone.orange)))
        .child(div().flex_1())
        .child(div().text_size(13).child(code(t.number))),
      div().text_size(14).line_height(1.7).child(t.subject),
      h_flex()
        .items_center()
        .justify_between()
        .child(avatar(t.assignee, cx, 22))
        .child(slaPill(sla, slaLabels[sla], cx)),
    ];
  }

  /** @param {Ticket} t */
  card(t, cx) {
    const colors = cx.theme().colors;
    const lifted = this.drag?.number === t.number;
    const opened = this.openNumber === t.number;
    // A card is a single hairline on the sunk fill, as in the design: the
    // layered frame belongs to the column around it.
    return v_flex()
      .id(`card-${t.number}`)
      .min_w_0()
      .px(17)
      .pt(16)
      .pb(16)
      .gap(12)
      .bg(tone.well)
      .cursor_pointer()
      .rounded(13)
      .border(1)
      .border_color(opened ? colors.ring : tone.cardEdge)
      .opacity(lifted ? 0.35 : 1)
      .transition("opacity", 160)
      .hover((h) => h.border_color(colors.ring))
      .on_mouse_down("left", (event, cx) => {
        this.press = { number: t.number, x: event.position.x, y: event.position.y };
        cx.notify();
      })
      .on_mouse_up("left", (_event, cx) => {
        // Released without moving: a click, not a drag.
        if (this.press?.number === t.number && !this.drag) {
          this.press = null;
          cx.stop_propagation();
          this.openTicket(t.number, cx);
        }
      })
      .children(this.cardBody(t, cx));
  }

  /** The card following the pointer while it is dragged; it springs after it. */
  ghost(cx) {
    const colors = cx.theme().colors;
    const drag = this.drag;
    const t = drag ? this.ticket(drag.number) : null;
    if (!drag || !t) return div();
    return frame(v_flex()
      .id("drag-ghost")
      .absolute()
      .left(drag.x - 40)
      .top(drag.y - 24)
      .spring("left", { response: 180, damping: 0.8 })
      .spring("top", { response: 180, damping: 0.8 })
      .w(300)
      .px(17)
      .py(16)
      .gap(12)
      .bg(tone.well)
      .shadow_xl(), 13, { ring: colors.primary, edge: tone.cardEdge, sheen: tone.cardSheen })
      .children(this.cardBody(t, cx));
  }

  // ------------------------------------------------------------------ table

  table(cx) {
    const colors = cx.theme().colors;
    const { key, dir } = this.tableSort;
    /** @type {Record<string, (t: Ticket) => string | number>} */
    const value = {
      number: (t) => t.number,
      subject: (t) => t.subject.toLowerCase(),
      customer: (t) => t.customer.toLowerCase(),
      status: (t) => statuses.findIndex((s) => s.id === t.status),
      priority: (t) => priorityOf(t.priority).rank,
      assignee: (t) => person(t.assignee)?.name ?? "~",
      due: (t) => t.dueAt,
    };
    const list = this.filtered()
      .filter((t) => this.shownStatuses.has(t.status))
      .sort((a, b) => {
        const x = value[key](a), y = value[key](b);
        return (x < y ? -1 : x > y ? 1 : 0) * dir || a.number - b.number;
      });
    const columns = [
      { id: "number", label: "ID", w: 84 },
      { id: "subject", label: "Subject", w: 0 },
      { id: "customer", label: "Customer", w: 150 },
      { id: "status", label: "Status", w: 120 },
      { id: "priority", label: "Priority", w: 110 },
      { id: "assignee", label: "Assignee", w: 150 },
      { id: "due", label: "SLA", w: 170 },
    ];
    /** @param {{ w: number }} c @param {import("gpui-kit").NativeElement} el */
    const sized = (c, el) => c.w ? el.w(c.w).flex_shrink_0() : el.flex_1().min_w_0();
    return frame(v_flex()
      .bg(tone.raise)
      .overflow_hidden(), 14)
      .child(
        h_flex()
          .h(40)
          .px(16)
          .items_center()
          .border_b(1)
          .border_color(colors.border)
          .text_size(12)
          .font_family(monoFont)
          .text_color(colors.muted_foreground)
          .children(columns.map((c) => sized(c,
            Button.new(`sort-${c.id}`)
              .h_full()
              .flex()
              .items_center()
              .gap(4)
              .hover((h) => h.text_color(colors.foreground))
              .on_click((_event, cx) => {
                this.tableSort = { key: c.id, dir: key === c.id ? -dir : 1 };
                cx.notify();
              })
              .child(c.label.toUpperCase())
              .when(key === c.id, (el) => el.child(icon(dir > 0 ? "arrow-up" : "arrow-down", 12).text_color(colors.foreground))),
          ))),
      )
      .children(list.map((t) => {
        const sla = slaOf(t, this.now);
        const who = person(t.assignee);
        return h_flex()
          .id(`row-${t.number}`)
          .h(48)
          .px(16)
          .items_center()
          .border_b(1)
          .border_color(colors.border)
          .bg(this.openNumber === t.number ? colors.accent : tone.well)
          .cursor_pointer()
          .hover((h) => h.bg(colors.accent))
          .on_click((_event, cx) => this.openTicket(t.number, cx))
          .child(mono(code(t.number)).w(84).flex_shrink_0().text_size(13).text_color(colors.muted_foreground))
          .child(h_flex().flex_1().min_w_0().pr(12).gap(8).items_center()
            .child(icon(channelOf(t.channel).icon, 15).text_color(colors.muted_foreground))
            .child(div().flex_1().min_w_0().truncate().font_medium().child(t.subject))
            .when(t.escalated && isActive(t), (el) => el.child(icon("flag", 14).text_color(tone.orange))))
          .child(div().w(150).flex_shrink_0().pr(8).truncate().text_color(colors.muted_foreground).child(t.customer))
          .child(h_flex().w(120).flex_shrink_0().gap(7).items_center()
            .child(icon(statusOf(t.status).icon, 14).text_color(colors.muted_foreground))
            .child(statusOf(t.status).label))
          .child(h_flex().w(110).flex_shrink_0().gap(6).items_center()
            .child(priorityIcon(t.priority, cx, 14))
            .child(priorityOf(t.priority).label))
          .child(h_flex().w(150).flex_shrink_0().gap(8).items_center()
            .child(avatar(t.assignee, cx, 22))
            .child(div().truncate().text_color(who ? colors.foreground : colors.muted_foreground).child(who?.name ?? "Unassigned")))
          .child(h_flex().w(170).flex_shrink_0().gap(8).items_center()
            .child(slaPill(sla, slaLabels[sla], cx))
            .when(isActive(t), (el) => el.child(div().text_size(12).text_color(colors.muted_foreground).child(relative(t.dueAt, this.now)))));
      }))
      .when(list.length === 0, (el) => el.child(
        div().h(120).flex().items_center().justify_center().bg(tone.well).text_color(colors.muted_foreground).child("No tickets match these filters."),
      ));
  }

  // ----------------------------------------------------------------- dialog

  dialog(cx) {
    const colors = cx.theme().colors;
    const draft = this.draft;
    if (!draft) return div();
    /** @param {import("gpui-base").InputState} state */
    const field = (state) => h_flex()
      .h(36)
      .px(10)
      .items_center()
      .rounded(8)
      .bg(colors.secondary)
      .border(1)
      .border_color(colors.border)
      .child(Input.new(state).flex_1().min_w_0().text_size(14).text_color(colors.foreground));
    /** @param {string} label @param {import("gpui-kit").Element} control */
    const labelled = (label, control) => v_flex().gap(6)
      .child(div().text_size(13).font_medium().text_color(colors.muted_foreground).child(label))
      .child(control);
    const assignees = [...people.map((p) => ({ id: p.id, label: p.name.split(" ")[0] })), { id: "none", label: "Unassigned" }];

    const shown = this.shown("dialog");
    const close = (/** @type {Context} */ cx) => this.closeDraft(cx);
    return div()
      .id("dialog")
      .absolute()
      .inset_0()
      .flex()
      .items_center()
      .justify_center()
      .child(scrim("dialog", shown, close))
      .child(riseIn("dialog", shown,
        frame(v_flex()
          .id("dialog-panel")
          .w(580)
          .max_h(window.viewport_size().height - 48)
          .bg(colors.background)
          .shadow_xl(), 16)
          .child(
            h_flex()
              .h(56)
              .px(20)
              .items_center()
              .border_b(1)
              .border_color(colors.border)
              .child(div().flex_1().text_size(16).font_semibold().child("New ticket"))
              .child(iconButton("close-dialog", "close", "Close (Esc)", close, cx)),
          )
          .child(
            v_flex()
              .id("dialog-body")
              .p(20)
              .gap(16)
              .overflow_y_scrollbar()
              .child(labelled("Subject", field(this.subjectInput)))
              .child(h_flex().gap(12)
                .child(div().flex_1().child(labelled("Customer", field(this.customerInput))))
                .child(div().flex_1().child(labelled("Contact", field(this.contactInput)))))
              .child(labelled("Description", div().p(10).rounded(8).bg(colors.secondary).border(1).border_color(colors.border)
                .child(Textarea.new(this.descriptionInput).w_full().text_size(14).text_color(colors.foreground))))
              .child(labelled("Status", chips("draft-status", statuses, draft.status, (v, cx) => { draft.status = v; cx.notify(); }, cx, (s) => icon(statusOf(s).icon, 13))))
              .child(labelled("Priority", chips("draft-priority", priorities, draft.priority, (v, cx) => { draft.priority = v; cx.notify(); }, cx, (p) => priorityIcon(p, cx, 13))))
              .child(labelled("Category", chips("draft-category", categories, draft.category, (v, cx) => { draft.category = v; cx.notify(); }, cx)))
              .child(labelled("Channel", chips("draft-channel", channels, draft.channel, (v, cx) => { draft.channel = v; cx.notify(); }, cx, (c) => icon(channelOf(c).icon, 13))))
              .child(labelled("Assignee", chips("draft-assignee", assignees, draft.assignee ?? "none", (v, cx) => { draft.assignee = v === "none" ? null : v; cx.notify(); }, cx,
                (id) => avatar(id === "none" ? null : id, cx, 16)))),
          )
          .child(
            h_flex()
              .px(20)
              .py(14)
              .gap(8)
              .items_center()
              .border_t(1)
              .border_color(colors.border)
              .child(div().flex_1().text_size(13).text_color(draft.error ? colors.destructive : colors.muted_foreground)
                .child(draft.error ?? `Response due in ${slaHours[draft.priority]}h for ${priorityOf(draft.priority).label.toLowerCase()} priority`))
              .child(textButton("cancel-ticket", "Cancel", null, close, cx))
              .child(textButton("create-ticket", "Create ticket", "plus", (cx) => this.createTicket(cx), cx, { primary: true })),
          )),
      );
  }
}
