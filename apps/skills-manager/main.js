// @ts-check
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState, Textarea, TextareaState, Popover, Scrollbar, v_virtual_list } from "gpui-base";
import { Switch, Spinner } from "gpui-component";
import * as fs from "fs/promises";
import { randomUUID } from "crypto";
import { applyTheme, palette } from "./theme.js";
import { icon, muted, mark, byline, button, iconButton, pill } from "./ui.js";
import { agentRoots, importRoots, home } from "./roots.js";
import {
  SOURCES, STATUS_FILTERS, SORTS, groupDiscover, recordFirstSeen, searchSkills, filterLocal,
  sortSkills, truncate, formatBytes, relativeTime,
} from "./lib/catalog.js";
import { tildify } from "./lib/stat.js";
import {
  scanRoot, readSkill, setEnabled, trashSkill, listTrash, restoreSkill, deleteForever,
  createSkill, importSkill, fetchCatalog, installRemote, reason,
} from "./lib/library.js";

/** @typedef {import("./lib/catalog.js").LocalSkill} LocalSkill */
/** @typedef {import("./lib/catalog.js").RemoteSkill} RemoteSkill */
/** @typedef {import("./lib/library.js").TrashEntry} TrashEntry */

const CATALOG_KEY = "skills.catalog.v1";
const SEEN_KEY = "skills.first-seen.v1";
const PREFS_KEY = "skills.prefs.v1";
const CATALOG_TTL = 6 * 60 * 60 * 1000;

// Card grid geometry, shared by the cards and the virtual list that places them.
const CARD_BASIS = 260;
const CARD_HEIGHT = 164;
const CARD_GAP = 24;
const GROUP_HEADING = 66;

/** An empty cell that keeps a short last row's cards the width of the others. */
const cardSlot = () => div().flex_grow(1).flex_shrink(1).flex_basis(CARD_BASIS).min_w_0();

/**
 * @typedef {{ id: string, title: string, detail: string, skills: any[],
 *   key: (skill: any) => string, card: (skill: any) => any }} CardGroup
 */

// File operations run inside gpui-shell under the manifest grants.
const deps = {
  fs,
  store: process.dataDir ?? "",
  writeStore: async (relative, contents) => {
    const absolute = `${deps.store}/${relative}`;
    const parent = absolute.split("/").slice(0, -1).join("/");
    if (parent) await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(absolute, contents);
  },
  fetch: (url, options) => fetch(url, options),
  now: () => Date.now(),
  random: () => randomUUID(),
};

/** @param {string} key @param {any} fallback */
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} key @param {any} value */
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`could not save ${key}: ${reason(error)}`);
  }
}

/** @param {string} path */
const show = (path) => tildify(path, home);

/**
 * One sentence per distinct failure: a rate limit fails every repository at
 * once with the same words, which should read once.
 * @param {{ repo: string, message: string }[]} errors
 */
