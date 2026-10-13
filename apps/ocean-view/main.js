// @ts-check
import { View, div, image, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState } from "gpui-base";
import { mkdir, writeFile } from "fs/promises";
import { applyTheme, palette } from "./theme.js";
import { icon, muted, chip, dot, bar, card, link, tones } from "./ui.js";
import { liveMap, fitFleet, mercY, MIN_SPAN, MAX_SPAN, MERC_LIMIT } from "./map.js";
import { formatLat, formatLon, pathLength } from "./geo.js";
import { nodes, ports, plan } from "./ports.js";
import {
  seedFleet, advance, navigation, status, fuelPct, burnRate, assignRoute,
  currentPort, unread, report, utc, RULES, SAMPLE_HOURS,
} from "./sim.js";

const storageKey = "oceanview.fleet.v1";
const settingsKey = "oceanview.settings.v1";
const reportsKey = "oceanview.reports.v1";
/** Simulated seconds per real second. */
const SCALES = [1, 60, 600, 3600];
const WINDOWS = [6, 24, 72];
/** While the app is closed the fleet keeps sailing in real time, up to this long. */
const MAX_CATCH_UP_HOURS = 24 * 30;
const SIDEBAR_WIDTH = 232;
const TOP_BAR_HEIGHT = 60;

const nav = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "fleet", label: "Fleet", icon: "fleet" },
  { id: "tracking", label: "Live Tracking", icon: "pin" },
  { id: "reports", label: "Reports", icon: "reports" },
  { id: "alerts", label: "Alerts", icon: "bell" },
  { id: "settings", label: "Settings", icon: "settings" },
];

const alertTone = { error: "red", warning: "amber", info: "blue", success: "green" };

