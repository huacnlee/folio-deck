import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState, Checkbox } from "gpui-base";
import * as fs from "fs/promises";
import { homedir } from "os";
import { randomUUID } from "crypto";

import { applyPalette, palette as C, mapColors as colors, tones, mapGradients, markedGradient, motion, layout } from "./theme.js";
import { scan, treemap, topSuggestions, weight, categories, reclaimable } from "./lib/scan.js";
import {
  parent,
  inside,
  formatSize,
  trash,
  restore,
  readTrash,
  estimateTrash,
  purgeTrash,
  reason,
} from "./lib/files.js";
const home = homedir();
const deps = {
  fs,
  home,
  store: process.dataDir,
  run: (cmd, args) => process.run(cmd, args),
  random: randomUUID,
  now: () => Date.now(),
};
export default class DiskTree extends View {
  init(_props, cx) {
    applyPalette({
      background: C.bg,
      surface: C.surface,
      foreground: C.text,
      accent: C.accent,
      selection: tones.selection,
      bright: C.text,
      border: C.border,
      danger: tones.danger,
      success: tones.success,
      warning: C.orange,
    });
    this.scanOwner = randomUUID();
    sessionStorage.setItem("disktree.scan-owner", this.scanOwner);
    this.inspectorOpen = localStorage.getItem("disktree.inspector") !== "closed";
    this.inspectorOverride = false;
    this.animate = localStorage.getItem("disktree.motion") !== "off";
    this.partial = false;
    this.mapPaths = new Map();
    this.suggestionCache = [];
    this.layoutCache = new Map();
    this.layoutKey = "";
    this.treeRevision = 0;
    this.pending = 0;
    this.focus = cx.focus_handle();
    this.focus.focus();
    this.path = home;
    this.root = null;
    this.selected = null;
    this.hovered = null;
    this.metric = "size";
    this.apparent = false;
    this.hidden = true;
    this.depth = 3;
    this.marked = new Set();
    this.history = [home];
    this.historyIndex = 0;
    this.generation = 0;
    this.loading = false;
    this.busy = false;
    this.progress = 0;
    this.pending = 0;
    this.lastProgressPaint = 0;
    this.message = "";
    this.errors = [];
    this.expanded = false;
    this.review = false;
    this.deletePaths = null;
    this.trashEntries = [];
    this.purgeReview = null;
    this.disk = null;
    this.locationEditing = false;
    this.location = InputState.new({ placeholder: "Folder path" });
    this.location.set_value(home);
    this.location.on("submit", (_e, cx) => {
      const p = this.location
        .value()
        .trim()
        .replace(/^~(?=\/|$)/, home);
      if (p.startsWith("/")) this.navigate(p, cx);
    });
    this.filter = InputState.new({
      placeholder: "Filter folders and files",
    });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.start(cx);
  }
  start(cx) {
    const generation = ++this.generation;
    this.loading = true;
    this.progress = 0;
    this.pending = 0;
    this.lastProgressPaint = 0;
    this.message = "";
    this.suggestionCache = [];
    cx.spawn(async (cx) => {
      try {
        const result = await scan(deps, this.path, {
          hidden: this.hidden,
          cancelled: () =>
            generation !== this.generation ||
            sessionStorage.getItem("disktree.scan-owner") !== this.scanOwner,
          partial: (root, count, pending, reclaim) => {
            if (
              generation !== this.generation ||
              sessionStorage.getItem("disktree.scan-owner") !== this.scanOwner
            )
              return;
            if (this.root !== root) this.selected = root;
            this.root = root;
            this.partial = true;
            this.progress = count;
            this.pending = pending;
            this.lastProgressPaint = Date.now();
            this.treeRevision++;
            this.suggestionCache = topSuggestions(reclaim);
            cx.notify();
          },
          progress: (n, pending) => {
            if (generation === this.generation) {
              this.progress = n;
              this.pending = pending;
              if (Date.now() - this.lastProgressPaint >= 300) {
                this.lastProgressPaint = Date.now();
                cx.notify();
              }
            }
          },
          yield: () => cx.sleep(1),
        });
        if (generation !== this.generation || result.cancelled) return;
        this.partial = false;
        this.root = result.root;
        this.treeRevision++;
        this.suggestionCache = topSuggestions(result.reclaim);
        this.selected = this.selected ?? this.root;
        this.errors = result.errors.filter(Boolean);
        const df = await deps.run("df", [
          "-B1",
          "--output=size,used,avail",
          "--",
          this.path,
        ]);
        if (generation !== this.generation) return;
        if (df.code === 0) {
          const values = df.stdout
            .trim()
            .split("\n")
            .pop()
            .trim()
            .split(/\s+/)
            .map(Number);
          if (
            values.length === 3 &&
            values.every(Number.isFinite) &&
            values[0] > 0
          )
            this.disk = { total: values[0], used: values[1], free: values[2] };
          else this.errors.push("Disk capacity unavailable.");
        } else
          this.errors.push(df.stderr.trim() || "Disk capacity unavailable.");
        const trashEntries = await readTrash(deps);
        if (generation !== this.generation) return;
        this.trashEntries = trashEntries;
      } catch (e) {
        if (generation === this.generation) {
          console.error("DiskTree scan failed", e);
          this.message = `Couldn’t finish scanning. ${reason(e)} Select Rescan to try again.`;
        }
      } finally {
        if (generation === this.generation) {
          this.loading = false;
          cx.notify();
        }
      }
    });
    cx.notify();
  }
  navigate(path, cx, record = true) {
    this.locationEditing = false;
    this.hovered = null;
    this.path = path;
    this.root = null;
    this.selected = null;
    this.hovered = null;
    this.disk = null;
    this.location.set_value(path);
    if (record) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(path);
      this.historyIndex++;
    }
    this.marked.clear();
    this.start(cx);
  }
  toggle(cx, n = this.selected) {
    if (
      !n ||
      n.path === this.path ||
      n.path === home ||
      !inside(n.path, home)
    ) {
      this.message =
        "Select an item inside your home folder. The scan root is protected.";
    } else {
      this.message = "";
      this.marked.has(n.path)
        ? this.marked.delete(n.path)
        : this.marked.add(n.path);
    }
    cx.notify();
  }
  action(cx, work) {
    if (this.busy) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await work();
      } catch (e) {
        this.message = reason(e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }
  remove(cx, permanent = false) {
    const paths = (permanent ? this.deletePaths ?? [] : [...this.marked])
      .filter((p) => ![home, this.path, "/"].includes(p))
      .filter((p) => ![...this.marked].some((q) => q !== p && inside(p, q)));
    this.review = false;
    this.deletePaths = null;
    this.action(cx, async () => {
      const result = await trash(deps, paths);
      if (permanent && result.entries.length) {
        const deleted = await purgeTrash(deps, result.entries);
        result.failures.push(...deleted.failures);
      }
      this.marked.clear();
      this.start(cx);
      this.message = result.failures.map((e) => e.message).join("; ");
    });
  }
  deleteDialog(paths) {
    return v_flex().role("alert_dialog").accessibility_label("Confirm permanent deletion")
      .w("28rem").max_w("90%").p_5().gap_4().bg(C.surface).rounded(8)
      .child(this.text(`Delete ${paths.length} marked items permanently?`, 18).font_semibold())
      .child(div().id("delete-paths").max_h("12rem").overflow_y_scroll()
        .children(paths.map((path) => this.text(path.replace(home, "~"), 12))))
      .child(this.text("These items cannot be restored. Choose Move to Trash to keep them recoverable.", 12, C.muted))
      .child(h_flex().w_full().justify_end().gap_2()
        .child(this.button("cancel-delete", "Cancel", () => window.close_dialog()))
        .child(this.button("confirm-delete", "Delete permanently", (cx) => {
          window.close_dialog(); this.deletePaths = paths; this.remove(cx, true);
        }).bg(tones.danger).text_color(tones.onAccent)));
  }
  confirmDeletion(_cx) {
    const paths = [...this.marked];
    if (!paths.length || this.busy) return;
    window.open_dialog(() => this.deleteDialog(paths), { escape_dismissable: true, backdrop_dismissable: false });
  }
  reviewPurge(cx) {
    this.action(cx, async () => {
      const entries = await readTrash(deps);
      const allocated = await estimateTrash(deps, entries);
      this.purgeReview = { entries, allocated };
    });
  }
  confirmPurge(cx) {
    const review = this.purgeReview;
    if (!review || this.busy) return;
    this.purgeReview = null;
    this.action(cx, async () => {
      const result = await purgeTrash(deps, review.entries);
      this.start(cx);
      this.message = result.failures.map((entry) => entry.message).join("; ");
    });
  }
  key(e, cx) {
    if (!this.focus.is_focused()) return;
    if (this.filterMode) {
      if (e.key === "escape" || e.key === "enter") {
        this.filterMode = false;
      } else if (e.key === "backspace") {
        this.filter.set_value(this.filter.value().slice(0, -1));
      } else if (e.key_char && !e.modifiers.control && !e.modifiers.platform) {
        this.filter.set_value(this.filter.value() + e.key_char);
      }
      cx.notify();
      return;
    }
    if (e.key === "/") {
      this.filterMode = true;
      cx.notify();
      return;
    }
    if (e.modifiers.control || e.modifiers.alt || e.modifiers.platform) return;
    switch (e.key) {
      case "space":
      case " ":
        if (!e.is_held && !this.busy) this.toggle(cx, this.hovered ?? this.selected);
        cx.stop_propagation();
        break;
      case "enter":
        if (this.selected?.directory) this.navigate(this.selected.path, cx);
        break;
      case "backspace":
        this.navigate(parent(this.path), cx);
        break;
      case "r":
        this.start(cx);
        break;
      case "c":
        this.review = this.marked.size > 0;
        break;
      case "[":
        this.depth = Math.max(1, this.depth - 1);
        break;
      case "]":
        this.depth = Math.min(6, this.depth + 1);
        break;
      case "i":
        this.inspectorOpen = !this.inspectorOpen;
        this.inspectorOverride = true;
        localStorage.setItem("disktree.inspector", this.inspectorOpen ? "open" : "closed");
        break;
      case "m":
        this.animate = !this.animate;
        localStorage.setItem("disktree.motion", this.animate ? "on" : "off");
        break;
      case "t":
        this.metric = ["size", "files", "age"][
          (["size", "files", "age"].indexOf(this.metric) + 1) % 3
        ];
        break;
      case "0":
        this.metric = "size";
        this.depth = 3;
        this.filter.set_value("");
        break;
      case "escape":
        this.deletePaths = null;
        this.message = "";
        this.purgeReview = null;
        this.locationEditing = false;
        this.review = false;
        this.filter.set_value("");
        break;
      case "j":
      case "l":
      case "k":
      case "h": {
        const nodes = this.root?.children ?? [];
        if (nodes.length)
          this.selected =
            nodes[
              (Math.max(0, nodes.indexOf(this.selected)) +
                (["j", "l"].includes(e.key) ? 1 : nodes.length - 1)) %
                nodes.length
            ];
        break;
      }
    }
    cx.notify();
  }
  button(id, label, fn, active = false, disabled = false) {
    const icons = { back: "back", forward: "forward", rescan: this.loading ? "close" : "refresh", open: "external", browse: "folder", mark: "check", review: "trash", "empty-trash": "trash" };
    const navigation = id === "back" || id === "forward";
    const labelElement = navigation
      ? svg(`disktree/icons/${icons[id]}.svg`).size_4().flex_shrink_0().text_color(C.text)
      : typeof label === "string" ? h_flex().gap(6).items_center()
        .when(Boolean(icons[id]), (el) => el.child(svg(`disktree/icons/${icons[id]}.svg`).size(14).flex_shrink_0().text_color(active ? C.accent : C.text)))
        .child(label) : label;
    return Button.new(id)
      .accessibility_label(navigation ? (id === "back" ? "Go back" : "Go forward") : typeof label === "string" ? label : id)
      .when(navigation, (el) => el.tooltip(id === "back" ? "Go back" : "Go forward"))
      .focus((el) => el.border_1().border_color(C.accent))
      .disabled(disabled || this.busy)
      .opacity(disabled || this.busy ? 0.35 : 1)
      .h(30).px(10).rounded(6).text_size(12).font_medium()
      .bg(active ? tones.activeSurface : C.surface)
      .text_color(active ? C.accent : C.text)
      .border_1().border_color(active ? tones.activeBorder : C.border)
      .when(["back", "forward", "less", "more"].includes(id), (el) => el.w_8().h_8().p(0).border_0().bg(C.surface).flex().items_center().justify_center())
      .when(!disabled && !this.busy, (el) => el.hover((el) => el.bg(active ? tones.activeHover : tones.quietSurface)))
      .on_click((_e, cx) => fn(cx)).child(labelElement);
  }

  breadcrumb(cx) {
    const parts = this.path.split("/").filter(Boolean);
    const trail = [{ label: "/", path: "/" }, ...parts.map((label, index) => ({ label, path: "/" + parts.slice(0, index + 1).join("/") }))];
    const visible = trail.length > 5 ? [trail[0], { label: "…", path: trail[trail.length - 4].path }, ...trail.slice(-3)] : trail;
    return h_flex().flex_1().min_w_0().gap(0).items_center()
      .children(visible.flatMap((part, index) => {
        const current = part.path === this.path;
        const item = Button.new(`crumb-${part.path}`).h(24).px(4).rounded(3)
          .text_size(13).text_color(current ? C.text : C.muted)
          .when(current, (el) => el.font_medium())
          .hover((el) => el.bg(tones.breadcrumbHover))
          .on_click((_e, cx) => { if (!current) this.navigate(part.path, cx); }).child(part.label);
        return index ? [svg("disktree/icons/forward.svg").size(10).text_color(tones.separatorIcon).flex_shrink_0(), item] : [item];
      }));
  }
  checkLabel(label, checked) {
    return h_flex().gap(8).items_center().text_size(12)
      .child(div().size(16).rounded(4).border_1()
        .border_color(checked ? C.accent : tones.checkBorder).bg(checked ? C.accent : C.surface)
        .flex().items_center().justify_center()
        .when(checked, (el) => el.child(svg("disktree/icons/check.svg").size(12).text_color(tones.onAccent))))
      .child(label);
  }
  text(value, size = 14, color = C.text) {
    return div().text_size(size).text_color(color).child(String(value));
  }
  matches(node, query) {
    if (this.matchCache.has(node)) return this.matchCache.get(node);
    const value =
      node.name.toLowerCase().includes(query) ||
      node.children.some((child) => this.matches(child, query));
    this.matchCache.set(node, value);
    return value;
  }
  // Layouts only change with the tree, the metric, the filter or the size.
  layout(node, w, h, query) {
    const key = `${this.treeRevision}|${this.metric}|${this.apparent}|${query}`;
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layoutCache.clear();
    }
    const id = `${node.path}|${w.toFixed(1)}|${h.toFixed(1)}`;
    let rects = this.layoutCache.get(id);
    if (!rects) {
      const nodes = node.children.filter((n) => !query || this.matches(n, query));
      rects = treemap(nodes, w, h, this.metric, this.apparent).filter((r) => r.w > 4 && r.h > 4);
      this.layoutCache.set(id, rects);
    }
    return rects;
  }
  tiles(node, w, h, level = 0) {
    const query = this.filter.value().trim().toLowerCase();
    return this.layout(node, w, h, query).map((r) => {
        const n = r.node;
        const selected = this.selected?.path === n.path;
        const marked = [...this.marked].some((path) => inside(n.path, path));
        const nested = n.directory && level + 1 < this.depth && r.w > 110 && r.h > 90;
        const roomy = r.w > 170 && r.h > 110;
        const base = marked ? tones.markedFill : colors[Math.max(0, categories.indexOf(n.category))];
        const edge = tones.mapBoundary;
        const outline = selected || marked ? 1 : 0.5;
        const el = v_flex()
          .id(`tile-${n.path}`)
          .absolute()
          .left(`${((r.x + 1) / w) * 100}%`)
          .top(`${((r.y + 1) / h) * 100}%`)
          .w(`${(Math.max(0, r.w - 2) / w) * 100}%`)
          .h(`${(Math.max(0, r.h - 2) / h) * 100}%`)
          .when(this.animate, (el) => el.transition("left", motion).transition("top", motion)
            .transition("width", motion).transition("height", motion))
          .overflow_hidden()
          .bg(base)
          .border(outline)
          .border_color(marked ? C.orange : selected ? tones.selectedBorder : edge)
          .rounded(3)
          .hover((el) => el.border_color(marked ? C.orange : C.accent))
          .on_hover((hovered, _cx) => {
            if (hovered) this.hovered = n;
            else if (this.hovered?.path === n.path) this.hovered = null;
          })
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.selected = n;
            this.focus.focus();
            cx.notify();
          });
        const rectangle = () => {
          const key = `${r.w.toFixed(1)}:${r.h.toFixed(1)}`;
          if (this.mapPaths.has(key)) return this.mapPaths.get(key);
          if (this.mapPaths.size > 512) this.mapPaths.clear();
          // Treemap geometry is data, not control spacing; one inset hairline.
          const rx = Math.min(20, 200 / Math.max(1, r.w - 4));
          const ry = Math.min(20, 200 / Math.max(1, r.h - 4));
          const pct = (value) => `${value}%`;
          const k = 0.55228475;
          const path = PathBuilder.fill().move_to(pct(rx), "0%")
            .line_to(pct(100 - rx), "0%")
            .cubic_bezier_to("100%", pct(ry), pct(100 - rx + rx * k), "0%", "100%", pct(ry - ry * k))
            .line_to("100%", pct(100 - ry))
            .cubic_bezier_to(pct(100 - rx), "100%", "100%", pct(100 - ry + ry * k), pct(100 - rx + rx * k), "100%")
            .line_to(pct(rx), "100%")
            .cubic_bezier_to("0%", pct(100 - ry), pct(rx - rx * k), "100%", "0%", pct(100 - ry + ry * k))
            .line_to("0%", pct(ry))
            .cubic_bezier_to(pct(rx), "0%", "0%", pct(ry - ry * k), pct(rx - rx * k), "0%").close().build();
          this.mapPaths.set(key, path);
          return path;
        };
        // NativePath paints its Background directly; element opacity is not applied.
        const [light, deep] = marked ? markedGradient : mapGradients[Math.max(0, categories.indexOf(n.category))];
        el.child(window.paint_path(rectangle(), Background.linear_gradient(155,
          light, deep).color_space("oklab")).absolute().inset(outline));
        if (!nested && reclaimable(n) && r.w > 70 && r.h > 50)
          el.child(window.paint_path(rectangle(), Background.pattern_slash(tones.reclaimPattern, 1, 12)).absolute().inset(outline));
        if (r.w > 55 && r.h > 24) {
          const header = h_flex()
            .relative().px(level === 0 ? 9 : 6).h(nested ? 29 : 26)
            .flex_shrink_0().gap(6).items_center()
            .when(nested, (el) => el.bg(tones.mapHeader))
            .child(div().flex_1().min_w_0().truncate().text_size(level === 0 ? 13 : 12)
              .when(n.directory, (el) => el.font_semibold()).text_color(C.text).child(n.name));
          if ((nested && r.w > 150) || (!roomy && r.w > 130))
            header.child(this.text(this.metric === "files" ? n.files.toLocaleString() : formatSize(weight(n, "size", this.apparent)), 11, tones.mapMetadata).flex_shrink_0());
          if (this.marked.has(n.path) && r.w > 100) header.child(this.text("MARKED", 9, tones.markedText).font_semibold().px(5).py(2).rounded(3).bg(tones.markedBadge));
          el.child(header);
          if (!nested && roomy)
            el.child(v_flex().relative().px(9).gap(3)
              .child(this.text(this.metric === "files" ? `${n.files.toLocaleString()} files` : formatSize(weight(n, "size", this.apparent)), level === 0 ? 20 : 16, tones.mapValue))
              .child(this.text(reclaimable(n) ? "Reclaimable" : n.category, 11, tones.mapSecondary)));
        }
        if (nested)
          el.child(div().relative().flex_1().min_h_0().w_full().p(1)
            .child(div().relative().size_full().children(this.tiles(n, r.w - 6, r.h - 33, level + 1))));
        return el;
      });
  }
  render(cx) {
    this.matchCache = new Map();
    const viewport = window.viewport_size(),
      n = this.selected ?? this.root;
    const narrow = viewport.width < 850;
    const showInspector = this.inspectorOpen && (!narrow || this.inspectorOverride);
    const side = showInspector ? (narrow ? 320 : 400) : 0;
    const width = Math.max(100, viewport.width - side - 54),
      height = Math.max(
        120,
        viewport.height -
          (viewport.width < 900 ? 280 : 230) -
          (this.expanded ? 130 : 0) -
          (this.errors.length ? 40 : 0),
      );
    const brand = h_flex()
      .gap(9)
      .items_center()
      .child(
        v_flex()
          .gap(3)
          .child(
            h_flex()
              .gap(3)
              .child(div().size(9).rounded(2).bg(colors[0]))
              .child(div().size(9).rounded(2).bg(colors[1])),
          )
          .child(
            h_flex()
              .gap(3)
              .child(div().size(9).rounded(2).bg(colors[2]))
              .child(div().size(9).rounded(2).bg(colors[7])),
          ),
      )
      .child(v_flex().gap(1).child(this.text("DiskTree", 16).font_semibold()).child(this.text("DISK EXPLORER", 9, C.muted)));
    const metricTabs = h_flex().flex_shrink_0().p(3).gap(0).rounded(9)
      .bg(tones.segmentSurface).border_1().border_color(tones.segmentBorder)
      .role("tab_list").accessibility_label("Map metric")
      .children(["size", "files", "age"].map((metric) => {
        const active = this.metric === metric;
        return Button.new(`metric-${metric}`).role("tab").aria_selected(active)
          .on_key_down((e, cx) => {
            const values = ["size", "files", "age"];
            if (["left", "right", "home", "end"].includes(e.key)) {
              this.metric = e.key === "home" ? "size" : e.key === "end" ? "age"
                : values[(values.indexOf(this.metric) + (e.key === "right" ? 1 : 2)) % 3];
              cx.stop_propagation(); cx.notify();
            }
          }).focus((el) => el.border_1().border_color(C.accent)).h_8().px_4().rounded(0)
          .when(metric === "size", (el) => el.rounded_l(6))
          .when(metric === "age", (el) => el.rounded_r(6))
          .bg(active ? C.accent : tones.segmentSurface).text_color(active ? tones.onAccent : tones.segmentText)
          .text_size(12).font_medium().hover((el) => el.bg(active ? tones.segmentPressed : tones.segmentHover))
          .on_click((_e, cx) => { this.metric = metric; cx.notify(); })
          .child(metric[0].toUpperCase() + metric.slice(1));
      }));
    const top = v_flex()
      .px(20)
      .pt(14)
      .pb(12)
      .bg(C.surface)
      .gap(12)
      .when(!this.message, (el) => el.border_b_1().border_color(C.border))
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .child(brand)
          .child(
            this.button(
              "back",
              "‹",
              (cx) =>
                this.navigate(this.history[--this.historyIndex], cx, false),
              false,
              this.historyIndex === 0,
            ),
          )
          .child(
            this.button(
              "forward",
              "›",
              (cx) =>
                this.navigate(this.history[++this.historyIndex], cx, false),
              false,
              this.historyIndex + 1 >= this.history.length,
            ),
          )
          .child(h_flex().flex_1().min_w_0().h(30).gap(4).items_center()
            .when(this.locationEditing, (el) => el.child(Input.new(this.location).flex_1().min_w_0()))
            .when(!this.locationEditing, (el) => el.child(this.breadcrumb(cx)))
            .child(Button.new("edit-location").size(26).rounded(5)
              .hover((el) => el.bg(tones.segmentSurface))
              .on_click((_e, cx) => { this.locationEditing = !this.locationEditing; cx.notify(); })
              .child(svg(`disktree/icons/${this.locationEditing ? "close" : "edit"}.svg`).size(13).text_color(C.muted))))
          .child(metricTabs)
          .child(Button.new("toggle-inspector").size_8().accessibility_label("Toggle inspector").tooltip("Inspector (i)")
            .rounded(6).bg(showInspector ? tones.activeSurface : C.surface)
            .flex().items_center().justify_center()
            .on_click((_e, cx) => { this.inspectorOpen = !showInspector; this.inspectorOverride = true; cx.notify(); })
            .child(svg("disktree/icons/panel.svg").size_4().text_color(C.text))),
      )
      .child(
        h_flex()
          .w_full().justify_between().gap_3().flex_wrap().items_center()
          .child(h_flex().gap(14).flex_wrap().items_center()
          .child(
            Checkbox.new("hidden")
              .checked(this.hidden)
              .child(this.checkLabel("Hidden files", this.hidden))
              .on_change((checked, cx) => {
                this.hidden = checked;
                this.start(cx);
              }),
          )
          .child(
            Checkbox.new("apparent")
              .checked(this.apparent)
              .child(this.checkLabel("Apparent size", this.apparent))
              .on_change((checked, cx) => {
                this.apparent = checked;
                cx.notify();
              }),
          )
          .child(h_flex().gap_2().items_center()
            .child(this.text("Depth", 12, C.muted))
            .child(h_flex().gap(0).h_8().rounded(6).border_1().border_color(C.border).bg(C.surface)
              .child(Button.new("less").w_8().h_full().disabled(this.depth === 1)
                .opacity(this.depth === 1 ? 0.35 : 1).rounded_l(5)
                .hover((el) => el.bg(tones.quietSurface))
                .on_click((_e, cx) => { this.depth = Math.max(1, this.depth - 1); cx.notify(); })
                .child(svg("disktree/icons/minus.svg").size_3().text_color(C.text)))
              .child(div().w_8().h_full().flex().items_center().justify_center()
                .border_x_1().border_color(C.border).text_size(12).font_medium().child(this.depth))
              .child(Button.new("more").w_8().h_full().disabled(this.depth === 6)
                .opacity(this.depth === 6 ? 0.35 : 1).rounded_r(5)
                .hover((el) => el.bg(tones.quietSurface))
                .on_click((_e, cx) => { this.depth = Math.min(6, this.depth + 1); cx.notify(); })
                .child(svg("disktree/icons/plus.svg").size_3().text_color(C.text))))))
          .child(
            h_flex()
              .w_72()
              .max_w("100%")
              .min_w_0()
              .flex_shrink_0()
              .h(32)
              .px(10)
              .gap(8)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(C.border)
              .bg(C.surface)
              .child(
                svg("disktree/icons/search.svg").size(16).text_color(C.muted),
              )
              .child(Input.new(this.filter).flex_1().min_w_0()),
          ),
      );
    const left = v_flex()
      .h_full()
      .min_h_0()
      .flex_1()
      .min_w_0()
      .px(layout.contentInset).py(16)
      .gap(12)
      .child(
        h_flex()
          .gap(12)
          .items_center()
          .child(
            this.text(
              this.loading
                ? `Scanning · ${this.progress.toLocaleString()} entries${this.root ? (this.partial ? " · partial" : " · previous scan") : ""}`
                : this.root
                  ? `${this.partial ? "Partial · " : ""}${formatSize(weight(this.root, "size", this.apparent))} · ${this.root.files.toLocaleString()} files · ${this.root.dirs.toLocaleString()} folders`
                  : "Choose a folder",
              13,
              C.muted,
            ).flex_1().min_w_0().truncate(),
          )
          .child(
            this.button("rescan", this.loading ? "Cancel" : "Rescan", (cx) => {
              if (this.loading) {
                this.generation++;
                this.loading = false;
                cx.notify();
              } else this.start(cx);
            }),
          ),
      )
      .child(
        div()
          .relative()
          .w_full()
          .flex_1()
          .min_h_0()
          .bg(tones.mapCanvas)
          .rounded(6)
          .overflow_hidden()
          .p(layout.mapInset).child(div().relative().size_full().children(this.root ? this.tiles(this.root, width - 8, height - 8) : []))
          .when(!this.root, (el) =>
            el.child(
              v_flex()
                .absolute()
                .inset_0()
                .items_center()
                .justify_center()
                .gap(8)
                .child(
                  this.text(
                    this.loading ? "Discovering folders…" : "No scan results",
                    18,
                    C.muted,
                  ),
                )
                .child(
                  this.text(
                    "The map will fill as entries are measured.",
                    12,
                    C.muted,
                  ),
                ),
            ),
          ),
      )
      .child(
        h_flex()
          .px(layout.mapInset + layout.tileInset)
          .flex_wrap()
          .gap_3()
          .children(
            categories.map((cat, i) =>
              h_flex()
                .gap(4)
                .child(div().size(10).rounded(2).bg(colors[i]))
                .child(this.text(cat, 11, C.muted)),
            ),
          ),
      );
    const right = v_flex()
      .id("selection-panel")
      .w(side)
      .max_w("48%")
      .min_w_0()
      .h_full()
      .min_h_0()
      .flex_shrink_0()
      .bg(C.surface)
      .border_l_1().border_color(C.border)
      .p_4()
      .gap(6)
      .overflow_y_scroll()
      .child(h_flex().items_center().justify_between().child(this.text("INSPECTOR", 10, C.muted).font_medium()).child(this.text(this.selected && this.selected.path !== this.root?.path ? "Selected item" : "Overview", 10, C.muted)));
    if (!n) {
      right
        .child(
          this.text(
            this.loading ? "Scanning your folder" : "Select a folder",
            22,
          ),
        )
        .child(this.text(this.path, 12, C.muted))
        .child(this.text("—", 38))
        .child(
          this.text(
            `${this.progress.toLocaleString()} entries found`,
            13,
            C.orange,
          ),
        )
        .child(
          this.text(
            "The map will fill as entries are discovered. Select a rectangle to inspect its details.",
            13,
            C.muted,
          ),
        );
    }
    if (n) {
      right
        .child(h_flex().gap(10).items_center().pt_2()
          .child(div().size(34).rounded(8).bg(tones.breadcrumbCurrent).flex().items_center().justify_center()
            .child(svg("disktree/icons/folder.svg").size(18).text_color(C.accent)))
          .child(this.text(n.name, 19).font_semibold().flex_1().min_w_0().truncate()))
        .child(this.text(n.path.replace(home, "~"), 11, C.muted).truncate().pb_2())
        .child(v_flex().gap_1().child(this.text("Space used", 11, C.muted))
          .child(this.text(formatSize(weight(n, "size", this.apparent)), 36).font_medium()))
        .child(
          div()
            .w_full()
            .h_2()
            .flex_shrink_0()
            .rounded(4)
            .bg(tones.progressTrack)
            .child(
              div()
                .id("selection-share")
                .when(this.animate, (el) => el.transition("width", motion))
                .h_full()
                .rounded(3)
                .bg(C.accent)
                .w(
                  `${Math.min(100, (weight(n, "size", this.apparent) / Math.max(1, weight(this.root, "size", this.apparent))) * 100)}%`,
                ),
            ),
        )
        .child(h_flex().w_full().gap_4().pt_2()
          .child(v_flex().flex_1().gap(5).child(this.text("OF SCAN", 10, C.muted))
            .child(this.text(`${((weight(n, "size", this.apparent) / Math.max(1, weight(this.root, "size", this.apparent))) * 100).toFixed(1)}%`, 17).font_medium()))
          .child(v_flex().flex_1().gap(5).child(this.text("FILES", 10, C.muted))
            .child(this.text(n.files.toLocaleString(), 17).font_medium())))
        .child(h_flex().w_full().gap_4().pt_2()
          .child(v_flex().flex_1().gap(5).child(this.text("LAST MODIFIED", 10, C.muted))
            .child(this.text(n.modified ? new Date(n.modified).toLocaleDateString() : "—", 12)))
          .child(v_flex().flex_1().gap(5).child(this.text("CATEGORY", 10, C.muted))
            .child(this.text(n.category, 12))))
        .child(h_flex().w_full().gap_2().items_stretch().pt_2()
          .child(this.button("open", "Open", (cx) => this.action(cx, async () => {
            const result = await deps.run("xdg-open", [n.path]);
            if (result.code !== 0) throw Error(result.stderr);
          })).flex_1().min_w_0().justify_center())
          .child(this.button("browse", "Browse", (cx) => {
            if (n.directory) this.navigate(n.path, cx);
          }, false, !n.directory).flex_1().min_w_0().justify_center())
          .child(this.button("mark", this.marked.has(n.path) ? "Unmark" : "Mark", (cx) => this.toggle(cx),
            false, n.path === this.path || n.path === home || !inside(n.path, home))
            .flex_1().min_w_0().justify_center()));
    }
    right.child(
      this.button(
        "review",
        `Review ${this.marked.size} marked`,
        (cx) => {
          this.review = !this.review;
          cx.notify();
        },
        this.review,
        this.marked.size === 0,
      ).h_8().flex_shrink_0(),
    );
    if (this.review) {
      right
        .child(
          this.text(
            "Move selected items to private, recoverable Trash. Nothing is permanently deleted.",
            12,
            C.muted,
          ),
        )
        .children([...this.marked].map((p) => this.text(p, 12)))
        .child(
          this.button(
            "confirm",
            "Move to Trash",
            (cx) => this.remove(cx),
            false,
            this.marked.size === 0,
          ),
        );
    }
    if (this.review)
      right.child(this.button("delete-selection", "Delete permanently…", (cx) => this.confirmDeletion(cx), false, this.marked.size === 0));
    right
      .child(div().h(1).w_full().bg(C.border).mt_1())
      .child(this.text("Worth a look", 12, C.muted).font_medium());
    if (this.partial)
      right.child(this.text(this.loading ? "Scan in progress · sizes are estimates" : "Partial results · rescan to finish", 11, C.muted));
    if (this.root)
      right.children(
        this.suggestionCache
          .map((item) =>
            Button.new(`suggest-${item.path}`).w_full().h(40).flex_shrink_0().px_2().rounded(6)
              .hover((el) => el.bg(tones.rowHover))
              .on_click((_e, cx) => { this.selected = item; cx.notify(); })
              .child(h_flex().w_full().gap_2().items_start()
                .child(div().w_4().h(18).flex_shrink_0().flex().items_center().justify_center()
                  .child(svg("disktree/icons/folder.svg").size(14).text_color(C.muted)))
                .child(v_flex().flex_1().min_w_0().gap(4)
                  .child(this.text(item.name, 12).font_medium().truncate())
                  .child(this.text(item.path.replace(this.path + "/", ""), 10, C.muted).truncate()))
                .child(v_flex().w(76).flex_shrink_0().gap(6).items_end()
                  .child(this.text(formatSize(item.allocated), 12).font_medium())
                  .child(div().w(76).h(5).rounded(3).bg(tones.suggestionTrack)
                    .child(div().h_full().rounded(2).bg(C.accent)
                      .w(`${Math.max(2, Math.min(100, item.allocated / Math.max(1, this.root.allocated) * 100))}%`))))),
          ),
      );
    if (this.trashEntries.length) {
      right.child(this.text("RECOVERABLE TRASH", 11, C.muted)).children(
        this.trashEntries.map((entry) =>
          this.button(`restore-${entry.id}`, `Restore ${entry.name}`, (cx) =>
            this.action(cx, async () => {
              await restore(deps, entry);
              this.start(cx);
            }),
          ),
        ),
      );
    }
    if (this.trashEntries.length)
      right.child(
        this.button("empty-trash", "Empty app Trash…", (cx) =>
          this.reviewPurge(cx),
        ),
      );
    if (this.purgeReview) {
      const review = this.purgeReview;
      right
        .child(
          this.text(
            `Permanently delete ${review.entries.length} items?`,
            16,
            C.orange,
          ),
        )
        .children(review.entries.map((entry) => this.text(entry.name, 12)))
        .child(
          this.text(
            `${review.allocated.toLocaleString()} allocated bytes (${formatSize(review.allocated)}). Estimated space recoverable; hardlinks and snapshots can reduce actual free space.`,
            12,
            C.muted,
          ),
        )
        .child(
          this.text(
            "This cannot be undone. Only app Trash items listed above will be deleted.",
            12,
            C.orange,
          ),
        )
        .child(
          this.button("cancel-purge", "Keep in Trash", (cx) => {
            this.purgeReview = null;
            cx.notify();
          }),
        )
        .child(
          this.button("confirm-purge", "Delete permanently", (cx) =>
            this.confirmPurge(cx),
          ),
        );
    }
    if (this.busy) right.child(this.text("Moving files…", 12, C.orange));
    if (this.disk)
      right
        .child(this.text(`${formatSize(this.disk.free)} free`, 21))
        .child(
          this.text(
            `${formatSize(this.disk.used)} used / ${formatSize(this.disk.total)} total`,
            12,
            C.muted,
          ),
        )
        .child(
          div()
            .h(6)
            .w(`${Math.min(100, (this.disk.used / this.disk.total) * 100)}%`)
            .bg(C.accent)
            .rounded(3),
        );
    return v_flex()
      .size_full()
      .bg(C.bg)
      .text_size(13)
      .text_color(C.text)
      .track_focus(this.focus)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(top)
      .when(Boolean(this.message), (el) =>
        el.child(h_flex().w_full().flex_shrink_0().px(layout.contentInset).py(2).gap_2().items_center().min_h(28)
          .bg(tones.warningSurface).border_y_1().border_color(tones.warningBorder)
          .child(svg("disktree/icons/info.svg").size(14).flex_shrink_0().text_color(tones.warningIcon))
          .child(this.text(this.message, 12, tones.warningText).flex_1().min_w_0())
          .child(Button.new("dismiss-message").accessibility_label("Dismiss scan message").size(24).flex_shrink_0().rounded(4)
            .hover((el) => el.bg(tones.warningHover))
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.message = ""; cx.notify(); })
            .child(svg("disktree/icons/close.svg").size(12).text_color(tones.warningIcon)))),
      )
      .when(this.errors.length > 0, (el) =>
        el.child(
          this.button(
            "errors",
            `${this.errors.length} scan warnings ${this.expanded ? "▴" : "▾"}`,
            (cx) => {
              this.expanded = !this.expanded;
              cx.notify();
            },
          ),
        ),
      )
      .when(this.expanded, (el) =>
        el.child(
          div()
            .id("errors-details")
            .h(90)
            .overflow_y_scroll()
            .children(
              this.errors.slice(0, 50).map((e) => this.text(e, 12, C.muted)),
            ),
        ),
      )
      .child(
        h_flex()
          .flex_1()
          .min_h_0()
          .items_stretch()
          .gap(0)
          .child(left)
          .when(showInspector, (el) => el.child(right)),
      )
      .child(
        h_flex()
          .min_h(24)
          .px(layout.contentInset + layout.mapInset + layout.tileInset)
          .py(3)
          .gap_3()
          .flex_wrap()
          .bg(C.surface)
          .border_t_1()
          .border_color(C.border)
          .children(
            [
              ["Space", "mark"],
              ["Enter", "browse"],
              ["⌫", "up"],
              ["c", "review"],
              ["hjkl", "select"],
              ["/", "filter"],
              ["[ ]", "depth"],
              ["t", "metric"],
              ["r", "rescan"],
              ["0", "reset"],
              ["m", this.animate ? "motion on" : "motion off"],
              ["i", "inspector"],
            ].map(([key, label]) =>
              h_flex()
                .gap_1()
                .items_center()
                .child(
                  div()
                    .px(3)
                    .py(0)
                    .h(16).flex().items_center().justify_center()
                    .rounded(2)
                    .bg(tones.quietSurface)
                    .child(this.text(key, 10)),
                )
                .child(this.text(label, 10, C.muted)),
            ),
          ),
      );
  }
}