function describeErrors(errors) {
  const byMessage = new Map();
  for (const error of errors) {
    const message = error.message.replace(/\s*\(But here's the good news:.*$/, "").replace(/ for \d+\.\d+\.\d+\.\d+/, "");
    byMessage.set(message, [...(byMessage.get(message) ?? []), error.repo]);
  }
  return [...byMessage].map(([message, repos]) => `${repos.join(", ")}: ${message}`).join(" · ");
}

export default class Skills extends View {
  init(_props, cx) {
    applyTheme();
    const prefs = load(PREFS_KEY, {});
    /** "skills" | "trash" | "folders" */
    this.page = "skills";
    /** "installed" | "discover" */
    this.tab = prefs.tab === "discover" ? "discover" : "installed";
    this.filter = { root: "all", status: "all", repo: "all" };
    this.sort = { installed: prefs.sortInstalled ?? "name", discover: prefs.sortDiscover ?? "rank" };
    this.filterOpen = false;
    this.sortOpen = false;

    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_event, cx) => cx.notify());

    /** @type {LocalSkill[]} */
    this.local = [];
    /** @type {TrashEntry[]} */
    this.trash = [];
    this.scanning = false;
    /** @type {string | null} */
    this.scanError = null;
    this.scanProblemCount = 0;
    this.noticeDetails = {};

    const cached = load(CATALOG_KEY, null);
    /** @type {{ skills: RemoteSkill[], errors: { repo: string, message: string }[], fetchedAt: number } | null} */
    this.catalog = cached;
    /** @type {Record<string, number>} */
    this.firstSeen = load(SEEN_KEY, {});
    this.fetching = false;
    this.fetchProgress = "";
    /** @type {string | null} */
    this.fetchError = null;

    /** Skill keys with an operation in flight, mapped to what it is doing. @type {Record<string, string>} */
    this.busy = {};
    /** The open dialog's state; its content reads this. @type {any} */
    this.dialog = null;

    this.form = {
      name: InputState.new({ placeholder: "meeting-prep" }),
      description: InputState.new({ placeholder: "Before each call, reads the account's notes and writes a one-page brief." }),
      body: TextareaState.new({ placeholder: "Instructions the agent follows when this skill is used…", rows: 8 }),
      path: InputState.new({ placeholder: home ? `${home}/Downloads/my-skill` : "/path/to/my-skill" }),
    };

    this.rescan(cx);
    if (!cached || Date.now() - cached.fetchedAt > CATALOG_TTL) this.refreshCatalog(cx);
  }

  savePrefs() {
    save(PREFS_KEY, { tab: this.tab, sortInstalled: this.sort.installed, sortDiscover: this.sort.discover });
  }

  // -------------------------------------------------------------------------
  // Work
  // -------------------------------------------------------------------------

  rescan(cx) {
    this.scanning = true;
    cx.spawn(async (cx) => {
      /** @type {LocalSkill[]} */
      const found = [];
      const problems = [];
      for (const root of agentRoots) {
        try {
          found.push(...(await scanRoot(deps, root)));
        } catch (error) {
          problems.push(`${root.label}: ${reason(error)}`);
        }
      }
      try {
        this.trash = await listTrash(deps);
      } catch (error) {
        problems.push(`Data folder: ${reason(error)}`);
      }
      console.info(`scanned ${agentRoots.length} folders: ${found.length} skills, ${this.trash.length} in trash${problems.length ? `; ${problems.join("; ")}` : ""}`);
      this.local = found;
      const nextError = problems.length ? problems.join(" · ") : null;
      if (nextError !== this.scanError) this.noticeDetails.scan = false;
      this.scanError = nextError;
      this.scanProblemCount = problems.length;
      this.scanning = false;
      cx.notify();
    });
  }

  refreshCatalog(cx) {
    if (this.fetching) return;
    this.fetching = true;
    this.fetchError = null;
    this.noticeDetails.fetch = false;
    this.fetchProgress = "Reading repositories…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const catalog = await fetchCatalog(deps, SOURCES, (done, total) => {
          this.fetchProgress = `Reading skills ${done} of ${total}…`;
          cx.notify();
        }, (partial) => {
          if (partial.skills.length) {
            this.catalog = partial;
            cx.notify();
          }
        }, this.catalog?.skills ?? []);
        if (catalog.skills.length === 0 && catalog.errors.length) throw new Error(describeErrors(catalog.errors));
        this.catalog = catalog;
        this.firstSeen = recordFirstSeen(this.firstSeen, catalog.skills.map((s) => s.id), catalog.fetchedAt);
        save(CATALOG_KEY, catalog);
        save(SEEN_KEY, this.firstSeen);
        this.fetchError = catalog.errors.length ? describeErrors(catalog.errors) : null;
      } catch (error) {
        this.fetchError = reason(error);
      }
      this.fetching = false;
      cx.notify();
    });
  }

  /** Runs a disk operation for one skill, then rescans. */
  operate(key, label, cx, work, done) {
    this.busy[key] = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await work();
        if (done) this.toast(done(result), "success", "", cx);
      } catch (error) {
        this.toast(`${label} failed`, "error", reason(error), cx);
      }
      delete this.busy[key];
      this.rescan(cx);
    });
  }

  /** Shows a short message in the corner for a few seconds. */
  toast(title, level, description, cx) {
    const id = (this.toastId = (this.toastId ?? 0) + 1);
    this.message = { title, level, description };
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(level === "error" ? 8000 : 4000);
      if (this.toastId === id) {
        this.message = null;
        cx.notify();
      }
    });
  }

  /** @param {LocalSkill} skill @param {boolean} enabled */
  toggle(skill, enabled, cx) {
    this.operate(skill.key, enabled ? "Enabling" : "Disabling", cx, () => setEnabled(deps, skill, enabled),
      () => `${skill.name} ${enabled ? "enabled" : "disabled"} in ${skill.rootLabel}`);
  }

  /** Where a remote skill is already installed. @param {RemoteSkill} skill */
  installedIn(skill) {
    return this.local.filter((local) => local.dirName === skill.dirName || local.name === skill.name);
  }

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  /** Draws the application's dialog over its content. */
  openDialog(state, cx) {
    this.dialog = state;
    this.filterOpen = false;
    this.sortOpen = false;
    cx.notify();
  }

  closeDialog(cx) {
    this.dialog = null;
    cx.notify();
  }

  /** Re-renders the open dialog after its state changed. */
  refreshDialog(cx) {
    cx.notify();
  }

  openDetail(skill, cx) {
    const state = { kind: "detail", skill, text: null, error: null };
    this.openDialog(state, cx);
    cx.spawn(async (cx) => {
      try {
        state.text = await readSkill(deps, skill);
      } catch (error) {
        state.error = reason(error);
      }
      cx.notify();
    });
  }

  openInstall(skill, cx) {
    const target = agentRoots.find((root) => !this.local.some((l) => l.rootId === root.id && l.dirName === skill.dirName));
    this.openDialog({ kind: "install", skill, root: target?.id ?? agentRoots[0]?.id ?? null, error: null, progress: "" }, cx);
  }

  openCreate(cx) {
    this.form.name.set_value("");
    this.form.description.set_value("");
    this.form.body.set_value("");
    this.openDialog({ kind: "create", root: agentRoots[0]?.id ?? null, error: null }, cx);
  }

  openImport(cx) {
    this.form.path.set_value("");
    this.openDialog({ kind: "import", root: agentRoots[0]?.id ?? null, error: null }, cx);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  render(cx) {
    const colors = cx.theme().colors;
    return div()
      .relative()
      .size_full()
      .bg(palette.rail)
      .text_color(colors.foreground)
      .child(
        h_flex()
          .size_full()
          .items_stretch()
          .bg(palette.rail)
          .overflow_hidden()
          .child(this.renderRail(cx))
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .min_h_0()
              .my(8)
              .mr(8)
              .rounded(10)
              .border(1)
              .border_color(colors.border)
              .bg(colors.surface)
              .overflow_hidden()
              .child(this.renderTopBar(cx))
              // The skills page scrolls its cards in a virtual list of its own.
              .child(this.page === "skills" ? this.renderSkills(cx) :
                div()
                  .id("page-scroll")
                  .flex_1()
                  .min_h_0()
                  .overflow_y_scrollbar()
                  .child(this.page === "trash" ? this.renderTrash(cx) : this.renderFolders(cx)),
              ),
          ),
      )
      .when(Boolean(this.dialog), (el) => el.child(this.renderOverlay(cx)))
      .when(Boolean(this.message), (el) => el.child(this.renderToast(cx)));
  }

  renderToast(cx) {
    const colors = cx.theme().colors;
    const { title, level, description } = this.message;
    return v_flex()
      .absolute()
      .right(28)
      .bottom(28)
      .w(360)
      .p(14)
      .gap(4)
      .rounded(10)
      .border(1)
      .border_color(colors.border)
      .bg(colors.surface)
      .shadow_lg()
      .child(h_flex().gap(8).items_center()
        .child(div().text_color(level === "error" ? colors.destructive : palette.success).child(icon(level === "error" ? "alert" : "check", 15)))
        .child(div().flex_1().min_w_0().text_size(14).font_medium().child(title)))
      .when(Boolean(description), (el) => el.child(div().pl(23).text_size(12).text_color(colors.muted_foreground).child(description)));
  }

  /** A dimmed layer that takes every press, holding the open dialog. */
  renderOverlay(cx) {
    return div()
      .id("overlay")
      .absolute()
      .inset_0()
      .flex()
      .items_center()
      .justify_center()
      .bg("#1c1c1c40")
      .on_mouse_down("left", (_event, cx) => {
        cx.stop_propagation();
        if (!this.dialog?.busy) this.closeDialog(cx);
      })
      .child(div().max_w("95%").on_mouse_down("left", (_event, cx) => cx.stop_propagation()).child(this.renderDialog(cx)));
  }

  renderRail(cx) {
    const colors = cx.theme().colors;
    const item = (id, name, label, active, onClick, badge = 0) =>
      Button.new(`rail-${id}`)
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .size(32)
        .rounded(8)
        .cursor_pointer()
        .tooltip(label)
        .text_color(active ? colors.foreground : colors.muted_foreground)
        .when(active, (el) => el.bg(palette.railActive).border(1).border_color(colors.border).shadow_sm())
        .when(!active, (el) => el.hover((s) => s.bg(colors.accent)))
        .on_click((_event, cx) => onClick(cx))
        .child(icon(name, 16))
        .when(badge > 0, (el) =>
          el.child(div().absolute().top(3).right(3).size(6).rounded_full().bg(colors.destructive)));
    const go = (page) => (cx) => {
      this.page = page;
      cx.notify();
    };
    const rule = () => div().w(18).h(1).my(10).bg(colors.input);

    return v_flex()
      .w(56)
      .h_full()
      .flex_shrink_0()
      .items_center()
      .pt(16)
      .pb(16)
      .gap(6)
      .child(
        div()
          .flex()
          .items_center()
          .justify_center()
          .size(24)
          .mb(12)
          .rounded(6)
          .bg(palette.brand)
          .child(div().size(12).rounded_full().border(2).border_color(palette.brandInk).bg(palette.brand)
            .child(div().w(4).h_full().bg(palette.brandInk))),
      )
      .child(item("skills", "skills", "Skills", this.page === "skills", go("skills")))
      .child(item("trash", "trash", "Trash", this.page === "trash", go("trash"), this.trash.length))
      .child(item("folders", "folder", "Folders and permissions", this.page === "folders", go("folders")))
      .child(rule())
      .child(item("refresh", "refresh", "Rescan folders and refresh Discover", false, (cx) => {
        this.rescan(cx);
        this.refreshCatalog(cx);
      }))
      .child(item("github", "external", "Open the anthropics/skills repository", false, (cx) => cx.open_url("https://github.com/anthropics/skills")))
      .child(rule())
      .child(item("add", "plus", "Add skill", false, (cx) => this.openCreate(cx)))
      .child(div().flex_1())
      .when(this.scanning || this.fetching, (el) => el.child(new Spinner().size("small")));
  }

  renderTopBar(cx) {
    const colors = cx.theme().colors;
    const title = this.page === "trash" ? ["trash", "Trash"] : this.page === "folders" ? ["folder", "Folders"] : ["skills", "Skills"];
    return h_flex()
      .h(52)
      .flex_shrink_0()
      .px(18)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(colors.border)
      .child(div().text_color(colors.muted_foreground).child(icon(title[0], 15)))
      .child(div().text_size(14).child(title[1]));
  }

  /** A centred column with the page heading. */
  pageColumn(cx, title, subtitle, actions) {
    return v_flex()
      .w_full()
      .px(32)
      .pt(32)
      .pb(32)
      .child(
        h_flex()
          .flex_wrap()
          .gap(16)
          .justify_between()
          .items_start()
          .child(
            v_flex()
              .gap(10)
              .child(div().text_size(20).font_medium().child(title))
              .child(muted(subtitle, cx, 15)),
          )
          .child(h_flex().flex_wrap().gap(10).items_center().children(actions)),
      );
  }

  // --- Skills page ----------------------------------------------------------

  renderSkills(cx) {
    const colors = cx.theme().colors;
    const query = this.search.value();
    const hasRoots = agentRoots.length > 0;

    const column = this.pageColumn(cx, "Skills", "Manage all your agent skills", [
      button("import", "Import", (cx) => this.openImport(cx), cx, { icon: "import", disabled: !hasRoots }),
      button("add-skill", "Add skill", (cx) => this.openCreate(cx), cx, { icon: "plus", primary: true, disabled: !hasRoots }),
    ]);

    const segment = (id, label) =>
      Button.new(`tab-${id}`)
        .px(10)
        .h(26)
        .flex()
        .items_center()
        .rounded(5)
        .text_size(14)
        .cursor_pointer()
        .text_color(this.tab === id ? colors.foreground : colors.muted_foreground)
        .when(this.tab === id, (el) => el.bg(colors.surface).border(1).border_color(colors.border).shadow_sm().font_medium())
        .on_click((_event, cx) => {
          this.tab = id;
          this.filterOpen = false;
          this.sortOpen = false;
          this.savePrefs();
          cx.notify();
        })
        .child(label);

    const filtered = this.tab === "installed" ? this.filter.root !== "all" || this.filter.status !== "all" : this.filter.repo !== "all";

    column.child(
      h_flex()
        .mt(28)
        .flex_wrap()
        .gap(12)
        .justify_between()
        .items_center()
        .child(
          h_flex()
            .p(2)
            .gap(2)
            .rounded(7)
            .bg(palette.segment)
            .border(1)
            .border_color(colors.border)
            .child(segment("installed", `Installed${this.local.length ? ` ${this.local.length}` : ""}`))
            .child(segment("discover", "Discover")),
        )
        .child(
          h_flex()
            .flex_wrap()
            .flex_grow(1)
            .flex_basis(440)
            .min_w_0()
            .gap(10)
            .items_center()
            .child(
              h_flex()
                .flex_grow(1)
                .flex_basis(200)
                .min_w_0()
                .h(32)
                .px(10)
                .gap(8)
                .items_center()
                .rounded(7)
                .border(1)
                .border_color(colors.input)
                .text_color(colors.muted_foreground)
                .child(icon("search", 15))
                .child(Input.new(this.search).flex_1().min_w_0().text_size(14).text_color(colors.foreground)),
            )
            .child(this.renderFilter(cx, filtered))
            .child(this.renderSort(cx)),
        ),
    );

    column.child(this.renderNotices(cx));
    const page = v_flex().flex_1().min_h_0().overflow_hidden();
    const done = () => page.child(column);
    /** @type {CardGroup[]} */
    const groups = [];
    const cards = () => page.child(column.pb(0)).child(this.cardList(cx, groups));

    if (this.tab === "installed") {
      if (!hasRoots) {
        column.child(this.empty(cx, "folder", "No agent folders are granted to this copy",
          "Skills reads ~/.claude/skills, ~/.codex/skills and ~/.agents/skills directly."));
        return done();
      }
      let list = filterLocal(searchSkills(this.local, query), this.filter);
      list = sortSkills(list, this.sort.installed, (s) => s.mtime ?? 0);
      if (list.length === 0) {
        column.child(this.empty(cx, "search", this.local.length ? "No skills match" : this.scanning ? "Scanning folders…" : "No skills installed yet",
          this.local.length ? "Clear the search or the filter to see every skill." : "Add one, import a folder, or install one from Discover."));
        return done();
      }
      for (const root of agentRoots) {
        const inRoot = list.filter((skill) => skill.rootId === root.id);
        if (inRoot.length === 0) continue;
        groups.push({ id: root.id, title: root.label, detail: show(root.path), skills: inRoot,
          key: (skill) => skill.key, card: (skill) => this.localCard(skill, cx) });
      }
      return cards();
    }

    // Discover
    if (!this.catalog) {
      column.child(this.fetching
        ? this.empty(cx, "compass", "Loading skills from GitHub…", this.fetchProgress)
        : this.empty(cx, "alert", "Discover could not load", this.fetchError ?? "No catalog yet."));
      return done();
    }
    const skills = this.catalog.skills.filter((skill) => this.filter.repo === "all" || skill.repo === this.filter.repo);
    const recency = (s) => this.firstSeen[s.id] || Date.parse(s.pushedAt) || 0;
    if (query.trim() || filtered) {
      const results = sortSkills(searchSkills(skills, query), this.sort.discover, recency);
      if (!results.length) {
        column.child(this.empty(cx, "search", "No skills match", "Try another word, or clear the filter."));
        return done();
      }
      groups.push({ id: "results", title: `${results.length} result${results.length === 1 ? "" : "s"}`, detail: "", skills: results,
        key: (skill) => skill.id, card: (skill) => this.remoteCard(skill, "bolt", cx) });
      return cards();
    }
    for (const group of groupDiscover(skills, this.firstSeen)) {
      const ordered = this.sort.discover === "rank" ? group.skills : sortSkills(group.skills, this.sort.discover, recency);
      const iconName = group.id === "recommended" ? "skills" : "bolt";
      groups.push({ id: group.id, title: group.title, detail: "", skills: ordered,
        key: (skill) => skill.id, card: (skill) => this.remoteCard(skill, iconName, cx) });
    }
    return cards();
  }

  renderNotices(cx) {
    const colors = cx.theme().colors;
    const rows = [];
    const notice = (id, iconName, text, action) =>
      h_flex()
        .mt(20)
        .flex_wrap()
        .gap(10)
        .px(12)
        .py(9)
        .items_center()
        .rounded(8)
        .border(1)
        .border_color(colors.border)
        .bg(colors.muted)
        .text_size(13)
        .child(div().text_color(colors.muted_foreground).child(icon(iconName, 15)))
        .child(div().flex_grow(1).flex_basis(200).min_w_0().child(text))
        .when(Boolean(action), (el) => el.child(action));

    const errorNotice = (id, summary, details, action) => {
      const expanded = Boolean(this.noticeDetails[id]);
      return v_flex().child(notice(id, "alert", summary,
        h_flex().flex_wrap().gap(8).items_center()
          .child(button(`${id}-details-toggle`, expanded ? "Hide details" : "View details", (cx) => {
            this.noticeDetails[id] = !expanded;
            cx.notify();
          }, cx, { small: true }))
          .child(action)))
        .when(expanded, (el) => el.child(v_flex()
          .id(`${id}-error-details`)
          .max_h(180)
          .overflow_y_scrollbar()
          .px(12).py(10).gap(8)
          .text_size(12).text_color(colors.muted_foreground)
          .children(details.map((detail) => div().child(detail)))));
    };

    if (this.tab === "installed" && this.scanError) rows.push(errorNotice("scan", `${this.scanProblemCount} folder${this.scanProblemCount === 1 ? " is" : "s are"} unavailable. Other folders are shown below.`,
      this.scanError.split(" · "), button("rescan", "Rescan", (cx) => this.rescan(cx), cx, { small: true })));
    if (this.tab === "discover") {
      if (this.fetching && this.catalog) rows.push(notice("fetch", "refresh", this.fetchProgress, null));
      else if (this.fetchError && this.catalog) rows.push(errorNotice("fetch", "Could not refresh all Discover sources. Showing available skills.",
        this.fetchError.split(" · "), button("retry", "Retry", (cx) => this.refreshCatalog(cx), cx, { small: true })));
      else if (this.catalog) rows.push(
        h_flex().mt(16).flex_wrap().gap(6).text_size(12).text_color(colors.muted_foreground)
          .child(`${this.catalog.skills.length} skills from ${SOURCES.map((s) => s.repo).join(", ")} · updated ${relativeTime(this.catalog.fetchedAt)}`)
          .child(Button.new("refresh-link").cursor_pointer().text_color(colors.foreground).hover((s) => s.opacity(0.7))
            .on_click((_e, cx) => this.refreshCatalog(cx)).child("Refresh")),
      );
    }
    return v_flex().children(rows);
  }

  /**
   * Group headings and rows of cards in one virtual list, so only the rows on
   * screen are built. The column count follows the window width, as the
   * wrapping grid it replaces did; a short last row keeps cards the same width.
   * @param {CardGroup[]} groups
   */
  cardList(cx, groups) {
    let width = 1200;
    try { width = window.viewport_size().width; } catch {}
    // Rail, the panel's right margin and border, and the column's padding.
    const content = width - 56 - 8 - 2 - 64;
    const columns = Math.max(1, Math.floor((content + CARD_GAP) / (CARD_BASIS + CARD_GAP)));
    /** @type {{ key: string, size: number, render: () => any }[]} */
    const rows = [];
    for (const group of groups) {
      rows.push({ key: `group-${group.id}`, size: GROUP_HEADING, render: () => this.groupHeading(cx, group.title, group.detail) });
      for (let i = 0; i < group.skills.length; i += columns) {
        const slice = group.skills.slice(i, i + columns);
        rows.push({
          key: `cards-${group.id}-${group.key(slice[0])}`,
          size: CARD_HEIGHT + CARD_GAP,
          render: () => h_flex().w_full().px(32).pt(CARD_GAP).gap(CARD_GAP).items_stretch()
            .children(slice.map(group.card))
            .children(Array.from({ length: columns - slice.length }, () => cardSlot())),
        });
      }
    }
    rows.push({ key: "end", size: 32, render: () => div() });
    const id = `skills-${this.tab}`;
    return div()
      .relative()
      .flex_1()
      .min_h_0()
      .child(v_virtual_list(id, rows.length, rows.map((row) => row.size), (index) => rows[index].key,
        (range) => rows.slice(range.start, range.end).map((row) => row.render())).size_full())
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  /** A short group of cards that wrap as the window changes width. */
  group(cx, title, detail, cards) {
    return v_flex()
      .mt(44)
      .gap(24)
      .child(
        h_flex()
          .gap(10)
          .items_baseline()
          .flex_wrap()
          .child(muted(title, cx, 15))
          .when(Boolean(detail), (el) => el.child(div().text_size(12).text_color(palette.subtle).child(detail))),
      )
      .child(h_flex().w_full().flex_wrap().gap(CARD_GAP).items_stretch().children(cards));
  }

  groupHeading(cx, title, detail) {
    return h_flex()
      .w_full()
      .h(GROUP_HEADING)
      .px(32)
      .gap(10)
      .items_end()
      .child(muted(title, cx, 15))
      .when(Boolean(detail), (el) => el.child(div().min_w_0().truncate().text_size(12).text_color(palette.subtle).child(detail)));
  }

  /** The shared card frame. */
  card(id, cx, iconName, title, action, description, footer, onOpen, dimmed = false) {
    const colors = cx.theme().colors;
    return div()
      .id(id)
      .flex_grow(1)
      .flex_shrink(1)
      .flex_basis(CARD_BASIS)
      .min_w_0()
      .h(CARD_HEIGHT)
      .flex()
      .flex_col()
      .p(16)
      .rounded(10)
      .border(1)
      .border_color(colors.border)
      .bg(colors.surface)
      .cursor_pointer()
      .hover((s) => s.border_color("#d2d2d2").shadow_sm())
      .on_click((_event, cx) => onOpen(cx))
      .child(
        h_flex()
          .w_full()
          .gap(10)
          .items_center()
          .child(div().text_color(colors.foreground).when(dimmed, (el) => el.opacity(0.45)).child(icon(iconName, 16)))
          .child(div().flex_1().min_w_0().truncate().text_size(16).font_medium().when(dimmed, (el) => el.text_color(colors.muted_foreground)).child(title))
          .child(action),
      )
      .child(
        div()
          .w_full()
          .mt(12)
          .h(48)
          .overflow_hidden()
          .text_size(14)
          .line_height(px24())
          .text_color(colors.muted_foreground)
          .child(description),
      )
      .child(div().flex_1())
      .child(footer.w_full());
  }

  // Card controls carry no tooltips: inside the virtual list, a tooltip stays
  // on screen after a scroll has moved its control away.

  /** @param {LocalSkill} skill */
  localCard(skill, cx) {
    const busy = this.busy[skill.key];
    const action = busy
      ? h_flex().gap(6).items_center().child(new Spinner().size("small")).child(muted(busy, cx, 12))
      : skill.error
        ? pill("Unreadable", cx, "danger")
        : new Switch(`enable-${skill.key}`)
            .size("small")
            .checked(skill.enabled)
            .on_change((checked, cx) => this.toggle(skill, checked, cx));
    const tags = [];
    if (skill.linked) tags.push(pill("Linked", cx));
    if (!skill.enabled && !skill.error) tags.push(pill("Disabled", cx, "warning"));
    const footer = h_flex()
      .gap(8)
      .flex_wrap()
      .items_center()
      .child(byline(skill.rootLabel, cx, "in"))
      .children(tags)
      .child(div().flex_1())
      .child(div().text_size(12).text_color(palette.subtle).child(relativeTime(skill.mtime)));
    return this.card(
      `local-${skill.key}`, cx, "skills", skill.name, action,
      truncate(skill.error ?? (skill.description || "No description in SKILL.md."), 100),
      footer, (cx) => this.openDetail(skill, cx), !skill.enabled || Boolean(skill.error),
    );
  }

  /** @param {RemoteSkill} skill */
  remoteCard(skill, iconName, cx) {
    const colors = cx.theme().colors;
    const busy = this.busy[skill.id];
    const installed = this.installedIn(skill);
    const everywhere = agentRoots.length > 0 && agentRoots.every((root) => installed.some((l) => l.rootId === root.id));
    const action = busy
      ? h_flex().gap(6).items_center().child(new Spinner().size("small")).child(muted(busy, cx, 12))
      : everywhere
        ? div().flex().items_center().justify_center().size(26).rounded(6).bg(colors.muted).text_color(palette.success).child(icon("check", 15))
        : iconButton(`install-${skill.id}`, "plus", (cx) => this.openInstall(skill, cx), cx);
    const footer = h_flex()
      .gap(8)
      .items_center()
      .child(byline(skill.author, cx, ""))
      .child(div().flex_1())
      // A long list of folders shortens rather than spilling past the card.
      .when(installed.length > 0, (el) => el.child(pill(`Installed${agentRoots.length > 1 ? ` · ${installed.map((l) => l.rootLabel).join(", ")}` : ""}`, cx, "success")
        .flex_shrink(1).min_w_0().truncate()));
    return this.card(`remote-${skill.id}`, cx, iconName, skill.name, action, truncate(skill.description || "No description.", 100), footer,
      (cx) => this.openDialog({ kind: "remote", skill }, cx));
  }

  empty(cx, iconName, title, text) {
    const colors = cx.theme().colors;
    return v_flex()
      .mt(44)
      .py(56)
      .px(24)
      .gap(10)
      .items_center()
      .rounded(10)
      .border(1)
      .border_dashed()
      .border_color(colors.input)
      .child(div().text_color(colors.muted_foreground).child(icon(iconName, 22)))
      .child(div().text_size(15).font_medium().child(title))
      .child(div().max_w(520).text_center().text_size(13).text_color(colors.muted_foreground).child(text));
  }

  /** A press-to-open list of choices. */
  menu(id, trigger, open, setOpen, sections, cx) {
    const colors = cx.theme().colors;
    return Popover.new(id)
      .anchor("top_right")
      .open(open)
      .on_open_change((value, cx) => {
        setOpen(value);
        cx.notify();
      })
      .trigger(trigger)
      .content(
        v_flex()
          .id(`${id}-choices`)
          .w(220)
          .max_h(360)
          .overflow_y_scrollbar()
          .mt(6)
          .p(6)
          .rounded(9)
          .border(1)
          .border_color(colors.border)
          .bg(colors.surface)
          .shadow_lg()
          .children(sections.flatMap((section, sectionIndex) => [
            div().px(8).pt(sectionIndex ? 10 : 4).pb(4).text_size(11).text_color(colors.muted_foreground).child(section.title),
            ...section.options.map((option) =>
              div().id(`${id}-${section.id}-${option.id}`)
                .flex()
                .items_center()
                .gap(8)
                .h(30)
                .px(8)
                .rounded(6)
                .text_size(13)
                .cursor_pointer()
                .hover((s) => s.bg(colors.accent))
                .on_click((_event, cx) => {
                  section.select(option.id);
                  setOpen(false);
                  cx.notify();
                })
                .child(div().w(15).text_color(colors.foreground).when(option.id === section.value, (el) => el.child(icon("check", 14))))
                .child(option.label)),
          ])),
      );
  }

  toolbarButton(id, iconName, label, active, cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .id(id)
      .gap(6)
      .h(32)
      .px(10)
      .items_center()
      .rounded(7)
      .border(1)
      .border_color(active ? colors.ring : colors.input)
      .text_size(14)
      .cursor_pointer()
      .text_color(active ? colors.foreground : colors.muted_foreground)
      .hover((s) => s.bg(colors.muted))
      .child(icon(iconName, 15))
      .child(label);
  }

  renderFilter(cx, active) {
    const sections = this.tab === "installed"
      ? [
          { id: "root", title: "Folder", value: this.filter.root, select: (v) => (this.filter.root = v),
            options: [{ id: "all", label: "Any folder" }, ...agentRoots.map((r) => ({ id: r.id, label: r.label }))] },
          { id: "status", title: "Status", value: this.filter.status, select: (v) => (this.filter.status = v), options: STATUS_FILTERS },
        ]
      : [
          { id: "repo", title: "Source", value: this.filter.repo, select: (v) => (this.filter.repo = v),
            options: [{ id: "all", label: "Any source" }, ...SOURCES.map((s) => ({ id: s.repo, label: `${s.author} · ${s.repo}` }))] },
        ];
    return this.menu("filter", this.toolbarButton("filter-trigger", "filter", active ? "Filtered" : "Filter", active, cx),
      this.filterOpen, (v) => (this.filterOpen = v), sections, cx);
  }

  renderSort(cx) {
    const key = this.tab;
    const options = key === "discover"
      ? [{ id: "rank", label: "Group ranking" }, ...SORTS.map((s) => (s.id === "recent" ? { ...s, label: "Recently added" } : s))]
      : SORTS;
    const current = options.find((s) => s.id === this.sort[key]);
    const fallback = key === "discover" ? "rank" : "name";
    return this.menu("sort", this.toolbarButton("sort-trigger", "sort", current && current.id !== fallback ? current.label : "Sort", false, cx),
      this.sortOpen, (v) => (this.sortOpen = v),
      [{ id: "by", title: "Sort by", value: this.sort[key], options, select: (v) => { this.sort[key] = v; this.savePrefs(); } }], cx);
  }

  // --- Trash page -----------------------------------------------------------

  renderTrash(cx) {
    const column = this.pageColumn(cx, "Trash", "Uninstalled skills stay here until you delete them for good", []);
    if (this.trash.length === 0) {
      column.child(this.empty(cx, "trash", "Trash is empty", "Uninstalling a skill moves it here, so it can be restored."));
      return column;
    }
    const cards = this.trash.map((entry) => {
      const busy = this.busy[`trash-${entry.id}`];
      const footer = h_flex()
        .gap(8)
        .items_center()
        .child(byline(entry.rootLabel, cx, "from"))
        .when(entry.kind === "link", (el) => el.child(pill("Link", cx)))
        .child(div().flex_1())
        .child(div().text_size(12).text_color(palette.subtle).child(relativeTime(entry.trashedAt)));
      const action = busy
        ? h_flex().gap(6).child(new Spinner().size("small")).child(muted(busy, cx, 12))
        : h_flex()
            .gap(6)
            .child(iconButton(`restore-${entry.id}`, "restore", (cx) => this.operate(`trash-${entry.id}`, "Restoring", cx,
              () => restoreSkill(deps, entry), () => `${entry.name} restored to ${entry.rootLabel}`), cx, { tooltip: "Restore" }))
            .child(iconButton(`purge-${entry.id}`, "trash", (cx) => this.openDialog({ kind: "purge", entry }, cx), cx, {
              tooltip: "Delete forever", color: cx.theme().colors.destructive,
            }));
      return this.card(`trash-${entry.id}`, cx, "skills", entry.name, action,
        `Was at ${show(entry.path)}${entry.kind === "link" ? ` → ${entry.target}` : ""}`, footer, () => {}, true);
    });
    column.child(this.group(cx, `${this.trash.length} uninstalled`, "Restore puts a skill back where it was", cards));
    return column;
  }

  // --- Folders page ---------------------------------------------------------

  renderFolders(cx) {
    const colors = cx.theme().colors;
    const column = this.pageColumn(cx, "Folders", "Where Skills looks for agent skills, and what it may touch", [
      button("rescan-folders", this.scanning ? "Scanning…" : "Rescan", (cx) => this.rescan(cx), cx, { icon: "refresh" }),
    ]);
    const row = (iconName, title, detail, right) =>
      h_flex()
        .gap(14)
        .px(16)
        .py(14)
        .items_center()
        .border_b(1)
        .border_color(colors.border)
        .child(div().text_color(colors.muted_foreground).child(icon(iconName, 16)))
        .child(v_flex().flex_1().min_w_0().gap(3).child(div().text_size(14).font_medium().child(title)).child(muted(detail, cx, 13)))
        .child(right);
    const list = v_flex().mt(40).rounded(10).border(1).border_color(colors.border).overflow_hidden();
    if (agentRoots.length === 0) {
      list.child(row("alert", "No agent folders granted",
        "Check access to the agent folders listed in gpui-shell.json.",
        div()));
    }
    for (const root of agentRoots) {
      const count = this.local.filter((s) => s.rootId === root.id).length;
      list.child(row("folder", `${root.label}`, `${show(root.path)} · read and write`, mark(root.label, 20).when(true, (el) => el)).child(
        div().w(80).text_right().text_size(13).text_color(colors.muted_foreground).child(`${count} skill${count === 1 ? "" : "s"}`)));
    }
    for (const path of importRoots) list.child(row("import", "Import source", `${show(path)} · read only`, div()));
    list.child(row("trash", "Trash and cache", `${deps.store ? show(deps.store) : "The app's own data folder"} · the only place anything is deleted`, div().text_size(13).text_color(colors.muted_foreground).child(`${this.trash.length} in trash`)));
    list.child(row("compass", "Network", `GET only: api.github.com/repos/… and raw.githubusercontent.com/… for ${SOURCES.map((s) => s.repo).join(", ")}`, div()));
    column.child(list);
    column.child(div().mt(16).text_size(12).text_color(palette.subtle).child(
      "Disabling renames SKILL.md to SKILL.md.disabled. Uninstalling moves the skill into the trash; a linked skill is removed as a link and its target is kept."));
    return column;
  }

  // --- Dialogs --------------------------------------------------------------

  renderDialog(cx) {
    const state = this.dialog;
    if (!state) return div();
    switch (state.kind) {
      case "detail": return this.detailDialog(state, cx);
      case "remote": return this.remoteDialog(state, cx);
      case "install": return this.installDialog(state, cx);
      case "uninstall": return this.confirmDialog(cx, "Uninstall skill?",
        `${state.skill.name} will be moved from ${show(state.skill.path)} to the trash.${state.skill.linked ? " It is a link: only the link is removed, its target folder stays." : ""} You can restore it from Trash.`,
        "Uninstall", () => this.operate(state.skill.key, "Uninstalling", cx, () => trashSkill(deps, state.skill), () => `${state.skill.name} moved to Trash`));
      case "purge": return this.confirmDialog(cx, "Delete forever?",
        `${state.entry.name} will be removed from the trash. This cannot be undone.`,
        "Delete forever", () => this.operate(`trash-${state.entry.id}`, "Deleting", cx, () => deleteForever(deps, state.entry), () => `${state.entry.name} deleted`));
      case "create": return this.createDialog(state, cx);
      case "import": return this.importDialog(state, cx);
      default: return div();
    }
  }

  frame(cx, title, subtitle, body, footer, width = 560) {
    const colors = cx.theme().colors;
    return v_flex()
      .w(width)
      .max_w("100%")
      .rounded(12)
      .border(1)
      .border_color(colors.border)
      .bg(colors.surface)
      .shadow_lg()
      .overflow_hidden()
      .child(
        h_flex()
          .px(20)
          .pt(18)
          .pb(4)
          .gap(10)
          .items_start()
          .child(v_flex().flex_1().min_w_0().gap(4).child(div().text_size(17).font_medium().child(title)).when(Boolean(subtitle), (el) => el.child(muted(subtitle, cx, 13))))
          .child(iconButton("dialog-close", "close", (cx) => this.closeDialog(cx), cx, { size: 28 })),
      )
      .child(v_flex().px(20).py(14).gap(12).child(body))
      .child(h_flex().flex_wrap().px(20).py(14).gap(10).justify_end().border_t(1).border_color(colors.border).bg(colors.secondary).children(footer));
  }

  errorLine(text, cx) {
    return h_flex().gap(8).items_center().text_size(13).text_color(cx.theme().colors.destructive)
      .child(icon("alert", 14)).child(div().flex_1().min_w_0().child(text));
  }

  confirmDialog(cx, title, text, action, run) {
    return this.frame(cx, title, "", div().text_size(14).child(text), [
      button("confirm-cancel", "Cancel", (cx) => this.closeDialog(cx), cx),
      button("confirm-go", action, (cx) => {
        this.closeDialog(cx);
        run();
        cx.notify();
      }, cx, { danger: true }),
    ], 460);
  }

  detailDialog(state, cx) {
    /** @type {LocalSkill} */
    const skill = state.skill;
    const colors = cx.theme().colors;
    const info = (label, value) => h_flex().gap(12).text_size(13).child(div().w(72).text_color(colors.muted_foreground).child(label)).child(div().flex_1().min_w_0().child(value));
    const body = v_flex()
      .gap(12)
      .child(info("Folder", show(skill.path)))
      .when(skill.linked, (el) => el.child(info("Links to", show(skill.dir))))
      .child(info("Status", skill.error ? "Unreadable" : skill.enabled ? "Enabled" : "Disabled (SKILL.md.disabled)"))
      .when(Boolean(skill.mtime), (el) => el.child(info("Modified", `${new Date(skill.mtime).toLocaleString()} (${relativeTime(skill.mtime)})`)))
      .child(
        div()
          .id("skill-text")
          .mt(4)
          .max_h(380)
          .overflow_y_scrollbar()
          .p(12)
          .rounded(8)
          .border(1)
          .border_color(colors.border)
          .bg(colors.secondary)
          .text_size(12)
          .font_family("Menlo")
          .line_height(px18())
          .whitespace_normal()
          .child(state.error ?? skill.error ?? (state.text == null ? "Reading SKILL.md…" : state.text.length > 12000 ? state.text.slice(0, 12000) + "\n…" : state.text)),
      );
    const footer = [
      button("detail-uninstall", "Uninstall…", (cx) => this.openDialog({ kind: "uninstall", skill }, cx), cx, { icon: "trash" }),
      div().flex_1(),
      button("detail-close", "Close", (cx) => this.closeDialog(cx), cx),
    ];
    if (!skill.error) {
      footer.splice(1, 0, button("detail-toggle", skill.enabled ? "Disable" : "Enable", (cx) => {
        this.closeDialog(cx);
        this.toggle(skill, !skill.enabled, cx);
      }, cx, { icon: skill.enabled ? "pause" : "play" }));
    }
    return this.frame(cx, skill.name, skill.description, body, footer, 680);
  }

  remoteDialog(state, cx) {
    /** @type {RemoteSkill} */
    const skill = state.skill;
    const colors = cx.theme().colors;
    const size = skill.files.reduce((sum, f) => sum + f.size, 0);
    const installed = this.installedIn(skill);
    const body = v_flex()
      .gap(12)
      .child(div().text_size(14).line_height(px22()).child(skill.description || "No description."))
      .child(h_flex().gap(16).items_center()
        .child(byline(skill.author, cx))
        .child(muted(`${skill.repo}/${skill.path}`, cx, 13)))
      .child(muted(`${skill.files.length} file${skill.files.length === 1 ? "" : "s"} · ${formatBytes(size)} · repository ★ ${skill.stars.toLocaleString()}`, cx, 13))
      .when(installed.length > 0, (el) => el.child(div().text_size(13).text_color(palette.success).child(`Installed in ${installed.map((l) => `${l.rootLabel} (${show(l.path)})`).join(", ")}`)))
      .child(v_flex().p(10).gap(3).rounded(8).bg(colors.secondary).border(1).border_color(colors.border)
        .children(skill.files.slice(0, 14).map((f) => h_flex().gap(8).text_size(12).font_family("Menlo")
          .child(div().flex_1().min_w_0().truncate().child(f.path)).child(div().text_color(colors.muted_foreground).child(formatBytes(f.size)))))
        .when(skill.files.length > 14, (el) => el.child(muted(`and ${skill.files.length - 14} more`, cx, 12))));
    return this.frame(cx, skill.name, `by ${skill.author}`, body, [
      button("remote-github", "View on GitHub", (cx) => cx.open_url(`https://github.com/${skill.repo}/tree/${SOURCES.find((s) => s.repo === skill.repo)?.branch ?? "main"}/${skill.path}`), cx, { icon: "external" }),
      div().flex_1(),
      button("remote-install", "Install…", (cx) => this.openInstall(skill, cx), cx, { icon: "plus", primary: true, disabled: agentRoots.length === 0 }),
    ], 620);
  }

  /** Radio rows choosing an agent folder. */
  rootPicker(state, cx, disabledFor = () => "") {
    const colors = cx.theme().colors;
    if (agentRoots.length === 0) return this.errorLine("No agent folders are granted. Check the file permissions in gpui-shell.json.", cx);
    return h_flex().id("root-picker").flex_wrap().max_h(200).overflow_y_scrollbar().gap(8).children(agentRoots.map((root) => {
      const reasonText = disabledFor(root);
      const selected = state.root === root.id;
      return div().id(`root-${root.id}`)
        .flex_grow(1)
        .flex_basis(180)
        .min_w_0()
        .flex()
        .items_center()
        .gap(10)
        .px(12)
        .py(9)
        .rounded(8)
        .border(1)
        .border_color(selected ? colors.primary : colors.border)
        .when(!reasonText, (el) => el.cursor_pointer().on_click((_e, cx) => {
          state.root = root.id;
          this.refreshDialog(cx);
        }))
        .when(Boolean(reasonText), (el) => el.opacity(0.5))
        .child(div().size(14).rounded_full().border(selected ? 4 : 1).border_color(selected ? colors.primary : colors.ring))
        .child(mark(root.label))
        .child(v_flex().flex_1().min_w_0().child(div().text_size(14).child(root.label)).child(muted(reasonText || show(root.path), cx, 12).truncate()));
    }));
  }

  installDialog(state, cx) {
    /** @type {RemoteSkill} */
    const skill = state.skill;
    const size = skill.files.reduce((sum, f) => sum + f.size, 0);
    const taken = (root) => (this.local.some((l) => l.rootId === root.id && l.dirName === skill.dirName) ? "Already installed here" : "");
    const root = agentRoots.find((r) => r.id === state.root);
    const blocked = !root || Boolean(taken(root)) || Boolean(state.progress);
    const body = v_flex()
      .gap(12)
      .child(div().text_size(14).child(`Downloads ${skill.files.length} file${skill.files.length === 1 ? "" : "s"} (${formatBytes(size)}) from ${skill.repo} into:`))
      .child(this.rootPicker(state, cx, taken))
      .when(Boolean(root), (el) => el.child(muted(`Destination: ${show(`${root.path}/${skill.dirName}`)}`, cx, 12)))
      .when(Boolean(state.progress), (el) => el.child(h_flex().gap(8).items_center().child(new Spinner().size("small")).child(muted(state.progress, cx, 13))))
      .when(Boolean(state.error), (el) => el.child(this.errorLine(state.error, cx)));
    return this.frame(cx, `Install ${skill.name}?`, "Skills run with your agent's permissions. Review the files before using it.", body, [
      button("install-cancel", "Cancel", (cx) => this.closeDialog(cx), cx),
      button("install-go", state.progress ? "Installing…" : "Install", (cx) => {
        state.progress = "Starting…";
        state.error = null;
        state.busy = true;
        this.busy[skill.id] = "Installing";
        this.refreshDialog(cx);
        cx.spawn(async (cx) => {
          try {
            const dest = await installRemote(deps, skill, root, SOURCES, (done, total) => {
              state.progress = `Downloaded ${done} of ${total} files…`;
              if (this.dialog === state) this.refreshDialog(cx);
            });
            if (this.dialog === state) this.closeDialog(cx);
            this.toast(`${skill.name} installed`, "success", show(dest), cx);
          } catch (error) {
            state.progress = "";
            state.error = reason(error);
            if (this.dialog === state) this.refreshDialog(cx);
          }
          state.busy = false;
          delete this.busy[skill.id];
          this.rescan(cx);
        });
      }, cx, { primary: true, disabled: blocked }),
    ]);
  }

  field(label, control, hint, cx) {
    const colors = cx.theme().colors;
    return v_flex().gap(6)
      .child(div().text_size(13).font_medium().child(label))
      .child(div().px(10).py(7).rounded(7).border(1).border_color(colors.input).text_size(14).child(control))
      .when(Boolean(hint), (el) => el.child(muted(hint, cx, 12)));
  }

  createDialog(state, cx) {
    const name = this.form.name.value().trim();
    const body = v_flex()
      .gap(14)
      .child(this.field("Name", Input.new(this.form.name), "Lowercase letters, digits and hyphens. It becomes the folder name.", cx))
      .child(this.field("Description", Input.new(this.form.description), "Agents read this to decide when to use the skill.", cx))
      .child(this.field("Instructions", Textarea.new(this.form.body).h(120), "Markdown. Leave empty for a starter outline.", cx))
      .child(div().text_size(13).font_medium().child("Save to"))
      .child(this.rootPicker(state, cx))
      .when(Boolean(state.error), (el) => el.child(this.errorLine(state.error, cx)));
    return this.frame(cx, "Add skill", "Creates a folder with a SKILL.md", body, [
      button("create-cancel", "Cancel", (cx) => this.closeDialog(cx), cx),
      button("create-go", "Create skill", (cx) => {
        const root = agentRoots.find((r) => r.id === state.root);
        const skill = {
          name: this.form.name.value().trim(),
          description: this.form.description.value(),
          body: this.form.body.value(),
        };
        cx.spawn(async (cx) => {
          try {
            const path = await createSkill(deps, root, skill);
            this.closeDialog(cx);
            this.toast(`${skill.name} created`, "success", show(path), cx);
            this.rescan(cx);
          } catch (error) {
            state.error = reason(error);
            if (this.dialog === state) this.refreshDialog(cx);
          }
        });
      }, cx, { primary: true, disabled: !agentRoots.length || !name }),
    ], 620);
  }

  importDialog(state, cx) {
    const allowed = [...agentRoots.map((r) => r.path), ...importRoots];
    const body = v_flex()
      .gap(14)
      .child(this.field("Skill folder", Input.new(this.form.path),
        `An absolute path to a folder containing SKILL.md. Readable locations: ${allowed.map(show).join(", ") || "none"}.`, cx))
      .child(div().text_size(13).font_medium().child("Copy into"))
      .child(this.rootPicker(state, cx))
      .when(Boolean(state.error), (el) => el.child(this.errorLine(state.error, cx)));
    return this.frame(cx, "Import skill", "Copies a skill folder into an agent folder", body, [
      button("import-cancel", "Cancel", (cx) => this.closeDialog(cx), cx),
      button("import-go", "Import", (cx) => {
        const root = agentRoots.find((r) => r.id === state.root);
        let source = this.form.path.value().trim();
        if (source.startsWith("~/") && home) source = home + source.slice(1);
        cx.spawn(async (cx) => {
          try {
            const path = await importSkill(deps, source, root);
            this.closeDialog(cx);
            this.toast("Skill imported", "success", show(path), cx);
            this.rescan(cx);
          } catch (error) {
            state.error = reason(error);
            if (this.dialog === state) this.refreshDialog(cx);
          }
        });
      }, cx, { primary: true, disabled: !agentRoots.length }),
    ], 600);
  }
}

const px24 = () => "24px";
const px22 = () => "22px";
const px18 = () => "18px";