export default class OceanView extends View {
  init(_props, cx) {
    applyTheme();
    this.fleet = this.load();
    const settings = this.readJson(settingsKey) ?? {};
    this.scale = SCALES.includes(settings.scale) ? settings.scale : 600;
    this.selected = settings.selected ?? "aurora";
    this.page = "overview";
    /** Longitude span of the map while it follows the selected vessel. */
    this.span = 45;
    this.follow = true;
    /** The map window once panned or zoomed away from the vessel: Mercator centre and span. */
    this.free = /** @type {{ x: number, y: number, span: number } | null} */ (null);
    /** The press that may become a pan, and whether it has moved far enough to be one. */
    this.drag = /** @type {{ x: number, y: number, view: any } | null} */ (null);
    this.dragMoved = false;
    this.mapBounds = null;
    /** The open dropdown: "mode", "trail" or "account". */
    this.menu = /** @type {string | null} */ (null);
    this.reportIndex = 0;
    this.trailHours = 24;
    /** @type {{ vessel: string, from: string, to: string } | null} */
    this.routeDialog = null;
    /** @type {{ name: string, time: number, text: string }[]} */
    this.reports = this.readJson(reportsKey) ?? [];
    this.query = "";
    this.ticks = 0;
    this.search = InputState.new({ placeholder: "Search ships, ports, or ID..." });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value().trim().toLowerCase();
      cx.notify();
    });
    cx.timer.every(1000, (cx) => {
      advance(this.fleet, this.scale / 3600);
      if (++this.ticks % 5 === 0) this.save();
      cx.notify();
    });
  }

  // ------------------------------------------------------------ persistence

  readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  }

  /** The saved fleet, sailed forward by the real time that passed since it was saved. */
  load() {
    const saved = this.readJson(storageKey);
    if (saved?.fleet?.version === 1) {
      const hours = Math.min(MAX_CATCH_UP_HOURS, Math.max(0, (Date.now() - saved.savedAt) / 3_600_000));
      return advance(saved.fleet, hours);
    }
    return seedFleet();
  }

  save() {
    localStorage.setItem(storageKey, JSON.stringify({ savedAt: Date.now(), fleet: this.fleet }));
    localStorage.setItem(settingsKey, JSON.stringify({ scale: this.scale, selected: this.selected }));
  }

  vessel() {
    return this.fleet.vessels.find((v) => v.id === this.selected) ?? this.fleet.vessels[0];
  }

  toast(title, description, level = "info") {
    window.push_toast({ title, description, level, timeout: 3500 });
  }

  // ---------------------------------------------------------------- actions

  select(id, cx) {
    this.selected = id;
    this.follow = true;
    this.save();
    cx.notify();
  }

  go(page, cx) {
    this.page = page;
    this.menu = null;
    cx.notify();
  }

  async createReport(cx) {
    const text = report(this.fleet);
    const stamp = new Date(this.fleet.time).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const name = `fleet-report-${stamp}.md`;
    cx.write_to_clipboard(text);
    try {
      // Relative paths resolve inside the app's data directory, the one place the manifest may write.
      await mkdir("reports", { recursive: true });
      await writeFile(`reports/${name}`, text);
      this.toast("Report created", `Saved reports/${name} in the app data folder and copied it to the clipboard.`, "success");
    } catch (error) {
      this.toast("Report copied", `Could not save the file (${error}); the report is on the clipboard.`, "warning");
    }
    this.reports = [{ name, time: this.fleet.time, text }, ...this.reports].slice(0, 20);
    this.reportIndex = 0;
    localStorage.setItem(reportsKey, JSON.stringify(this.reports));
    cx.notify();
  }

  openRouteDialog(cx) {
    const v = this.vessel();
    const from = currentPort(v);
    const to = ports.find((p) => p.id !== from)?.id ?? from;
    this.routeDialog = { vessel: v.id, from, to };
    cx.notify();
  }

  // ---------------------------------------------------------------- render

  render(cx) {
    const colors = cx.theme().colors;
    return h_flex()
      .size_full()
      .relative()
      .bg(colors.background)
      .text_color(colors.foreground)
      .text_size(13)
      .child(this.sidebar(cx))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .child(this.topBar(cx))
          .child(div().flex_1().min_h(0).flex().flex_col().child(this.content(cx))),
      )
      // The account menu belongs to the top bar but is drawn last, so the page below cannot cover it.
      .when(Boolean(this.menu), (el) => el.child(this.openMenu(cx)))
      .when(Boolean(this.routeDialog), (el) => el.child(this.routeOverlay(cx)));
  }

  accountMenu(cx) {
    const alerts = unread(this.fleet);
    return this.dropdown("account-menu", [
            { label: "Settings", run: (cx) => this.go("settings", cx) },
            { label: "Reports", run: (cx) => this.go("reports", cx) },
            { label: `Alerts (${alerts} unread)`, run: (cx) => this.go("alerts", cx) },
            { label: "Copy fleet report", hint: "Markdown", run: (cx) => {
              cx.write_to_clipboard(report(this.fleet));
              this.toast("Fleet report copied", "The current fleet status is on the clipboard as Markdown.");
            } },
          ]);
  }

  sidebar(cx) {
    const colors = cx.theme().colors;
    const alerts = unread(this.fleet);
    const vessels = this.fleet.vessels.filter((v) => {
      if (!this.query) return true;
      const n = navigation(v, this.fleet.time);
      return `${v.name} ${v.imo} ${v.mmsi} ${n.from} ${n.to}`.toLowerCase().includes(this.query);
    });
    const section = (label) => div().px(10).pt(14).pb(6).text_size(11).font_medium().text_color(colors.muted_foreground).child(label);
    const navItem = (item) => {
      const active = this.page === item.id || (item.id === "overview" && this.page === "overview");
      return Button.new(`nav-${item.id}`)
        .flex()
        .items_center()
        .gap(12)
        .h(38)
        .flex_shrink_0()
        .px(12)
        .rounded(8)
        .border(1)
        .border_color(active ? palette.navActiveBorder : "#00000000")
        .bg(active ? palette.navActive : "#00000000")
        .text_color(active ? "#ffffff" : "#c9d3e6")
        .hover((el) => el.bg(active ? palette.navActive : "#131f36"))
        .on_click((_e, cx) => this.go(item.id, cx))
        .child(icon(item.icon, 18))
        .child(div().flex_1().child(item.label))
        .when(item.id === "tracking", (el) => el.child(dot(palette.blue, 7)))
        .when(item.id === "alerts" && alerts > 0, (el) =>
          el.child(div().min_w(20).h(20).px(6).rounded_full().bg(palette.blue).flex().items_center().justify_center().text_size(11).font_semibold().child(String(alerts))));
    };
    const vesselItem = (v) => {
      const active = v.id === this.selected;
      return Button.new(`side-${v.id}`)
        .flex()
        .items_center()
        .gap(12)
        .h(34)
        .px(12)
        .rounded(7)
        .bg(active ? palette.navActive : "#00000000")
        .text_color(active ? "#ffffff" : "#c9d3e6")
        .hover((el) => el.bg(active ? palette.navActive : "#131f36"))
        .on_click((_e, cx) => this.select(v.id, cx))
        .child(icon("fleet", 17).text_color(active ? "#ffffff" : "#9aa8c2"))
        .child(div().flex_1().child(v.name))
        .child(dot(active || status(v).tone !== "green" ? tones[status(v).tone].dot : "#8a96ad"));
    };
    const action = (id, iconName, label, handler) =>
      Button.new(`qa-${id}`)
        .flex()
        .items_center()
        .gap(12)
        .h(38)
        .px(14)
        .rounded(8)
        .border(1)
        .border_color(colors.border)
        .bg("#0d172a")
        .text_color("#d5def0")
        .hover((el) => el.bg("#131f36"))
        .on_click(handler)
        .child(icon(iconName, 17))
        .child(label);

    return v_flex()
      .w(232)
      .h_full()
      .flex_shrink_0()
      .bg(palette.sidebar)
      .border_r(1)
      .border_color(colors.border)
      .px(12)
      .child(div().h(22).flex_shrink_0().window_control_area("drag"))
      .child(
        h_flex()
          .h(44)
          .items_center()
          .gap(10)
          .px(4)
          .window_control_area("drag")
          .child(image("ocean-view/icons/logo.svg").size(30))
          .child(div().text_size(16).font_semibold().child("OceanView")),
      )
      .child(
        v_flex()
          .id("sidebar-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .pb(12)
          .child(v_flex().pt(14).gap(4).children(nav.map(navItem)))
          .child(div().mt(14).h(1).flex_shrink_0().bg(colors.border))
          .child(section(this.query ? `VESSELS · ${vessels.length} of ${this.fleet.vessels.length}` : "VESSELS"))
          .child(
            v_flex()
              .gap(3)
              .children(vessels.map(vesselItem))
              .when(vessels.length === 0, (el) => el.child(div().px(12).py(8).child(muted("No vessels match", cx)))),
          )
          .child(div().mt(14).h(1).flex_shrink_0().bg(colors.border))
          .child(section("QUICK ACTIONS"))
          .child(
        v_flex()
          .gap(8)
          .child(action("route", "send", "New Route", (_e, cx) => this.openRouteDialog(cx)))
          .child(action("report", "doc", "Create Report", (_e, cx) => this.createReport(cx)))
          .child(action("support", "support", "Contact Support", (_e, cx) => {
            cx.write_to_clipboard("support@oceanview.example");
            this.toast("Support address copied", "support@oceanview.example is on the clipboard.");
          })),
          ),
      )
      .when(window.viewport_size().height >= 860, (el) => el.child(div().h(1).flex_shrink_0().bg(colors.border)))
      .when(window.viewport_size().height >= 860, (el) => el.child(
        h_flex()
          .items_center()
          .gap(10)
          .py(14)
          .px(4)
          .child(image("ocean-view/icons/logo.svg").size(34))
          .child(v_flex().flex_1().child(div().font_medium().child("OceanView")).child(muted("Smarter Fleet. Safer Seas.", cx, 10))),
      ));
  }

  topBar(cx) {
    const colors = cx.theme().colors;
    const v = this.vessel();
    const pageLabel = nav.find((n) => n.id === this.page)?.label ?? "Overview";
    const crumbs = this.page === "overview" || this.page === "tracking" ? ["Fleet", "Live Tracking", v.name] : ["Fleet", pageLabel];
    const alerts = unread(this.fleet);
    const compactTop = window.viewport_size().width < 1380;
    return h_flex()
      .h(TOP_BAR_HEIGHT)
      .flex_shrink_0()
      .items_center()
      .gap(20)
      .px(24)
      .border_b(1)
      .border_color(colors.border)
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .self_stretch()
          .items_center()
          .gap(8)
          // Only the empty breadcrumb strip moves the window: a drag area swallows clicks on controls.
          .window_control_area("drag")
          .children(crumbs.flatMap((c, i) => {
            const last = i === crumbs.length - 1;
            const item = div().whitespace_nowrap().text_color(last ? "#ffffff" : "#aab6cc").when(last, (el) => el.font_medium()).child(c);
            return i === 0 ? [item] : [div().text_color("#5f6e8a").child("/"), item];
          })),
      )
      .child(
        Button.new("sim-speed")
          .flex()
          .flex_shrink_0()
          .items_center()
          .gap(8)
          .h(30)
          .px(10)
          .rounded(15)
          .border(1)
          .border_color(colors.border)
          .hover((el) => el.bg("#131f36"))
          .whitespace_nowrap()
          .text_size(12)
          .text_color("#c9d3e6")
          .on_click((_e, cx) => {
            this.scale = SCALES[(SCALES.indexOf(this.scale) + 1) % SCALES.length];
            this.save();
            cx.notify();
          })
          .child(dot(palette.online, 7))
          .child(`System Online · ×${this.scale}`),
      )
      .when(!compactTop, (el) => el.child(div().w(1).h(20).bg(colors.border)))
      .when(!compactTop, (el) => el.child(div().flex_shrink_0().whitespace_nowrap().text_size(12).text_color("#c9d3e6").child(utc(this.fleet.time))))
      .child(
        h_flex()
          .w(compactTop ? 200 : 290)
          .flex_shrink_0()
          .h(36)
          .items_center()
          .gap(8)
          .px(12)
          .rounded(8)
          .border(1)
          .border_color(colors.border)
          .bg(colors.input)
          .child(icon("search", 16).text_color(colors.muted_foreground))
          .child(Input.new(this.search).flex_1().text_size(12)),
      )
      .child(
        Button.new("bell")
          .relative()
          .flex_shrink_0()
          .rounded(8)
          .hover((el) => el.bg("#131f36"))
          .size(32)
          .flex()
          .items_center()
          .justify_center()
          .on_click((_e, cx) => this.go("alerts", cx))
          .child(icon("bell", 20).text_color("#c9d3e6"))
          .when(alerts > 0, (el) => el.child(div().absolute().top(4).right(5).size(8).rounded_full().bg(palette.red))),
      )
      .child(
        div()
          .relative()
          .flex_shrink_0()
          .child(
            Button.new("account")
              .flex()
              .items_center()
              .gap(6)
              .p(2)
              .rounded(18)
              .hover((el) => el.bg("#131f36"))
              .on_click((_e, cx) => {
                this.toggleMenu("account", cx);
              })
              .child(div().size(32).rounded_full().bg("#1d3a74").flex().items_center().justify_center().text_size(12).font_semibold().child("JD"))
              .child(icon("chevron-down", 14).text_color(colors.muted_foreground)),
          )
      );
  }

  content(cx) {
    switch (this.page) {
      case "fleet":
        return this.fleetPage(cx);
      case "alerts":
        return this.alertsPage(cx);
      case "reports":
        return this.reportsPage(cx);
      case "settings":
        return this.settingsPage(cx);
      default:
        return v_flex()
          .flex_1()
          .min_h(0)
          .child(this.mapPanel(cx))
          .when(this.page === "overview", (el) => el.child(this.cards(cx)));
    }
  }

  // -------------------------------------------------------------------- map

  /** Height of the card row under the map; shorter on small windows. */
  cardsHeight() {
    return window.viewport_size().height < 900 ? 270 : 300;
  }

  /** The map's size in pixels: measured from its last pointer event, else estimated from the window. */
  mapSize() {
    const size = window.viewport_size();
    const estimate = {
      width: Math.max(400, size.width - SIDEBAR_WIDTH),
      height: Math.max(240, size.height - TOP_BAR_HEIGHT - (this.page === "overview" ? this.cardsHeight() : 0) - 1),
    };
    const b = this.mapBounds;
    return b && b.page === this.page && Math.abs(b.windowWidth - size.width) < 1 && Math.abs(b.windowHeight - size.height) < 1 ? b : estimate;
  }

  /** The visible map window, following the selected vessel or as left by panning and zooming. */
  mapView() {
    const { width, height } = this.mapSize();
    const aspect = height / width;
    if (this.follow || !this.free) {
      const n = navigation(this.vessel(), this.fleet.time);
      return { cx: n.lon, cy: mercY(n.lat), sx: this.span, sy: this.span * aspect };
    }
    return { cx: this.free.x, cy: this.free.y, sx: this.free.span, sy: this.free.span * aspect };
  }

  setFree(x, span, y) {
    const s = Math.max(MIN_SPAN, Math.min(MAX_SPAN, span));
    this.free = { x: ((((x + 180) % 360) + 360) % 360) - 180, y: Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, y)), span: s };
  }

  /** Zooms by `factor` (below 1 zooms in) about a point given as fractions of the map from its centre. */
  zoomAt(factor, fx, fy, cx) {
    const view = this.mapView();
    const next = Math.max(MIN_SPAN, Math.min(MAX_SPAN, view.sx * factor));
    if (this.follow && fx === 0 && fy === 0) {
      this.span = next;
    } else {
      const mx = view.cx + fx * view.sx;
      const my = view.cy - fy * view.sy;
      const aspect = view.sy / view.sx;
      this.follow = false;
      this.setFree(mx - fx * next, next, my + fy * next * aspect);
      this.span = next;
    }
    cx.notify();
  }

  locate(cx) {
    const view = this.mapView();
    this.span = view.sx;
    this.follow = true;
    cx.notify();
  }

  fitFleet(cx) {
    const { width, height } = this.mapSize();
    const fit = fitFleet(this.fleet, height / width);
    this.follow = false;
    this.setFree(fit.x, fit.span, fit.y);
    cx.notify();
  }

  /** Records the map's measured size, for an exact aspect ratio and pointer maths. */
  measure(bounds) {
    if (!bounds) return;
    const size = window.viewport_size();
    this.mapBounds = { ...bounds, page: this.page, windowWidth: size.width, windowHeight: size.height };
  }

  /**
   * Keeps presses on a panel floating over the map from reaching the map
   * beneath it: without this a press on a menu item also starts a pan and
   * closes the menu before the click completes.
   */
  overMap(el) {
    return el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  }

  /** Press, drag and wheel handlers for the map surface. */
  mapGestures(el) {
    return el
      .on_mouse_down("left", (e, cx) => {
        this.measure(e.bounds);
        this.menu = null;
        const view = this.mapView();
        this.drag = { x: e.position.x, y: e.position.y, view };
        this.dragMoved = false;
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        this.measure(e.bounds);
        const drag = this.drag;
        if (!drag) return;
        const dx = e.position.x - drag.x;
        const dy = e.position.y - drag.y;
        if (!this.dragMoved && Math.hypot(dx, dy) < 4) return;
        this.dragMoved = true;
        const { width, height } = this.mapSize();
        this.follow = false;
        this.setFree(drag.view.cx - (dx / width) * drag.view.sx, drag.view.sx, drag.view.cy + (dy / height) * drag.view.sy);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        this.drag = null;
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (!hovered && this.drag) {
          this.drag = null;
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => {
        this.measure(e.bounds);
        const { width, height } = this.mapSize();
        const local = e.local_position ?? (e.bounds ? { x: e.position.x - e.bounds.x, y: e.position.y - e.bounds.y } : { x: width / 2, y: height / 2 });
        const dy = e.delta_lines ? e.delta_lines.y * 40 : e.delta.y;
        if (!dy) return;
        this.zoomAt(Math.exp(-dy * 0.004), local.x / width - 0.5, local.y / height - 0.5, cx);
      });
  }

  toggleMenu(menu, cx) {
    this.menu = this.menu === menu ? null : menu;
    cx.notify();
  }

  /** Widths of the map's two dropdown buttons, fixed so their menus can be placed under them. */
  overlayWidths() {
    const narrow = this.mapSize().width < 980;
    return { mode: narrow ? 76 : 152, trail: narrow ? 76 : 180 };
  }

  /** The panel of a dropdown menu. */
  dropdown(id, items) {
    return this.overMap(v_flex())
      .min_w(210)
      .p(6)
      .gap(2)
      .rounded(8)
      .bg("#0e1a30")
      .border(1)
      .border_color(palette.labelBorder)
      .shadow_lg()
      .children(items.map((item, i) =>
        Button.new(`${id}-${i}`)
          .flex()
          .items_center()
          .gap(10)
          .h(32)
          .px(10)
          .rounded(6)
          .text_color(item.active ? "#ffffff" : "#c9d3e6")
          .bg(item.active ? palette.navActive : "#00000000")
          .hover((el) => el.bg(item.active ? palette.navActive : "#16264a"))
          .on_click((_e, cx) => {
            this.menu = null;
            item.run(cx);
            cx.notify();
          })
          .child(div().flex_1().whitespace_nowrap().child(item.label))
          .when(Boolean(item.hint), (el) => el.child(div().text_size(11).text_color("#8796b3").child(item.hint)))));
  }

  /**
   * The open dropdown, drawn over the whole window with a transparent
   * backdrop: a press anywhere else closes it, including on the button that
   * opened it, and nothing underneath can paint over the menu.
   */
  openMenu(cx) {
    const backdrop = div()
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.menu = null;
        cx.notify();
      });
    const w = this.overlayWidths();
    const mapTop = TOP_BAR_HEIGHT + 18 + 46;
    let panel;
    if (this.menu === "account") {
      panel = div().absolute().top(54).right(24).child(this.accountMenu(cx));
    } else if (this.menu === "mode") {
      const view = this.mapView();
      panel = div().absolute().top(mapTop).right(20 + 40 + 12 + w.trail + 12).child(this.dropdown("mode-menu", [
        { label: "Follow selected vessel", hint: "Live Map", active: this.follow, run: (cx) => this.locate(cx) },
        { label: "Fit whole fleet", hint: "Fleet View", run: (cx) => this.fitFleet(cx) },
        { label: "Whole world", run: () => { this.follow = false; this.setFree(view.cx, MAX_SPAN, 0); } },
      ]));
    } else if (this.menu === "trail") {
      panel = div().absolute().top(mapTop).right(20 + 40 + 12).child(this.dropdown("trail-menu", WINDOWS.map((h) => ({
        label: `Last ${h} hours`, hint: "track & fuel", active: h === this.trailHours, run: () => { this.trailHours = h; },
      }))));
    } else {
      return div();
    }
    return div().absolute().inset_0().child(backdrop).child(panel);
  }

  mapPanel(cx) {
    const colors = cx.theme().colors;
    const v = this.vessel();
    const n = navigation(v, this.fleet.time);
    const view = this.mapView();
    const st = status(v);
    const { width } = this.mapSize();
    const narrow = width < 980;

    const widths = this.overlayWidths();
    const overlayButton = (id, iconName, label, menu) =>
      div()
        .child(
          Button.new(id)
            .w(widths[menu])
            .flex()
            .justify_between()
            .items_center()
            .gap(10)
            .h(40)
            .px(14)
            .rounded(8)
            .bg(this.menu === menu ? "#132544" : "#0c1a33e6")
            .border(1)
            .border_color(this.menu === menu ? "#3d6fd6" : palette.labelBorder)
            .hover((el) => el.bg("#132544"))
            .on_click((_e, cx) => {
              this.toggleMenu(menu, cx);
            })
            .child(h_flex().items_center().gap(10).child(icon(iconName, 18).text_color("#8fb1ff")).when(!narrow, (el) => el.child(div().whitespace_nowrap().child(label))))
            .child(icon("chevron-down", 14).text_color(colors.muted_foreground)),
        );
    const square = (id, iconName, handler) =>
      Button.new(id)
        .size(40)
        .flex()
        .items_center()
        .justify_center()
        .hover((el) => el.bg("#132544"))
        .on_click(handler)
        .child(icon(iconName, 18).text_color("#d5def0"));
    const widthNm = view.sx * 60 * Math.cos((n.lat * Math.PI) / 180);
    const modeLabel = this.follow ? "Live Map" : "Free View";

    return div()
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .border_b(1)
      .border_color(colors.border)
      .child(
        this.mapGestures(
          div()
            .id("map-surface")
            .absolute()
            .inset_0()
            .when(Boolean(this.drag && this.dragMoved), (el) => el.cursor_grabbing())
            .when(!this.drag || !this.dragMoved, (el) => el.cursor_grab())
            .child(liveMap(this.fleet, { view, selected: v.id, trailHours: this.trailHours, onSelect: (id, cx) => {
              // The release that ends a pan is not a click on the vessel under it.
              if (!this.dragMoved) this.select(id, cx);
            } }, cx)),
        ),
      )
      // Selected vessel
      .child(
        this.overMap(h_flex())
          .absolute()
          .left(22)
          .top(20)
          .gap(14)
          .p(12)
          .pr(16)
          .rounded(10)
          .bg("#0c1a33e6")
          .border(1)
          .border_color(palette.labelBorder)
          .when(!narrow, (el) => el.child(image("ocean-view/icons/vessel-photo.svg").w(108).h(76).rounded(4)))
          .child(
            v_flex()
              .gap(4)
              .child(h_flex().items_center().gap(14).child(div().text_size(16).font_semibold().whitespace_nowrap().child(v.name)).child(chip(st.label, st.tone)))
              .child(muted(`IMO  ${v.imo}  ·  MMSI  ${v.mmsi}`, cx, 12))
              .child(muted(`Next: ${n.nextWaypoint}`, cx, 12)),
          ),
      )
      .child(
        this.overMap(v_flex())
          .absolute()
          .right(20)
          .top(74)
          .rounded(8)
          .bg("#0c1a33e6")
          .border(1)
          .border_color(palette.labelBorder)
          .child(square("zoom-in", "plus", (_e, cx) => this.zoomAt(0.5, 0, 0, cx)))
          .child(div().h(1).bg(palette.labelBorder))
          .child(square("zoom-out", "minus", (_e, cx) => this.zoomAt(2, 0, 0, cx)))
          .child(div().h(1).bg(palette.labelBorder))
          .child(square("locate", "navigate", (_e, cx) => this.locate(cx)).when(this.follow, (el) => el.text_color(palette.blue))),
      )
      // Map controls, after the zoom column so their dropdowns paint over it
      .child(
        this.overMap(h_flex())
          .absolute()
          .top(18)
          .right(20)
          .gap(12)
          .child(overlayButton("map-mode", "map", modeLabel, "mode"))
          .child(overlayButton("trail", "calendar", `Last ${this.trailHours} hours`, "trail"))
          .child(
            Button.new("expand")
              .size(40)
              .flex()
              .items_center()
              .justify_center()
              .rounded(8)
              .bg(this.page === "tracking" ? "#132544" : "#0c1a33e6")
              .border(1)
              .border_color(this.page === "tracking" ? "#3d6fd6" : palette.labelBorder)
              .hover((el) => el.bg("#132544"))
              .on_click((_e, cx) => this.go(this.page === "tracking" ? "overview" : "tracking", cx))
              .child(icon("expand", 18).text_color("#d5def0")),
          ),
      )
      // Position
      .child(
        this.overMap(h_flex())
          .absolute()
          .left(22)
          .bottom(18)
          .items_center()
          .gap(22)
          .pl(10)
          .pr(28)
          .py(10)
          .rounded(10)
          .bg("#0c1a33e6")
          .border(1)
          .border_color(palette.labelBorder)
          .child(compass(n.heading))
          .child(v_flex().gap(4).text_size(14).child(div().whitespace_nowrap().child(formatLat(n.lat))).child(div().whitespace_nowrap().child(formatLon(n.lon)))),
      )
      .child(
        div()
          .absolute()
          .right(20)
          .bottom(14)
          .px(8)
          .py(3)
          .rounded(4)
          .bg("#061a40cc")
          .text_size(10)
          .text_color("#8796b3")
          .child(`${modeLabel} · view ≈ ${widthNm >= 100 ? Math.round(widthNm).toLocaleString("en-US") : widthNm.toFixed(0)} NM wide · drag to pan, scroll to zoom`),
      );
  }

  // ------------------------------------------------------------------ cards

  cards(cx) {
    const colors = cx.theme().colors;
    const v = this.vessel();
    const n = navigation(v, this.fleet.time);
    const label = (text) => muted(text, cx, 12);
    const value = (text) => div().text_size(14).text_color("#e6ecf7").child(text);
    const place = (name) => h_flex().min_w(0).items_center().gap(8).child(icon("pin", 16).text_color(palette.online)).child(value(name).flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis());
    const eta = n.eta ? [utc(n.eta).split(" ").slice(0, 3).join(" "), utc(n.eta, false)] : ["—", v.state === "nofuel" ? "Adrift" : ""];
    const moving = v.state === "underway";
    // Below this width the four cards stack their figures instead of setting them side by side.
    const size = window.viewport_size();
    const compact = size.width - SIDEBAR_WIDTH < 1220 || size.height < 900;

    const route = card(cx, compact, "route", "Route & Position",
      Button.new("route-details").on_click((_e, cx) => this.go("fleet", cx)).child(link(compact ? "Details" : "View Details")),
      v_flex()
        .flex_1()
        .gap(12)
        .when(!compact, (el) => el
          .child(v_flex().gap(8).child(label("From")).child(place(n.from)))
          .child(v_flex().gap(8).child(label("To")).child(place(n.to))))
        .when(compact, (el) => el.child(h_flex().gap(12)
          .child(v_flex().flex_1().min_w(0).gap(6).child(label("From")).child(place(n.from)))
          .child(v_flex().flex_1().min_w(0).gap(6).child(label("To")).child(place(n.to)))))
        .when(!compact, (el) => el.child(
          h_flex()
            .mt(4)
            .gap(18)
            .child(v_flex().flex_1().gap(4).child(label("ETA")).child(value(eta[0])).child(value(eta[1])))
            .child(v_flex().flex_1().gap(4).child(label("Remaining")).child(value(`${Math.round(n.remaining).toLocaleString("en-US")} NM`)))
            .child(v_flex().flex_1().gap(6).child(label("Progress")).child(value(`${n.progress.toFixed(1)}%`)).child(bar(n.progress, palette.online))),
        ))
        .when(compact, (el) => el
          .child(h_flex().gap(12)
            .child(v_flex().flex_1().min_w(0).gap(3).child(label("ETA")).child(value(eta[0])).child(muted(eta[1], cx, 12)))
            .child(v_flex().flex_1().min_w(0).gap(3).child(label("Remaining")).child(value(`${Math.round(n.remaining).toLocaleString("en-US")} NM`))))
          .child(v_flex().gap(6).child(h_flex().justify_between().child(label("Progress")).child(value(`${n.progress.toFixed(1)}%`))).child(bar(n.progress, palette.online)))));

    const speed = card(cx, compact, "gauge", "Speed & Course", null,
      h_flex()
        .flex_1()
        .items_center()
        .gap(compact ? 14 : 26)
        .child(gauge(v.speed, 20, compact ? 104 : 132))
        .child(
          v_flex()
            .gap(compact ? 6 : 10)
            .child(label("Course"))
            .child(h_flex().items_center().gap(14).child(div().text_size(18).child(`${Math.round(n.course)}°`)).child(arrow(n.course)))
            .child(label("Heading"))
            .child(div().text_size(18).child(`${Math.round(n.heading)}°`))
            .child(h_flex().mt(compact ? 2 : 8).items_center().gap(8).child(dot(moving ? palette.online : palette.amber, 9)).child(div().whitespace_nowrap().text_color(moving ? "#4ade80" : "#fbbf24").child(moving ? "Under way" : status(v).label))),
        ));

    const series = this.fleet.history[v.id] ?? [];
    const window_ = series.slice(-Math.round(this.trailHours / SAMPLE_HOURS) - 1);
    const rate = burnRate(v);
    const fuel = card(cx, compact, "fuel", "Fuel & Consumption",
      Button.new("fuel-details").on_click((_e, cx) => this.go("fleet", cx)).child(link(compact ? "Details" : "View Details")),
      v_flex()
        .flex_1()
        .gap(10)
        .child(fuelChart(window_))
        .child(h_flex().justify_between().gap(8).child(label(compact ? "Fuel Level" : `Fuel Level · ${Math.round(v.fuel).toLocaleString("en-US")} t`)).child(value(`${fuelPct(v).toFixed(0)}%`)))
        .child(bar(fuelPct(v), fuelPct(v) < RULES.fuelLowPct ? palette.amber : palette.fuel))
        .child(h_flex().justify_between().child(label("Consumption")).child(value(`${rate.toFixed(1)} t/day`)))
        .child(bar((rate / 20) * 100, palette.consumption)),
    );

    const recent = this.fleet.alerts.slice(0, compact || this.cardsHeight() < 300 ? 3 : 4);
    const alerts = card(cx, compact, "bell", "Recent Alerts",
      Button.new("alerts-all").on_click((_e, cx) => this.go("alerts", cx)).child(link("View All")),
      v_flex()
        .flex_1()
        .children(recent.map((a, i) => this.alertRow(a, i > 0, cx)))
        .when(recent.length === 0, (el) => el.child(muted("No alerts yet. Rules check deviation, fuel and engine temperature every step.", cx).whitespace_normal())),
    );

    return h_flex()
      .h(this.cardsHeight())
      .flex_shrink_0()
      .gap(compact ? 12 : 16)
      .p(compact ? 14 : 20)
      .child(route.flex_basis("26%"))
      .child(speed.flex_basis("22%"))
      .child(fuel.flex_basis("24%"))
      .child(alerts.flex_basis("24%"));
  }

  /** Opens an alert's vessel on the map and marks the alert read. */
  openAlert(a, cx) {
    a.read = true;
    this.selected = a.vessel;
    this.follow = true;
    this.page = "overview";
    this.menu = null;
    this.save();
    cx.notify();
  }

  /**
   * One alert. The row opens its vessel; on the Alerts page a second button
   * beside it toggles read without leaving the page.
   */
  alertRow(a, separator, cx, wide = false) {
    const v = this.fleet.vessels.find((x) => x.id === a.vessel);
    const tone = tones[alertTone[a.level]];
    const main = Button.new(`alert-${a.id}`)
      .flex()
      .flex_1()
      .min_w(0)
      .items_center()
      .gap(14)
      .py(wide ? 12 : 7)
      .px(wide ? 8 : 4)
      .rounded(6)
      .hover((el) => el.bg("#111f38"))
      .on_click((_e, cx) => this.openAlert(a, cx))
      .child(
        div()
          .size(30)
          .flex_shrink_0()
          .rounded_full()
          .bg(tone.bg)
          .flex()
          .items_center()
          .justify_center()
          .text_color(tone.fg)
          .font_bold()
          .child(a.level === "info" ? "i" : a.level === "success" ? "✓" : "!"),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(13).whitespace_nowrap().text_ellipsis().when(!a.read, (el) => el.font_semibold()).text_color(a.read ? "#9aa8c2" : "#e6ecf7").child(a.title))
          .child(div().text_size(11).whitespace_nowrap().text_ellipsis().text_color(cx.theme().colors.muted_foreground).child(`${v?.name ?? a.vessel} · ${wide ? utc(a.time) : utc(a.time, false)}`)),
      )
      .when(!a.read, (el) => el.child(dot(palette.blue, 7)))
      .child(icon("chevron-right", 15).text_color(cx.theme().colors.muted_foreground));
    return h_flex()
      .items_center()
      .gap(8)
      .when(separator, (el) => el.border_t(1).border_color(palette.cardBorder))
      .child(main)
      .when(wide, (el) => el.child(
        Button.new(`alert-read-${a.id}`)
          .flex_shrink_0()
          .h(28)
          .px(10)
          .flex()
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(palette.cardBorder)
          .text_size(12)
          .hover((h) => h.bg("#131f36"))
          .on_click((_e, cx) => {
            a.read = !a.read;
            this.save();
            cx.notify();
          })
          .child(a.read ? "Mark unread" : "Mark read"),
      ));
  }

  // ------------------------------------------------------------------ pages

  page_(title, subtitle, actions, body, cx) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .p(28)
      .gap(20)
      .child(
        h_flex()
          .items_center()
          .child(v_flex().flex_1().gap(4).child(div().text_size(20).font_semibold().child(title)).child(muted(subtitle, cx, 13)))
          .child(actions ?? div()),
      )
      .child(body);
  }

  button(id, label, handler, primary = false) {
    return Button.new(id)
      .flex()
      .items_center()
      .h(36)
      .px(14)
      .rounded(8)
      .border(1)
      .border_color(primary ? palette.blue : palette.cardBorder)
      .bg(primary ? "#2f6bff" : "#0d172a")
      .hover((el) => el.bg(primary ? "#3d78ff" : "#131f36"))
      .on_click(handler)
      .child(label);
  }

  fleetPage(cx) {
    const cols = ["Vessel", "Status", "Position", "Speed", "Course", "Route", "Progress", "Remaining", "ETA", "Fuel"];
    // Relative column widths: the table fills the page and cells truncate rather than wrap or overflow.
    const weights = [11, 10, 13, 7, 6, 17, 9, 9, 10, 9];
    const total = weights.reduce((a, b) => a + b, 0);
    const cell = (c, i, header) =>
      div()
        .w(/** @type {`${number}%`} */ (`${((weights[i] / total) * 100).toFixed(3)}%`))
        .min_w(0)
        .flex_shrink_0()
        .pr(10)
        .overflow_hidden()
        .text_size(header ? 11 : 13)
        .text_color(header ? "#8796b3" : "#e6ecf7")
        .when(typeof c === "string", (el) => el.whitespace_nowrap().text_ellipsis())
        .child(c);
    const row = (cells, header, id) =>
      (id ? Button.new(id) : div())
        .flex()
        .w_full()
        .justify_start()
        .items_center()
        .h(header ? 36 : 52)
        .px(16)
        .border_b(1)
        .border_color(palette.cardBorder)
        .when(!header && id === `row-${this.selected}`, (el) => el.bg("#13284d"))
        .when(Boolean(id), (el) => el.hover((h) => h.bg("#111f38")))
        .children(cells.map((c, i) => cell(c, i, header)));
    const twoLines = (a, b) => v_flex().gap(2).child(div().whitespace_nowrap().text_ellipsis().child(a)).child(div().whitespace_nowrap().text_ellipsis().text_size(11).text_color("#8796b3").child(b));
    const rows = this.fleet.vessels.map((v) => {
      const n = navigation(v, this.fleet.time);
      const st = status(v);
      return row([
        v.name, h_flex().child(chip(st.label, st.tone)), twoLines(formatLat(n.lat), formatLon(n.lon)), `${v.speed.toFixed(1)} kn`,
        `${Math.round(n.course)}°`, twoLines(n.from, `→ ${n.to}`), v_flex().gap(4).child(div().text_size(11).child(`${n.progress.toFixed(1)}%`)).child(bar(n.progress, palette.online)),
        `${Math.round(n.remaining).toLocaleString("en-US")} NM`,
        n.eta ? twoLines(utc(n.eta).split(" ").slice(0, 3).join(" "), utc(n.eta, false)) : "—",
        twoLines(`${fuelPct(v).toFixed(0)}%`, `${burnRate(v).toFixed(1)} t/day`),
      ], false, `row-${v.id}`).on_click((_e, cx) => {
        this.selected = v.id;
        this.go("overview", cx);
      });
    });
    return this.page_("Fleet", "Every vessel, recalculated from its route, speed and fuel each simulation step.",
      this.button("fleet-route", "New Route", (_e, cx) => this.openRouteDialog(cx), true),
      v_flex().rounded(10).border(1).border_color(palette.cardBorder).bg(palette.card).overflow_hidden()
        .child(row(cols, true)).children(rows), cx);
  }

  alertsPage(cx) {
    const list = this.fleet.alerts;
    return this.page_("Alerts", `${unread(this.fleet)} unread · raised automatically when a vessel is more than ${RULES.deviationNm} NM off track, below ${RULES.fuelLowPct}% fuel or above ${RULES.engineTempC} °C.`,
      h_flex().gap(10)
        .child(this.button("read-all", "Mark all read", (_e, cx) => {
          list.forEach((a) => (a.read = true));
          this.save();
          cx.notify();
        }))
        .child(this.button("clear-read", "Clear read", (_e, cx) => {
          this.fleet.alerts = list.filter((a) => !a.read);
          this.save();
          cx.notify();
        })),
      v_flex().flex_1().min_h(0).id("alerts-scroll").overflow_y_scroll().px(18).rounded(10).border(1).border_color(palette.cardBorder).bg(palette.card)
        .children(list.map((a, i) => this.alertRow(a, i > 0, cx, true)))
        .when(list.length === 0, (el) => el.child(div().py(18).child(muted("No alerts.", cx, 13)))), cx);
  }

  reportsPage(cx) {
    const index = Math.min(this.reportIndex, Math.max(0, this.reports.length - 1));
    const latest = this.reports[index];
    return this.page_("Reports", "Create Report writes a Markdown snapshot of the fleet into the app's data folder and copies it to the clipboard.",
      this.button("reports-create", "Create Report", (_e, cx) => this.createReport(cx), true),
      h_flex().flex_1().min_h(0).items_start().gap(16)
        .child(v_flex().w(300).flex_shrink_0().gap(6).children(this.reports.map((r, i) =>
          Button.new(`report-${i}`).flex().flex_col().items_start().gap(3).p(12).rounded(8).border(1).border_color(i === index ? palette.navActiveBorder : palette.cardBorder)
            .bg(i === index ? "#13284d" : palette.card).hover((el) => el.bg("#111f38"))
            .on_click((_e, cx) => {
              this.reportIndex = i;
              cx.notify();
            })
            .child(div().text_size(12).font_medium().child(r.name)).child(muted(utc(r.time), cx, 11))))
          .when(this.reports.length === 0, (el) => el.child(muted("No reports yet.", cx, 13))))
        .child(div().flex_1().min_w(0).self_stretch().id("report-preview").overflow_y_scroll().p(16).rounded(10).border(1).border_color(palette.cardBorder).bg(palette.card)
          .font_family("Menlo").text_size(11).text_color("#c9d3e6").whitespace_normal()
          .children((latest?.text ?? "No report selected.").split("\n").map((line) => div().min_h(14).child(line)))), cx);
  }

  settingsPage(cx) {
    const option = (s) => {
      const active = s === this.scale;
      return Button.new(`scale-${s}`)
        .px(14).h(34).flex().items_center().rounded(8).border(1)
        .border_color(active ? palette.navActiveBorder : palette.cardBorder).bg(active ? palette.navActive : "#0d172a")
        .on_click((_e, cx) => {
          this.scale = s;
          this.save();
          cx.notify();
        })
        .child(s === 1 ? "Real time" : `×${s}`);
    };
    const describe = { 1: "1 s = 1 s", 60: "1 s = 1 min", 600: "1 s = 10 min", 3600: "1 s = 1 h" };
    return this.page_("Settings", "Simulation clock and alert rules.", null,
      v_flex().gap(22).max_w(720)
        .child(v_flex().gap(10).child(div().font_medium().child("Simulation speed")).child(h_flex().gap(8).children(SCALES.map(option)))
          .child(muted(`${describe[this.scale]}. While OceanView is closed, voyages continue in real time (up to 30 days).`, cx)))
        .child(v_flex().gap(6).child(div().font_medium().child("Alert rules"))
          .child(muted(`Route deviation: cross-track error above ${RULES.deviationNm} NM (re-arms below ${RULES.deviationNm * 0.6} NM).`, cx))
          .child(muted(`Fuel low: below ${RULES.fuelLowPct}% of capacity; the vessel slows to 80% of cruise speed.`, cx))
          .child(muted(`Engine temperature: above ${RULES.engineTempC} °C.`, cx)))
        .child(v_flex().gap(10).child(div().font_medium().child("Simulation data"))
          .child(muted("Restore the five sample voyages and clear alerts and fuel history.", cx))
          .child(h_flex().child(this.button("reset", "Reset simulation", (_e, cx) => {
            this.fleet = seedFleet();
            this.save();
            this.toast("Simulation reset", "Five voyages restored at their starting points.");
            cx.notify();
          })))), cx);
  }

  // ------------------------------------------------------------ new route

  routeOverlay(cx) {
    const d = /** @type {{ vessel: string, from: string, to: string }} */ (this.routeDialog);
    const v = this.fleet.vessels.find((x) => x.id === d.vessel);
    const path = plan(d.from, d.to);
    const nm = path ? pathLength(path.map((id) => nodes[id])) : 0;
    const via = path ? path.slice(1, -1).filter((id) => !nodes[id].port).map((id) => nodes[id].name) : [];
    const pill = (id, label, active, handler) =>
      Button.new(id)
        .px(10).h(28).flex().items_center().rounded(6).border(1).text_size(12)
        .border_color(active ? palette.navActiveBorder : palette.cardBorder).bg(active ? palette.navActive : "#0d172a")
        .hover((el) => el.bg(active ? palette.navActive : "#131f36"))
        .on_click(handler)
        .child(label);
    const group = (title, items) => v_flex().gap(8).child(muted(title, cx, 12)).child(h_flex().flex_wrap().gap(6).children(items));
    const set = (patch) => (_e, cx) => {
      Object.assign(d, patch);
      cx.notify();
    };
    return div()
      .absolute()
      .inset_0()
      .bg("#02060fcc")
      .flex()
      .items_center()
      .justify_center()
      .child(
        v_flex()
          .w(620)
          .gap(18)
          .p(24)
          .rounded(12)
          .bg("#0e182b")
          .border(1)
          .border_color(palette.labelBorder)
          .shadow_lg()
          .child(v_flex().gap(4).child(div().text_size(17).font_semibold().child("New Route")).child(muted("Plans the shortest voyage through real sea lanes, straits and canals; the vessel bunkers to full before leaving.", cx)))
          .child(group("Vessel", this.fleet.vessels.map((x) => pill(`rv-${x.id}`, x.name, x.id === d.vessel, set({ vessel: x.id, from: currentPort(x) })))))
          .child(group("From", ports.map((p) => pill(`rf-${p.id}`, p.name, p.id === d.from, set({ from: p.id })))))
          .child(group("To", ports.map((p) => pill(`rt-${p.id}`, p.name, p.id === d.to, set({ to: p.id })))))
          .child(
            v_flex().gap(6).p(14).rounded(8).bg("#0b1424").border(1).border_color(palette.cardBorder)
              .when(Boolean(path), (el) => el
                .child(div().font_medium().child(`${nodes[d.from].name} → ${nodes[d.to].name}: ${Math.round(nm).toLocaleString("en-US")} NM`))
                .child(muted(`About ${(nm / v.cruise / 24).toFixed(1)} days at ${v.cruise} kn, burning ≈ ${Math.round((nm / v.cruise / 24) * v.burn)} t of fuel.`, cx))
                .child(muted(via.length ? `Via ${via.join(" · ")}` : "Direct passage", cx, 11)))
              .when(!path, (el) => el.child(muted("Choose two different ports.", cx))),
          )
          .child(
            h_flex().justify_end().gap(10)
              .child(this.button("route-cancel", "Cancel", (_e, cx) => {
                this.routeDialog = null;
                cx.notify();
              }))
              .child(this.button("route-assign", "Assign route", (_e, cx) => {
                if (!path) return;
                assignRoute(this.fleet, d.vessel, d.from, d.to);
                this.selected = d.vessel;
                this.routeDialog = null;
                this.follow = true;
                this.page = "overview";
                this.save();
                this.toast("Route assigned", `${v.name}: ${nodes[d.from].name} → ${nodes[d.to].name}, ${Math.round(nm).toLocaleString("en-US")} NM.`, "success");
                cx.notify();
              }, true)),
          ),
      );
  }
}

// ------------------------------------------------------------------ drawings

/** The 270° speed dial, `value` out of `max` knots. */
function gauge(value, max, size = 132) {
  const c = size / 2;
  const r = size / 2 - 10;
  const start = 135;
  const point = (deg) => [c + r * Math.cos((deg * Math.PI) / 180), c + r * Math.sin((deg * Math.PI) / 180)];
  const arc = (from, to, width) => {
    const [x0, y0] = point(from);
    const [x1, y1] = point(to);
    return PathBuilder.stroke(width).move_to(x0, y0).arc_to(r, r, 0, to - from > 180, true, x1, y1).build();
  };
  const sweep = Math.max(0.5, Math.min(270, (value / max) * 270));
  return div()
    .relative()
    .size(size)
    .flex_shrink_0()
    .child(window.paint_path(arc(start, start + 270, 7), palette.track).absolute().inset_0())
    .child(window.paint_path(arc(start, start + sweep, 7), Background.linear_gradient(90, Background.stop("#1d4ed8", 0), Background.stop("#3b82f6", 100))).absolute().inset_0())
    .child(
      v_flex().absolute().inset_0().items_center().justify_center()
        .child(div().text_size(size > 120 ? 28 : 22).font_medium().child(value.toFixed(1)))
        .child(div().text_size(12).text_color("#8796b3").child("Knots")),
    );
}

/** A navigation arrow pointing along `course`. */
function arrow(course) {
  const s = 22;
  const a = ((course - 90) * Math.PI) / 180;
  const rot = (x, y) => [s / 2 + x * Math.cos(a) - y * Math.sin(a), s / 2 + x * Math.sin(a) + y * Math.cos(a)];
  const path = PathBuilder.fill().add_polygon([rot(9, 0), rot(-7, -7), rot(-3, 0), rot(-7, 7)], true).build();
  return div().relative().size(s).child(window.paint_path(path, "#c9d3e6").absolute().inset_0());
}

/** The compass rose, its needle on the vessel's heading. */
function compass(heading) {
  const s = 54;
  const c = s / 2;
  const a = ((heading - 90) * Math.PI) / 180;
  const rot = (x, y) => [c + x * Math.cos(a) - y * Math.sin(a), c + x * Math.sin(a) + y * Math.cos(a)];
  const circle = (r, width) => PathBuilder.stroke(width).move_to(c + r, c).arc_to(r, r, 0, true, true, c - r, c).arc_to(r, r, 0, true, true, c + r, c).build();
  const ticks = [0, 90, 180, 270].map((deg) => {
    const t = (deg * Math.PI) / 180;
    return PathBuilder.stroke(1.5).move_to(c + 22 * Math.sin(t), c - 22 * Math.cos(t)).line_to(c + 26 * Math.sin(t), c - 26 * Math.cos(t)).build();
  });
  return div()
    .relative()
    .size(s)
    .child(window.paint_path(circle(25.5, 1.4), "#3b82f6").absolute().inset_0())
    .children(ticks.map((t) => window.paint_path(t, "#3b82f6").absolute().inset_0()))
    .child(window.paint_path(PathBuilder.fill().add_polygon([rot(15, 0), rot(-9, -7), rot(-4, 0)], true).build(), "#e8eefc").absolute().inset_0())
    .child(window.paint_path(PathBuilder.fill().add_polygon([rot(15, 0), rot(-4, 0), rot(-9, 7)], true).build(), "#93a8cc").absolute().inset_0())
    .child(div().absolute().top(-3).left(c - 4).text_size(9).font_semibold().child("N"));
}

/** Fuel remaining over the selected window, as a filled line. @param {number[]} series */
function fuelChart(series) {
  const h = 80;
  const box = div().relative().w_full().h(h);
  if (series.length < 2) return box.child(div().text_size(11).text_color("#8796b3").child("Collecting fuel readings…"));
  const min = Math.min(...series);
  const max = Math.max(...series);
  const pad = Math.max(0.5, (max - min) * 0.15);
  const lo = min - pad;
  const hi = max + pad;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * 100, ((hi - v) / (hi - lo)) * 100]);
  const p = (x, y) => [`${x.toFixed(3)}%`, `${y.toFixed(3)}%`];
  const line = PathBuilder.stroke(1.6).add_polygon(pts.map(([x, y]) => p(x, y)), false).build();
  const area = PathBuilder.fill().add_polygon([...pts.map(([x, y]) => p(x, y)), p(100, 100), p(0, 100)], true).build();
  const grid = [25, 50, 75].map((y) => window.paint_path(PathBuilder.stroke(1).add_polygon([p(0, y), p(100, y)], false).build(), "#ffffff0d").absolute().inset_0());
  return box
    .children(grid)
    .child(window.paint_path(area, Background.linear_gradient(180, Background.stop("#22c55e40", 0), Background.stop("#22c55e00", 100))).absolute().inset_0())
    .child(window.paint_path(line, palette.fuel).absolute().inset_0())
    .child(div().absolute().right(0).top(-2).text_size(10).text_color("#8796b3").child(`${max.toFixed(1)}%`))
    .child(div().absolute().right(0).bottom(-2).text_size(10).text_color("#8796b3").child(`${min.toFixed(1)}%`));
}
