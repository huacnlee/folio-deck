// @ts-check
import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, Button, Input, InputState, Popup, TextView, h_resizable, resizable_panel, v_virtual_list, VirtualListScrollHandle } from 'gpui-base';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { applyPalette, tones as T } from './theme.js';
import { DEFAULT, systemPalette } from './lib/theme.js';
import {
  reason, join, parent, basename, displayPath, resolvePath, readDirectory, visibleEntries, formatSize,
  newFolder, rename, transfer, trash, readTrash, restore, preview, command, moveNoReplace,
} from './lib/files.js';

const home = homedir();
const appRoot = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/\/$/, '');
const deps = { fs, home, store: process.dataDir ?? '', run: (name, args) => process.run(name, args), random: randomUUID, now: () => Date.now() };
const PREFS = 'finder.preferences.v1';
// Folders up to this size render plain rows, which can own drag and hover
// handlers; larger folders use the virtual list.
const PLAIN_ROWS = 1500;
const icon = (name, size = 14) => svg(`finder/icons/${name}.svg`).size(size).flex_shrink_0();
const iconFor = (entry) => ({ Folder: 'folder', Image: 'image', Video: 'video', Audio: 'music', Archive: 'archive', Code: 'code' })[entry.directory ? 'Folder' : entry.type] ?? 'file';
function load() { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { return {}; } }
function store(value) { try { localStorage.setItem(PREFS, JSON.stringify(value)); } catch {} }
function date(value) { return value ? new Date(value).toLocaleDateString() : '—'; }

export default class Finder extends View {
  init(_props, cx) {
    const prefs = load();
    this.palette = DEFAULT;
    applyPalette();
    this.focus = cx.focus_handle();
    this.pathFocus = cx.focus_handle();
    this.searchFocus = cx.focus_handle();
    this.formFocus = cx.focus_handle();
    this.editProxyState = null;
    this.tabs = [];
    this.activeId = null;
    this.splitId = null;
    this.sidebar = prefs.sidebar !== false;
    this.inspector = prefs.inspector !== false;
    // Omarchy UI text is the system monospace alias, resolved like the shell does.
    this.font = process.platform === 'darwin' ? 'Menlo' : 'JetBrainsMono Nerd Font';
    this.menu = null;
    this.rowMenuPending = false;
    this.drag = null;
    this.viewMode = prefs.viewMode === 'grid' ? 'grid' : 'list';
    this.hidden = prefs.hidden === true;
    this.sort = ['name', 'size', 'modified'].includes(prefs.sort) ? prefs.sort : 'name';
    this.descending = prefs.descending === true;
    this.bookmarks = Array.isArray(prefs.bookmarks) ? prefs.bookmarks.filter((path) => typeof path === 'string' && path.startsWith('/')).slice(0, 30) : [];
    this.clipboard = null;
    this.busy = null;
    this.message = null;
    this.dialog = null;
    this.previewEntry = null;
    this.previewData = null;
    this.previewGeneration = 0;
    this.lastUndo = [];
    this.gridLimit = 240;
    this.location = InputState.new({ placeholder: 'Go to folder…' });
    this.location.on('submit', (_event, cx) => {
      try { this.navigate(resolvePath(this.location.value(), this.active().path, home), cx); }
      catch (error) { this.message = { error: true, text: reason(error) }; cx.notify(); }
    });
    this.search = InputState.new({ placeholder: 'Search this folder' });
    this.search.on('change', (_event, cx) => {
      this.active().query = this.search.value();
      this.gridLimit = 240;
      cx.notify();
    });
    this.form = InputState.new({ placeholder: 'Name' });
    this.form.on('change', (_event, cx) => cx.notify());
    this.form.on('submit', (_event, cx) => this.submitDialog(cx));
    const initial = Array.isArray(prefs.paths) ? prefs.paths.filter((path) => typeof path === 'string' && path.startsWith('/')).slice(0, 6) : [];
    for (const path of initial.length ? initial : [home]) this.addTab(path, cx, false);
    this.activate(this.tabs[0].id, cx);
    if (process.platform !== 'darwin') cx.spawn(async (cx) => {
      const result = await command(deps, 'fc-match', ['monospace', '-f', '%{family[0]}']).catch(() => '');
      const family = String(result).trim();
      if (family) { this.font = family; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const palette = await systemPalette(fs, home);
        if (JSON.stringify(palette) !== JSON.stringify(this.palette)) {
          this.palette = palette;
          applyPalette(palette);
          cx.notify();
        }
        await cx.sleep(2500);
      }
    });
  }
  active() { return this.tabs.find((tab) => tab.id === this.activeId) ?? this.tabs[0]; }
  persist() { store({ paths: this.tabs.filter((tab) => tab.path !== '@trash').map((tab) => tab.path), bookmarks: this.bookmarks, viewMode: this.viewMode, hidden: this.hidden, sidebar: this.sidebar, inspector: this.inspector, sort: this.sort, descending: this.descending }); }
  addTab(path, cx, select = true) {
    const tab = { id: randomUUID(), path, history: [path], historyIndex: 0, entries: [], selected: new Set(), query: '', loading: false, error: null, generation: 0, anchor: null, scroll: VirtualListScrollHandle.new() };
    this.tabs.push(tab);
    if (select) this.activate(tab.id, cx);
    this.scan(tab, cx);
    return tab;
  }
  activate(id, cx) {
    if (this.splitId === id && this.activeId !== id) this.splitId = this.activeId;
    this.activeId = id;
    this.location.set_value(this.active().path === '@trash' ? 'Trash' : displayPath(this.active().path, home));
    this.search.set_value(this.active().query);
    this.focus.focus();
    this.persist();
    this.syncPreview(cx);
    cx.notify();
  }
  closeTab(id, cx) {
    if (this.tabs.length === 1) return;
    this.tabs = this.tabs.filter((tab) => tab.id !== id);
    if (this.splitId === id) this.splitId = null;
    if (this.activeId === id) this.activate(this.tabs[0].id, cx);
    this.persist(); cx.notify();
  }
  navigate(path, cx, tab = this.active(), record = true) {
    tab.path = path;
    tab.selected.clear(); tab.anchor = null; tab.query = '';
    if (record) { tab.history = tab.history.slice(0, tab.historyIndex + 1); tab.history.push(path); tab.historyIndex++; }
    this.gridLimit = 240;
    if (tab.id === this.activeId) {
      this.location.set_value(path === '@trash' ? 'Trash' : displayPath(path, home));
      this.search.set_value('');
    }
    this.persist(); this.scan(tab, cx); cx.notify();
  }
  history(delta, cx) {
    const tab = this.active(), next = tab.historyIndex + delta;
    if (next < 0 || next >= tab.history.length) return;
    tab.historyIndex = next; this.navigate(tab.history[next], cx, tab, false);
  }
  scan(tab, cx) {
    const generation = ++tab.generation, path = tab.path;
    tab.loading = true; tab.error = null; tab.entries = [];
    cx.spawn(async (cx) => {
      try {
        const entries = path === '@trash' ? await readTrash(deps) : await readDirectory(fs, path);
        if (tab.generation !== generation) return;
        tab.entries = entries;
        const available = new Set(entries.map((entry) => entry.path));
        tab.selected = new Set([...tab.selected].filter((item) => available.has(item)));
      } catch (error) { if (tab.generation === generation) tab.error = reason(error); }
      if (tab.generation === generation) { tab.loading = false; this.syncPreview(cx); cx.notify(); }
    });
  }
  visible(tab) { return visibleEntries(tab.entries, { query: tab.query, hidden: this.hidden || tab.path === '@trash', sort: this.sort, descending: this.descending }); }
  selected() { return this.active().entries.filter((entry) => this.active().selected.has(entry.path)); }
  select(entry, event, cx, tab) {
    if (tab.id !== this.activeId) this.activate(tab.id, cx);
    const additive = event.modifiers.control || event.modifiers.platform;
    if (event.modifiers.shift && tab.anchor) {
      const entries = this.visible(tab), a = entries.findIndex((item) => item.path === tab.anchor), b = entries.findIndex((item) => item.path === entry.path);
      if (!additive) tab.selected.clear();
      for (const item of entries.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1)) tab.selected.add(item.path);
    } else if (additive) {
      if (tab.selected.has(entry.path)) tab.selected.delete(entry.path); else tab.selected.add(entry.path);
      tab.anchor = entry.path;
    } else { tab.selected = new Set([entry.path]); tab.anchor = entry.path; }
    this.focus.focus();
    if (event.click_count >= 2 && tab.path !== '@trash') this.open(entry, cx, tab);
    this.syncPreview(cx);
    cx.notify();
  }
  open(entry, cx, tab = this.active()) {
    if (entry.directory) this.navigate(entry.path, cx, tab);
    else this.openExternal(entry, cx);
  }
  // The system opener: the default app for a file, the file manager for a folder.
  openExternal(entry, cx) {
    try { cx.open_path(entry.path); }
    catch (error) { this.message = { error: true, text: `Couldn’t open “${entry.name}”. ${reason(error)}` }; cx.notify(); }
  }
  showDialog(kind, cx) {
    const entry = this.selected()[0];
    if (kind === 'rename' && this.selected().length !== 1) return;
    this.dialog = { kind, entry, paths: this.selected().map((item) => item.path), directory: this.active().path, error: null };
    this.form.set_value(kind === 'rename' ? entry.name : kind === 'goto' ? displayPath(this.active().path, home) : '');
    this.beginEditing(this.form, this.formFocus);
    cx.notify();
  }
  async submitDialogWork(dialog) {
    const name = this.form.value().trim();
    if (dialog.kind === 'new') return newFolder(deps, dialog.directory, name);
    if (dialog.kind === 'rename') {
      const to = await rename(deps, dialog.entry.path, name);
      this.lastUndo = [{ from: to, to: dialog.entry.path }]; return to;
    }
    if (dialog.kind === 'trash') {
      const result = await trash(deps, dialog.paths, (done, total) => { this.busy = `Moving to Trash ${done}/${total}`; });
      this.lastUndo = result.entries.map((entry) => ({ trash: entry }));
      if (result.failures.length) throw new Error(result.failures.map((failure) => `${basename(failure.path)}: ${failure.message}`).join('\n'));
    }
  }
  submitDialog(cx) {
    const dialog = this.dialog;
    if (!dialog || this.busy) return;
    if (dialog.kind === 'goto') {
      try { const path = resolvePath(this.form.value(), this.active().path, home); this.dialog = null; this.navigate(path, cx); }
      catch (error) { dialog.error = reason(error); cx.notify(); }
      return;
    }
    this.busy = 'Working…'; dialog.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const before = this.lastUndo;
      try { await this.submitDialogWork(dialog); this.dialog = null; this.message = { text: { new: 'Folder created.', rename: 'Renamed.', trash: 'Moved to Trash.' }[dialog.kind] ?? 'Done.', undo: this.lastUndo !== before && this.lastUndo.length > 0 }; }
      catch (error) { dialog.error = reason(error); }
      this.busy = null;
      for (const tab of this.tabs) this.scan(tab, cx);
      cx.notify();
    });
  }
  perform(cx, label, work, reload = true) {
    if (this.busy) return;
    this.busy = label; this.message = null; cx.notify();
    cx.spawn(async (cx) => {
      const before = this.lastUndo;
      try { const text = await work(); this.message = { text: typeof text === 'string' && text ? text : 'Done.', undo: this.lastUndo !== before && this.lastUndo.length > 0 }; }
      catch (error) { this.message = { error: true, text: reason(error) }; }
      this.busy = null;
      if (reload) for (const tab of this.tabs) this.scan(tab, cx);
      cx.notify();
    });
  }
  copy(cut, cx) {
    const selected = this.selected();
    if (!selected.length || this.active().path === '@trash') return;
    this.clipboard = { paths: selected.map((entry) => entry.path), cut };
    this.message = { text: `${selected.length} item${selected.length === 1 ? '' : 's'} ready to ${cut ? 'move' : 'copy'}. Navigate to a folder and paste.` };
    cx.notify();
  }
  paste(cx) {
    if (!this.clipboard || this.active().path === '@trash') return;
    const clipboard = { paths: [...this.clipboard.paths], cut: this.clipboard.cut }, destination = this.active().path;
    this.perform(cx, 'Transferring files…', async () => {
      const result = await transfer(deps, clipboard.paths, destination, clipboard.cut);
      if (clipboard.cut) {
        this.lastUndo = result.finished.map((item) => ({ from: item.to, to: item.from }));
        this.clipboard = result.failures.length ? { paths: result.failures.map((item) => item.path), cut: true } : null;
      }
      if (result.failures.length) throw new Error(`${result.finished.length} completed. ${result.failures.map((item) => `${basename(item.path)}: ${item.message}`).join(' · ')}`);
      return `${result.finished.length} item${result.finished.length === 1 ? '' : 's'} ${clipboard.cut ? 'moved' : 'copied'}.`;
    });
  }
  undo(cx) {
    if (!this.lastUndo.length) return;
    this.perform(cx, 'Undoing…', async () => {
      const remaining = [...this.lastUndo];
      while (remaining.length) {
        const action = remaining[0];
        if (action.trash) await restore(deps, action.trash);
        else await moveNoReplace(deps, action.from, action.to);
        remaining.shift(); this.lastUndo = [...remaining];
      }
      return 'Last change undone.';
    });
  }
  restoreSelected(cx) {
    const selected = this.selected();
    this.perform(cx, 'Restoring…', async () => {
      const failures = [], restored = [];
      for (const entry of selected) {
        try { restored.push(await restore(deps, entry)); } catch (error) { failures.push(`${entry.name}: ${reason(error)}`); }
      }
      if (failures.length) throw new Error(`${restored.length} restored. ${failures.join(' · ')}`);
      return `${restored.length} item${restored.length === 1 ? '' : 's'} restored.`;
    });
  }
  bookmark(cx) {
    const path = this.active().path;
    if (path === '@trash') return;
    if (this.bookmarks.includes(path)) this.bookmarks = this.bookmarks.filter((item) => item !== path);
    else this.bookmarks.push(path);
    this.persist(); cx.notify();
  }
  toggleSplit(cx) {
    if (this.splitId) this.splitId = null;
    else { const other = this.tabs.find((tab) => tab.id !== this.activeId) ?? this.addTab(this.active().path, cx, false); this.splitId = other.id; }
    cx.notify();
  }
  // The inspector previews the single selected file of the active pane.
  syncPreview(cx) {
    const tab = this.active(), picked = this.selected();
    const entry = this.panes().inspector && picked.length === 1 ? picked[0] : null;
    if (entry?.path === this.previewEntry?.path && entry?.modified === this.previewEntry?.modified) return;
    const generation = ++this.previewGeneration;
    this.previewEntry = entry; this.previewData = null;
    if (!entry || tab.loading) return;
    cx.spawn(async (cx) => {
      let data;
      try {
        data = await preview(fs, entry);
        if (data.kind === 'image') {
          const name = `preview-${randomUUID()}.${entry.name.split('.').pop().toLowerCase()}`;
          const current = `${appRoot}/finder/cache/${name}`;
          await fs.mkdir(`${appRoot}/finder/cache`, { recursive: true });
          await fs.writeFile(current, await fs.readFile(entry.path));
          if (generation !== this.previewGeneration) { await command(deps, 'rm', ['-f', '--', current]).catch(() => {}); return; }
          data.asset = `finder/cache/${name}`;
          const previous = this.previewAsset;
          this.previewAsset = current;
          if (previous) await command(deps, 'rm', ['-f', '--', previous]).catch(() => {});
        }
      } catch (error) { data = { kind: 'error', text: reason(error) }; }
      if (generation === this.previewGeneration) { this.previewData = data; cx.notify(); }
    });
  }
  // Narrow windows collapse the side panes. What the toggles show and flip is
  // what is on screen: turning a collapsed pane on forces it open until the
  // window is wide enough to show it anyway.
  panes() {
    let width = Infinity;
    try { width = window.viewport_size().width || Infinity; } catch {}
    return {
      sidebar: this.sidebar && (width >= 620 || this.forceSidebar === true),
      inspector: this.inspector && (width >= 960 || this.forceInspector === true),
    };
  }
  toggleSidebar(cx) {
    const shown = this.panes().sidebar;
    this.sidebar = !shown; this.forceSidebar = !shown;
    this.persist(); cx.notify();
  }
  toggleInspector(cx) {
    const shown = this.panes().inspector;
    this.inspector = !shown; this.forceInspector = !shown;
    this.persist(); this.syncPreview(cx); cx.notify();
  }
  // Input owns its native focus. A wrapper handles direct keyboard entry after
  // shortcuts; clicking the input still uses the host's complete native editor.
  beginEditing(state, focus) {
    this.editProxyState = { state, cursor: state.value().length, anchor: 0 };
    state.set_selected_range({ start: 0, end: state.value().length });
    focus.focus();
  }
  editKey(event, cx) {
    const edit = this.editProxyState;
    if (!edit) return;
    const key = event.key.toLowerCase(), value = edit.state.value();
    const ctrl = event.modifiers.control || event.modifiers.platform;
    let start = Math.min(edit.cursor, edit.anchor), end = Math.max(edit.cursor, edit.anchor);
    let insert = null;
    if (ctrl && key === 'a') { edit.cursor = value.length; edit.anchor = 0; }
    else if (!ctrl && !event.modifiers.alt && event.key_char) insert = event.key_char;
    else if (key === 'backspace') { if (start === end) start = Math.max(0, start - 1); insert = ''; }
    else if (key === 'delete') { if (start === end) end = Math.min(value.length, end + 1); insert = ''; }
    else if (['left', 'right', 'home', 'end'].includes(key)) {
      edit.cursor = key === 'home' ? 0 : key === 'end' ? value.length : Math.max(0, Math.min(value.length, edit.cursor + (key === 'left' ? -1 : 1)));
      if (!event.modifiers.shift) edit.anchor = edit.cursor;
    } else return;
    if (insert !== null) {
      edit.state.set_value(value.slice(0, start) + insert + value.slice(end));
      edit.cursor = start + insert.length; edit.anchor = edit.cursor;
      if (edit.state === this.search) this.active().query = edit.state.value();
    }
    edit.state.set_selected_range({ start: Math.min(edit.cursor, edit.anchor), end: Math.max(edit.cursor, edit.anchor) });
    cx.stop_propagation(); cx.notify();
  }
  key(event, cx) {
    const key = event.key.toLowerCase(), ctrl = event.modifiers.control || event.modifiers.platform;
    if (this.dialog) {
      if (key === 'escape' && !this.busy) { this.dialog = null; this.focus.focus(); cx.notify(); }
      else if (this.formFocus.is_focused()) {
        if (key === 'enter') this.submitDialog(cx);
        else this.editKey(event, cx);
      }
      return;
    }
    if (this.menu) { this.menuKey(key, cx); cx.stop_propagation(); return; }
    if (ctrl && key === 'l') { this.showDialog('goto', cx); cx.stop_propagation(); return; }
    if (ctrl && key === 'f') { this.beginEditing(this.search, this.searchFocus); cx.stop_propagation(); return; }
    if (this.searchFocus.is_focused() || this.pathFocus.is_focused()) {
      if (key === 'escape') { this.focus.focus(); cx.notify(); }
      else if (key === 'enter' && this.pathFocus.is_focused()) {
        try { this.navigate(resolvePath(this.location.value(), this.active().path, home), cx); this.focus.focus(); }
        catch (error) { this.message = { error: true, text: reason(error) }; cx.notify(); }
      } else this.editKey(event, cx);
      return;
    }
    if (!this.focus.is_focused()) return;
    let handled = true;
    if (ctrl && key === 'h') { this.hidden = !this.hidden; this.persist(); cx.notify(); }
    else if (ctrl && key === 't') this.addTab(home, cx);
    else if (ctrl && key === 'w') this.closeTab(this.activeId, cx);
    else if (ctrl && key === 'd') this.bookmark(cx);
    else if (ctrl && key === 'c') this.copy(false, cx);
    else if (ctrl && key === 'x') this.copy(true, cx);
    else if (ctrl && key === 'v') this.paste(cx);
    else if (ctrl && key === 'z') this.undo(cx);
    else if (ctrl && event.modifiers.shift && key === 'n') this.showDialog('new', cx);
    else if (ctrl && key === 'a') { this.active().selected = new Set(this.visible(this.active()).map((entry) => entry.path)); cx.notify(); }
    else if (event.modifiers.alt && key === 'left') this.history(-1, cx);
    else if (event.modifiers.alt && key === 'right') this.history(1, cx);
    else if (event.modifiers.alt && key === 'up' && this.active().path !== '@trash') this.navigate(parent(this.active().path), cx);
    else if (key === 'f3') this.toggleSplit(cx);
    else if (key === 'f9') this.toggleSidebar(cx);
    else if (key === 'f2') this.showDialog('rename', cx);
    else if (key === 'f5') { this.scan(this.active(), cx); cx.notify(); }
    else if (key === 'delete' && this.selected().length && this.active().path !== '@trash') this.showDialog('trash', cx);
    else if (key === 'space') this.toggleInspector(cx);
    else if ((event.modifiers.shift && key === 'f10') || key === 'menu') this.openMenu(this.selected().length ? 'items' : 'folder', this.menuAnchor ?? { x: 320, y: 220 }, this.active(), cx);
    else if (key === 'enter') { const entry = this.selected()[0]; if (entry && this.active().path !== '@trash') this.open(entry, cx); }
    else if (key === 'escape') { this.active().selected.clear(); cx.notify(); }
    else if (['up', 'down', 'j', 'k', 'home', 'end'].includes(key) && !ctrl) {
      const tab = this.active(), entries = this.visible(tab), index = entries.findIndex((entry) => tab.selected.has(entry.path));
      const step = key === 'up' || key === 'k' ? -1 : 1;
      const next = key === 'home' ? 0 : key === 'end' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + step));
      if (entries[next]) { tab.selected = new Set([entries[next].path]); tab.anchor = entries[next].path; tab.scroll.scroll_to_item(next); cx.notify(); }
    } else handled = false;
    if (handled) { this.syncPreview(cx); cx.stop_propagation(); }
  }
  // Omarchy buttons: plain is transparent until hovered; outline, primary and
  // danger express emphasis through edge and text, never a solid fill.
  button(id, label, iconName, onClick, cx, { disabled = false, selected = false, variant = 'plain', tip = '' } = {}) {
    const edge = { plain: T.clear, outline: T.controlBorder, primary: T.accent, danger: T.danger }[variant];
    const ink = { primary: T.accent, danger: T.danger }[variant] ?? T.foreground;
    return Button.new(id).flex_shrink_0().px(label ? 10 : 6).py(6)
      .accessibility_label(label || tip || id)
      .border(1).border_color(edge).text_color(ink).text_size(12)
      .bg(selected ? T.selected : variant === 'outline' ? T.normal : T.clear)
      .when(selected, (el) => el.font_bold())
      .disabled(disabled).when(disabled, (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.hover((style) => style.bg(selected ? T.selected : T.hover)).active((style) => style.bg(T.pressed)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_click((_event, cx) => onClick(cx))
      .child(h_flex().gap(8).items_center()
        .when(Boolean(iconName), (el) => el.child(icon(iconName)))
        .when(Boolean(label), (el) => el.child(label)));
  }
  render(cx) {
    const active = this.active(), viewport = window.viewport_size();
    const { sidebar: showSidebar, inspector: showInspector } = this.panes();
    const split = Boolean(this.splitId && this.splitId !== active.id) ? this.tabs.find((tab) => tab.id === this.splitId) : null;
    return v_flex().id('finder').track_focus(this.focus).key_context('Finder').relative().size_full().min_w_0()
      .bg(T.background).text_color(T.foreground).text_size(12).font_family(this.font)
      .on_key_down((event, cx) => this.key(event, cx))
      .on_mouse_move((event, cx) => this.dragMove(event, cx))
      .on_mouse_up('left', (_event, cx) => this.dragEnd(cx))
      .child(this.renderTabs(cx))
      .child(h_flex().flex_1().min_h_0().min_w_0().items_stretch()
        .when(showSidebar, (el) => el.child(this.renderSidebar(viewport.width < 900, cx)))
        .child(v_flex().flex_1().min_w_0().min_h_0()
          .child(this.renderToolbar(cx))
          .when(Boolean(this.message || (this.clipboard && active.path !== '@trash')), (el) => el.child(this.renderBanner(cx)))
          .child(split
            // Panel sizes live under the group's id, so a drag survives repaints.
            ? h_resizable('split-panes').flex_1().min_h_0().min_w_0()
              .child(resizable_panel().size_range(240, 4000).child(this.renderPane(active, cx)))
              .child(resizable_panel().size_range(240, 4000).child(this.renderPane(split, cx)))
            : h_flex().flex_1().min_h_0().min_w_0().items_stretch().child(this.renderPane(active, cx))))
        .when(showInspector, (el) => el.child(this.renderInspector(cx))))
      .child(this.renderStatus(cx))
      .when(Boolean(this.drag?.active), (el) => el.child(this.renderDragGhost(cx)))
      .when(Boolean(this.dialog), (el) => el.child(this.renderOverlay(cx)))
      .when(Boolean(this.menu), (el) => el.child(this.renderMenu(cx)));
  }
  // Tabs are one segmented strip: shared 1px edges, the current tab takes the
  // selected fill, and every item in the bar shares the 24px line.
  renderTabs(cx) {
    return h_flex().h(34).flex_shrink_0().px(8).items_center().border_b(1).border_color(T.divider)
      .child(h_flex().id('tabs-scroll').flex_1().min_w_0().overflow_x_scrollbar().items_center()
        .children(this.tabs.map((tab, index) => {
          const current = tab.id === this.activeId;
          const title = tab.path === '@trash' ? 'Trash' : tab.path === home ? 'Home' : basename(tab.path);
          return h_flex().flex_shrink_0().h(24).max_w(220).when(index > 0, (el) => el.ml(-1))
            .border(1).border_color(T.controlBorder).bg(current ? T.selected : T.clear)
            .when(!current, (el) => el.hover((style) => style.bg(T.hover)))
            .child(Button.new(`tab-${tab.id}`).h_full().min_w(80).max_w(180).accessibility_label(title)
              .on_click((_e, cx) => this.activate(tab.id, cx))
              .child(h_flex().h_full().px(10).items_center().justify_start()
                .child(div().min_w_0().truncate().text_color(current ? T.bright : T.foreground).child(title))))
            .when(this.tabs.length > 1, (el) => el.child(Button.new(`close-${tab.id}`).size(16).mr(4).flex_shrink_0()
              .accessibility_label(`Close ${title}`).tooltip('Close tab (Ctrl + W)')
              .text_color(T.secondary).hover((style) => style.bg(T.hover).text_color(T.foreground))
              .on_click((_e, cx) => this.closeTab(tab.id, cx))
              .child(h_flex().size_full().items_center().justify_center().child(icon('close', 10)))));
        }))
        .child(Button.new('new-tab').size(24).ml(-1).flex_shrink_0().border(1).border_color(T.controlBorder)
          .accessibility_label('New tab').tooltip('New tab (Ctrl + T)')
          .hover((style) => style.bg(T.hover)).on_click((_e, cx) => this.addTab(home, cx))
          .child(h_flex().size_full().items_center().justify_center().child(icon('plus', 12)))));
  }
  renderSidebar(narrow, cx) {
    const defaults = [['home', 'Home', home], ['download', 'Downloads', join(home, 'Downloads')], ['file', 'Documents', join(home, 'Documents')], ['computer', 'Desktop', join(home, 'Desktop')], ['image', 'Pictures', join(home, 'Pictures')], ['music', 'Music', join(home, 'Music')], ['video', 'Videos', join(home, 'Videos')]];
    const dragging = Boolean(this.drag?.active), over = dragging && this.drag.overPlaces;
    const heading = (text) => div().h(28).px(8).pt(10).text_size(10).font_bold().text_color(T.secondary).child(text);
    // Base Button centers its content, and pointer listeners belong on an
    // element the shell owns, so a row wraps its Button.
    const item = (name, text, path, pinned = false) => {
      const current = this.active().path === path;
      return div().w_full().flex_shrink_0()
        .when(pinned, (el) => el.on_mouse_down('right', (event, cx) => { cx.stop_propagation(); this.pinMenu(path, event.position, cx); }))
        .child(Button.new(`place-${path}`).w_full().h(28).accessibility_label(text)
          .bg(current ? T.selected : T.clear).when(current, (el) => el.font_bold())
          .when(!current, (el) => el.hover((style) => style.bg(T.hover)))
          .on_click((_event, cx) => this.navigate(path, cx))
          .child(h_flex().w_full().h_full().px(8).gap(8).items_center().justify_start()
            .child(icon(name)).child(div().flex_1().min_w_0().truncate().child(text))));
    };
    return v_flex().id('places-scroll').w(narrow ? 148 : 196).flex_shrink_0().min_h_0().overflow_y_scrollbar().p(8).border_r(1).border_color(T.divider)
      .child(v_flex().id('places-drop')
        // Mouse moves over Places report its bounds; the root's drag handler
        // runs after this one and hit-tests the pointer against them.
        .on_mouse_move((event) => { this.placesBounds = event.bounds; })
        .child(heading('PLACES'))
        .children(defaults.map(([name, text, path]) => item(name, text, path)))
        .children(this.bookmarks.map((path) => item('bookmark', basename(path), path, true)))
        .when(dragging, (el) => el.child(h_flex().h(28).mt(2).px(8).gap(8).items_center().border(1)
          .border_color(over ? T.accent : T.controlBorder).bg(over ? T.hover : T.clear).text_color(over ? T.accent : T.secondary)
          .child(icon('plus')).child(div().truncate().child(this.drag.paths.length > 1 ? `Pin ${this.drag.paths.length} folders` : 'Drop to pin')))))
      .child(heading('LOCATIONS')).child(item('computer', 'File system', '/')).child(item('trash', 'Trash', '@trash'))
      .when(!this.bookmarks.length && !dragging, (el) => el.child(div().px(8).pt(14).text_size(11).text_color(T.secondary).child('Drag a folder here, or press Ctrl + D, to pin it.')));
  }
  // One row: navigation and location lead, search and view controls trail.
  renderToolbar(cx) {
    const tab = this.active(), trash = tab.path === '@trash', pinned = this.bookmarks.includes(tab.path);
    const field = (focus, name, input) => h_flex().track_focus(focus).h(28).px(10).gap(8).items_center().bg(T.normal).border(1).border_color(T.controlBorder)
      .child(div().text_color(T.secondary).child(icon(name, 12))).child(input.flex_1().min_w_0().text_size(12));
    return h_flex().w_full().h(40).flex_shrink_0().px(8).gap(8).items_center().border_b(1).border_color(T.divider)
      .child(h_flex().flex_shrink_0()
        .child(this.button('back', '', 'left', (cx) => this.history(-1, cx), cx, { disabled: tab.historyIndex === 0, tip: 'Back (Alt + Left)' }))
        .child(this.button('forward', '', 'right', (cx) => this.history(1, cx), cx, { disabled: tab.historyIndex >= tab.history.length - 1, tip: 'Forward (Alt + Right)' }))
        .child(this.button('parent', '', 'up', (cx) => this.navigate(parent(tab.path), cx), cx, { disabled: tab.path === '/' || trash, tip: 'Enclosing folder (Alt + Up)' })))
      .child(field(this.pathFocus, 'folder', Input.new(this.location)).flex_1().min_w(140))
      .child(field(this.searchFocus, 'search', Input.new(this.search)).w(240).flex_shrink_1().min_w(140))
      .child(h_flex().flex_shrink_0()
        .child(this.button('new-folder', '', 'plus', (cx) => this.showDialog('new', cx), cx, { disabled: Boolean(this.busy) || trash, tip: 'New folder… (Ctrl + Shift + N)' }))
        .child(this.button('pin', '', 'bookmark', (cx) => this.bookmark(cx), cx, { selected: pinned, disabled: trash, tip: pinned ? 'Unpin from Places (Ctrl + D)' : 'Pin to Places (Ctrl + D)' }))
        .child(this.button('hidden', '', this.hidden ? 'eye' : 'eye-off', (cx) => { this.hidden = !this.hidden; this.persist(); cx.notify(); }, cx, { selected: this.hidden, tip: 'Hidden files (Ctrl + H)' }))
        .child(this.button('refresh', '', 'refresh', (cx) => { this.scan(tab, cx); cx.notify(); }, cx, { tip: 'Refresh (F5)' }))
        .child(div().w(1).h(16).mx(4).bg(T.divider))
        .child(this.button('list-view', '', 'list', (cx) => { this.viewMode = 'list'; this.persist(); cx.notify(); }, cx, { selected: this.viewMode === 'list', tip: 'List' }))
        .child(this.button('grid-view', '', 'grid', (cx) => { this.viewMode = 'grid'; this.persist(); cx.notify(); }, cx, { selected: this.viewMode === 'grid', tip: 'Icons' })));
  }
  // One line, always: multi-line command output keeps its last line, which
  // names the failure, and the whole text stays available as a tooltip.
  renderBanner(cx) {
    const clip = this.clipboard && this.active().path !== '@trash' ? this.clipboard : null;
    const full = this.message?.text ?? `${clip.paths.length} item${clip.paths.length === 1 ? '' : 's'} ready to ${clip.cut ? 'move' : 'copy'}. Open a folder and paste.`;
    const text = full.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
    const detail = this.message?.detail ?? (text !== full.trim() ? full : '');
    return h_flex().h(32).flex_shrink_0().px(12).gap(6).items_center().border_b(1).border_color(T.divider)
      .child(div().id('banner-text').flex_1().min_w_0().truncate().text_color(this.message?.error ? T.danger : T.foreground)
        .when(Boolean(detail), (el) => el.tooltip(detail)).child(text))
      .when(Boolean(this.message?.copy), (el) => el.child(this.button('banner-copy', 'Copy path', '', (cx) => { cx.write_to_clipboard(this.message.copy); this.message = { text: 'Path copied' }; cx.notify(); }, cx, { variant: 'outline' }).py(2)))
      .when(Boolean(this.message?.undo && this.lastUndo.length), (el) => el.child(this.button('banner-undo', 'Undo', '', (cx) => this.undo(cx), cx, { variant: 'outline', disabled: Boolean(this.busy), tip: 'Ctrl + Z' }).py(2)))
      .when(Boolean(clip && !this.message), (el) => el
        .child(this.button('paste', 'Paste', '', (cx) => this.paste(cx), cx, { variant: 'outline', disabled: Boolean(this.busy), tip: 'Ctrl + V' }).py(2))
        .child(this.button('cancel-paste', 'Cancel', '', (cx) => { this.clipboard = null; cx.notify(); }, cx).py(2)))
      .when(Boolean(this.message), (el) => el.child(this.button('dismiss-message', '', 'close', (cx) => { this.message = null; cx.notify(); }, cx, { tip: 'Dismiss' }).py(2)));
  }
  renderPane(tab, cx) {
    const entries = this.visible(tab);
    const empty = (title, description) => v_flex().flex_1().p(18).gap(8).items_center().justify_center()
      .child(div().text_color(T.secondary).child(icon(tab.error ? 'info' : 'folder', 18)))
      .child(div().font_bold().child(title)).child(div().max_w(420).text_color(T.secondary).child(description));
    // Header and rows share lanes: icon, name, size, modified.
    const column = (sort, text, width) => Button.new(`sort-${sort}-${tab.id}`).h_full().accessibility_label(`Sort by ${text.toLowerCase()}`)
      .when(Boolean(width), (el) => el.w(width).flex_shrink_0()).when(!width, (el) => el.flex_1().min_w_0())
      .on_click((_e, cx) => this.sortBy(sort, cx))
      .child(h_flex().w_full().h_full().gap(4).items_center().when(Boolean(width), (el) => el.justify_end()).when(!width, (el) => el.justify_start())
        .text_color(this.sort === sort ? T.foreground : T.secondary)
        .child(text).when(this.sort === sort, (el) => el.child(this.descending ? '↓' : '↑')));
    const header = h_flex().h(28).flex_shrink_0().px(12).gap(8).items_center().border_b(1).border_color(T.divider).text_size(11).font_bold()
      .child(div().w(14).flex_shrink_0()).child(column('name', 'Name', 0)).child(column('size', 'Size', 80)).child(column('modified', 'Modified', 96));
    const ready = !tab.loading && !tab.error, plain = entries.length <= PLAIN_ROWS;
    return v_flex().id(`pane-body-${tab.id}`).size_full().min_w_0().min_h_0()
      // Virtual list rows cannot own handlers; the press that precedes a row's
      // click carries its modifiers and click count.
      .on_mouse_down('left', (event) => { this.press = event; })
      .on_mouse_down('right', (event, cx) => {
        if (this.rowMenuPending) { this.rowMenuPending = false; return; }
        this.activate(tab.id, cx); tab.selected.clear(); this.syncPreview(cx);
        this.openMenu('folder', event.position, tab, cx);
      })
      .when(Boolean(this.splitId), (el) => el.child(Button.new(`pane-${tab.id}`).w_full().h(24).flex_shrink_0().bg(tab.id === this.activeId ? T.selected : T.clear).text_size(11).on_click((_event, cx) => this.activate(tab.id, cx))
        .child(h_flex().w_full().h_full().px(12).items_center().child(div().truncate().text_color(tab.id === this.activeId ? T.foreground : T.secondary).child(tab.path === '@trash' ? 'Trash' : displayPath(tab.path, home))))))
      .when(tab.loading, (el) => el.child(empty('Reading folder…', displayPath(tab.path, home))))
      .when(Boolean(tab.error), (el) => el.child(empty('Couldn’t open this folder', tab.error).child(this.button(`retry-${tab.id}`, 'Retry', 'refresh', (cx) => { this.scan(tab, cx); cx.notify(); }, cx, { variant: 'outline' }))))
      .when(ready && entries.length === 0, (el) => el.child(empty(tab.query ? 'No matching files' : tab.path === '@trash' ? 'Trash is empty' : 'This folder is empty', tab.query ? 'Try another search, or show hidden files with Ctrl + H.' : tab.path === '@trash' ? 'Items moved to Trash in Finder can be restored here.' : 'Create a folder with Ctrl + Shift + N, or paste files here.')))
      .when(ready && entries.length > 0 && this.viewMode === 'list' && plain, (el) => el.child(header)
        .child(v_flex().id(`rows-${tab.id}`).flex_1().min_h_0().overflow_y_scrollbar().children(entries.map((entry) => this.fileRow(entry, tab, cx, true)))))
      .when(ready && entries.length > 0 && this.viewMode === 'list' && !plain, (el) => el.child(header).child(v_virtual_list(`files-${tab.id}`, entries.length, 28, (index) => entries[index].path,
        (range, cx) => entries.slice(range.start, range.end).map((entry) => this.fileRow(entry, tab, cx, false)))
        .flex_1().min_h_0().w_full().track_scroll(tab.scroll)
        .on_item_click((key, cx) => {
          const entry = entries.find((item) => item.path === key);
          if (entry) this.select(entry, this.press ?? { click_count: 1, modifiers: {} }, cx, tab);
        })
        .on_item_secondary_click((key, event, cx) => { this.rowMenuPending = true; this.rowMenu(key, event.position, tab, cx); })))
      .when(ready && entries.length > 0 && this.viewMode === 'grid', (el) => el.child(v_flex().id(`grid-${tab.id}`).flex_1().min_h_0().overflow_y_scrollbar().p(12).gap(12)
        .child(h_flex().flex_wrap().gap(6).children(entries.slice(0, this.gridLimit).map((entry) => this.fileTile(entry, tab, cx))))
        .when(entries.length > this.gridLimit, (el) => el.child(this.button(`more-${tab.id}`, `Show ${Math.min(240, entries.length - this.gridLimit)} more`, '', (cx) => { this.gridLimit += 240; cx.notify(); }, cx, { variant: 'outline' })))));
  }
  sortBy(sort, cx) { this.descending = this.sort === sort ? !this.descending : false; this.sort = sort; this.persist(); cx.notify(); }
  // Plain rows (and tiles) own their pointer handlers: click, context menu,
  // and the press that may start dragging a folder to Places.
  interactive(el, entry, tab) {
    return el.on_click((event, cx) => this.select(entry, event, cx, tab))
      .on_mouse_down('left', (event) => { this.dragStart(entry, tab, event); })
      .on_mouse_down('right', (event, cx) => { this.rowMenuPending = true; this.rowMenu(entry.path, event.position, tab, cx); });
  }
  fileRow(entry, tab, cx, plain) {
    const selected = tab.selected.has(entry.path);
    const row = h_flex().id(`row-${entry.path}`).h(28).flex_shrink_0().px(12).gap(8).items_center().w_full()
      .bg(selected ? T.selected : T.clear).when(!selected, (el) => el.hover((style) => style.bg(T.hover)))
      .when(Boolean(this.clipboard?.cut && this.clipboard.paths.includes(entry.path)), (el) => el.opacity(0.5))
      .child(div().w(14).flex_shrink_0().text_color(entry.error ? T.danger : entry.directory ? T.foreground : T.secondary).child(icon(iconFor(entry))))
      .child(div().flex_1().min_w_0().truncate().when(selected, (el) => el.text_color(T.bright)).child(entry.name))
      .child(div().w(80).flex_shrink_0().truncate().text_right().text_size(11).text_color(T.secondary).child(entry.directory ? '—' : formatSize(entry.size)))
      .child(div().w(96).flex_shrink_0().truncate().text_right().text_size(11).text_color(T.secondary).child(date(entry.modified)));
    return plain ? this.interactive(row, entry, tab) : row;
  }
  fileTile(entry, tab, cx) {
    const selected = tab.selected.has(entry.path);
    return this.interactive(v_flex().id(`tile-${entry.path}`).w(112).p(8).gap(6).items_center()
      .bg(selected ? T.selected : T.clear).when(!selected, (el) => el.hover((style) => style.bg(T.hover)))
      .child(div().pt(6).text_color(entry.error ? T.danger : entry.directory ? T.foreground : T.secondary).child(icon(iconFor(entry), 32)))
      .child(div().w_full().truncate().text_center().child(entry.name))
      .child(div().text_size(10).text_color(T.secondary).child(entry.directory ? 'Folder' : formatSize(entry.size))), entry, tab);
  }
  // Dragging folders onto Places pins them. The drag carries the selection
  // when the pressed folder is part of it, otherwise just that folder.
  dragStart(entry, tab, event) {
    if (!entry.directory || tab.path === '@trash') { this.drag = null; return; }
    const picked = tab.selected.has(entry.path) ? this.selected().filter((item) => item.directory).map((item) => item.path) : [entry.path];
    this.drag = { paths: picked, name: entry.name, x: event.position.x, y: event.position.y, active: false, overPlaces: false };
  }
  dragMove(event, cx) {
    const drag = this.drag;
    if (!drag) return;
    const moved = Math.abs(event.position.x - drag.x) + Math.abs(event.position.y - drag.y);
    if (!drag.active && moved < 6) return;
    const b = this.placesBounds, { x, y } = event.position;
    drag.active = true; drag.x = x; drag.y = y;
    drag.overPlaces = Boolean(this.panes().sidebar && b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
    cx.notify();
  }
  dragEnd(cx) {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.active) return;
    if (drag.overPlaces) {
      const added = drag.paths.filter((path) => !this.bookmarks.includes(path));
      this.bookmarks = [...this.bookmarks, ...added];
      this.persist();
      this.message = { text: added.length ? `Pinned ${added.length === 1 ? `“${basename(added[0])}”` : `${added.length} folders`} to Places.` : 'Already in Places.' };
    }
    cx.notify();
  }
  renderDragGhost(cx) {
    const drag = this.drag;
    return h_flex().absolute().left(drag.x + 12).top(drag.y + 8).px(8).py(4).gap(6).items_center()
      .bg(T.background).border(1).border_color(T.accent).text_color(T.foreground)
      .child(icon('folder')).child(div().max_w(220).truncate().child(drag.paths.length > 1 ? `${drag.paths.length} folders` : drag.name));
  }
  pinMenu(path, position, cx) {
    this.menuAnchor = position;
    this.menu = { x: position.x, y: position.y, highlight: -1, items: [
      { label: 'Open in new tab', icon: 'plus', run: (cx) => this.addTab(path, cx) },
      null,
      { label: 'Unpin from Places', icon: 'close', run: (cx) => this.toggleBookmark(path, cx) },
    ] };
    this.focus.focus();
    cx.notify();
  }
  renderInspector(cx) {
    const tab = this.active(), picked = this.selected(), entry = this.previewEntry, data = this.previewData;
    const shell = v_flex().w(320).flex_shrink_0().min_h_0().border_l(1).border_color(T.divider);
    const meta = (label, value) => h_flex().gap(12).items_start()
      .child(div().w(72).flex_shrink_0().text_color(T.secondary).child(label)).child(div().flex_1().min_w_0().child(value));
    const hint = (keys, text) => h_flex().gap(12).child(div().w(96).flex_shrink_0().text_color(T.foreground).child(keys)).child(div().text_color(T.secondary).child(text));
    if (picked.length !== 1) {
      const items = tab.loading ? 0 : this.visible(tab).length;
      const size = picked.reduce((sum, item) => sum + (item.directory ? 0 : item.size ?? 0), 0);
      // An empty detail area teaches the collection and its essential keys.
      return shell.child(v_flex().p(18).gap(14)
        .child(v_flex().gap(4)
          .child(div().text_size(14).font_bold().child(picked.length ? `${picked.length} items selected` : tab.path === '@trash' ? 'Trash' : basename(tab.path)))
          .child(div().text_color(T.secondary).child(picked.length ? `${formatSize(size)} in files` : `${items} item${items === 1 ? '' : 's'}`)))
        .child(div().h(1).bg(T.divider))
        .child(v_flex().gap(6)
          .child(hint('↑ ↓ / j k', 'Move'))
          .child(hint('Enter', 'Open'))
          .child(hint('Shift + F10', 'Actions'))
          .child(hint('F2', 'Rename'))
          .child(hint('Delete', 'Move to Trash'))
          .child(hint('Ctrl + L', 'Go to folder'))));
    }
    const item = picked[0], trash = tab.path === '@trash';
    const body = !entry || !data ? div().p(10).text_color(T.secondary).child(item.directory ? 'Folder' : 'Loading preview…')
      : data.kind === 'image' ? div().flex_1().min_h_0().p(10).flex().items_center().justify_center().child(image(data.asset).max_w_full().max_h_full())
      : data.kind === 'markdown' ? div().flex_1().min_h_0().p(10).child(TextView.markdown(`preview-md-${this.previewGeneration}`, data.text).selectable(true).scrollable(true).size_full().text_size(12))
      : data.kind === 'text' ? div().id(`preview-text-${this.previewGeneration}`).flex_1().min_h_0().overflow_y_scrollbar().p(10).child(div().whitespace_normal().child(data.text))
      : div().p(10).text_color(data.kind === 'error' ? T.danger : T.secondary).child(data.text);
    return shell
      .child(h_flex().flex_shrink_0().px(18).pt(14).pb(10).gap(8).items_center()
        .child(icon(iconFor(item)))
        .child(div().flex_1().min_w_0().truncate().text_size(14).font_bold().child(item.name)))
      .child(v_flex().flex_1().min_h_0().mx(18).bg(T.inset).child(body))
      .when(Boolean(data?.truncated), (el) => el.child(div().px(18).pt(6).text_size(11).text_color(T.secondary).child('Showing the first 12,000 characters.')))
      .child(v_flex().flex_shrink_0().px(18).pt(14).gap(6)
        .child(meta('Kind', item.directory ? 'Folder' : item.type ?? 'File'))
        .when(!item.directory, (el) => el.child(meta('Size', formatSize(item.size))))
        .child(meta('Modified', item.modified ? new Date(item.modified).toLocaleString() : '—'))
        .child(meta(trash ? 'From' : 'Where', displayPath(trash ? parent(item.originalPath ?? item.path) : parent(item.path), home))))
      .child(h_flex().flex_shrink_0().flex_wrap().p(18).gap(6)
        .when(!trash, (el) => el
          .child(this.button('inspector-open', 'Open', '', (cx) => this.open(item, cx), cx, { variant: 'primary' }))
          .child(this.button('inspector-rename', 'Rename…', '', (cx) => this.showDialog('rename', cx), cx, { variant: 'outline', disabled: Boolean(this.busy) }))
          .child(this.button('inspector-trash', 'Move to Trash…', '', (cx) => this.showDialog('trash', cx), cx, { variant: 'danger', disabled: Boolean(this.busy) })))
        .when(trash, (el) => el.child(this.button('inspector-restore', 'Restore', '', (cx) => this.restoreSelected(cx), cx, { variant: 'primary', disabled: Boolean(this.busy) }))));
  }
  // Left pane toggle on the left, right pane toggles on the right, and the
  // shortcuts available in the current view between them.
  renderStatus(cx) {
    const tab = this.active(), count = this.visible(tab).length, any = tab.selected.size > 0, panes = this.panes();
    const hints = tab.path === '@trash' ? ['↑↓ move', 'Shift + F10 actions'] : any ? ['Enter open', 'Space preview', 'F2 rename', 'Delete trash'] : ['↑↓ / jk move', 'Ctrl + L go to', 'Ctrl + F search'];
    const toggle = (id, name, on, tip, run) => Button.new(id).size(20).flex_shrink_0().accessibility_label(tip).tooltip(tip)
      .bg(on ? T.selected : T.clear).text_color(on ? T.foreground : T.secondary).hover((style) => style.bg(on ? T.selected : T.hover))
      .on_click((_e, cx) => run(cx))
      .child(h_flex().size_full().items_center().justify_center().child(icon(name, 12)));
    return h_flex().h(26).px(6).gap(8).items_center().flex_shrink_0().border_t(1).border_color(T.divider).text_size(11)
      .child(h_flex().w(200).flex_shrink_1().min_w(0).gap(8).items_center()
        .child(toggle('toggle-sidebar', 'panel-left', panes.sidebar, 'Sidebar (F9)', (cx) => this.toggleSidebar(cx)))
        .child(div().min_w_0().truncate().text_color(this.busy ? T.foreground : T.secondary)
          .child(this.busy ?? `${count} item${count === 1 ? '' : 's'}${any ? ` · ${tab.selected.size} selected` : ''}`)))
      .child(div().flex_1().min_w_0().truncate().text_center().text_color(T.secondary)
        .child(hints.join(' · ')))
      .child(h_flex().w(200).flex_shrink_1().min_w(0).gap(2).items_center().justify_end()
        .child(toggle('toggle-split', 'columns', Boolean(this.splitId), 'Split view (F3)', (cx) => this.toggleSplit(cx)))
        .child(toggle('toggle-preview', 'panel-right', panes.inspector, 'Preview (Space)', (cx) => this.toggleInspector(cx))));
  }
  // Context menu: commands for the clicked items, or for the folder itself.
  rowMenu(path, position, tab, cx) {
    this.activate(tab.id, cx);
    if (!tab.selected.has(path)) { tab.selected = new Set([path]); tab.anchor = path; }
    this.syncPreview(cx);
    this.openMenu('items', position, tab, cx);
  }
  menuItems(kind, tab) {
    const picked = this.selected(), single = picked.length === 1 ? picked[0] : null, trash = tab.path === '@trash', busy = Boolean(this.busy);
    const canPaste = Boolean(this.clipboard) && !trash && !busy;
    const refresh = { label: 'Refresh', icon: 'refresh', keys: 'F5', run: (cx) => { this.scan(tab, cx); cx.notify(); } };
    if (kind === 'folder') return trash ? [refresh] : [
      { label: 'New folder…', icon: 'plus', keys: 'Ctrl + Shift + N', disabled: busy, run: (cx) => this.showDialog('new', cx) },
      { label: 'Paste', icon: 'paste', keys: 'Ctrl + V', disabled: !canPaste, run: (cx) => this.paste(cx) },
      null,
      { label: this.bookmarks.includes(tab.path) ? 'Unpin from Places' : 'Pin to Places', icon: 'bookmark', keys: 'Ctrl + D', run: (cx) => this.bookmark(cx) },
      { label: 'Undo', icon: 'undo', keys: 'Ctrl + Z', disabled: !this.lastUndo.length || busy, run: (cx) => this.undo(cx) },
      { label: this.hidden ? 'Hide hidden files' : 'Show hidden files', icon: this.hidden ? 'eye-off' : 'eye', keys: 'Ctrl + H', run: (cx) => { this.hidden = !this.hidden; this.persist(); cx.notify(); } },
      refresh,
    ];
    const copyPath = { label: picked.length > 1 ? 'Copy paths' : 'Copy path', icon: 'copy', run: (cx) => { cx.write_to_clipboard(picked.map((item) => item.originalPath ?? item.path).join('\n')); this.message = { text: picked.length > 1 ? 'Paths copied' : 'Path copied' }; cx.notify(); } };
    if (trash) return [{ label: 'Restore', icon: 'undo', disabled: busy, run: (cx) => this.restoreSelected(cx) }, copyPath];
    return [
      { label: 'Open', icon: 'external', keys: 'Enter', disabled: !single, run: (cx) => this.open(single, cx) },
      single?.directory
        ? { label: 'Open in new tab', icon: 'plus', run: (cx) => this.addTab(single.path, cx) }
        : { label: 'Preview', icon: 'eye', keys: 'Space', disabled: !single, run: (cx) => { if (!this.panes().inspector) this.toggleInspector(cx); } },
      null,
      { label: 'Copy', icon: 'copy', keys: 'Ctrl + C', disabled: busy, run: (cx) => this.copy(false, cx) },
      { label: 'Cut', icon: 'cut', keys: 'Ctrl + X', disabled: busy, run: (cx) => this.copy(true, cx) },
      { label: 'Paste', icon: 'paste', keys: 'Ctrl + V', disabled: !canPaste, run: (cx) => this.paste(cx) },
      null,
      { label: 'Rename…', icon: 'rename', keys: 'F2', disabled: !single || busy, run: (cx) => this.showDialog('rename', cx) },
      copyPath,
      ...(single?.directory ? [{ label: this.bookmarks.includes(single.path) ? 'Unpin from Places' : 'Pin to Places', icon: 'bookmark', run: (cx) => this.toggleBookmark(single.path, cx) }] : []),
      null,
      { label: 'Move to Trash…', icon: 'trash', keys: 'Delete', danger: true, disabled: busy, run: (cx) => this.showDialog('trash', cx) },
    ];
  }
  openMenu(kind, position, tab, cx) {
    this.menuAnchor = position;
    // Initial open shows no cursor until the first key or pointer movement.
    this.menu = { items: this.menuItems(kind, tab), x: position.x, y: position.y, highlight: -1 };
    this.focus.focus();
    cx.notify();
  }
  closeMenu(cx) { this.menu = null; this.focus.focus(); cx.notify(); }
  runMenuItem(item, cx) {
    if (!item || item.disabled) return;
    this.menu = null; this.focus.focus();
    item.run(cx); cx.notify();
  }
  menuKey(key, cx) {
    const menu = this.menu, enabled = menu.items.map((item, index) => item && !item.disabled ? index : -1).filter((index) => index >= 0);
    if (key === 'escape') this.closeMenu(cx);
    else if (key === 'enter' || key === 'space') this.runMenuItem(menu.items[menu.highlight], cx);
    else if (['down', 'up', 'j', 'k', 'home', 'end'].includes(key) && enabled.length) {
      const at = enabled.indexOf(menu.highlight), back = key === 'up' || key === 'k';
      menu.highlight = key === 'home' ? enabled[0] : key === 'end' ? enabled[enabled.length - 1]
        : back ? enabled[at <= 0 ? enabled.length - 1 : at - 1] : enabled[(at + 1) % enabled.length];
      cx.notify();
    }
  }
  toggleBookmark(path, cx) {
    this.bookmarks = this.bookmarks.includes(path) ? this.bookmarks.filter((item) => item !== path) : [...this.bookmarks, path];
    this.persist(); cx.notify();
  }
  renderMenu(cx) {
    const menu = this.menu;
    // One cursor: pointer movement moves the same highlight the arrow keys do.
    const rows = menu.items.map((item, index) => {
      if (!item) return div().mx(4).my(2).h(1).bg(T.divider);
      const lit = index === menu.highlight;
      const point = (cx) => { if (!item.disabled && this.menu === menu && menu.highlight !== index) { menu.highlight = index; cx.notify(); } };
      return Button.new(`menu-${index}`).w_full().h(28).flex_shrink_0().accessibility_label(item.label).disabled(Boolean(item.disabled))
        .bg(lit ? T.hover : T.clear).when(Boolean(item.disabled), (el) => el.opacity(0.45))
        .on_click((_event, cx) => this.runMenuItem(item, cx))
        // Pointer listeners belong on an element the shell owns, not on Button.
        .child(h_flex().w_full().h_full().px(8).gap(8).items_center().justify_start()
          .on_hover((hovered, cx) => { if (hovered) point(cx); })
          .on_mouse_move((_event, cx) => point(cx))
          .text_color(item.danger ? T.danger : lit ? T.accent : T.foreground)
          .child(div().w(14).flex_shrink_0().child(item.icon ? icon(item.icon) : div()))
          .child(div().flex_1().min_w_0().truncate().child(item.label))
          .when(Boolean(item.keys), (el) => el.child(div().flex_shrink_0().text_size(11).text_color(T.secondary).child(item.keys))));
    });
    const list = v_flex().w(240).p(6).gap(2).bg(T.background).border(1).border_color(T.accent)
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .on_mouse_down('right', (_event, cx) => cx.stop_propagation())
      .children(rows);
    // Pressing anywhere outside the menu dismisses it.
    return div().absolute().inset_0()
      .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); this.closeMenu(cx); })
      .on_mouse_down('right', (_event, cx) => { cx.stop_propagation(); this.closeMenu(cx); })
      .child(div().absolute().left(menu.x).top(menu.y)
        .child(Popup.new('context-menu', div().size(1)).anchor('top_left').content(list)));
  }
  renderOverlay(cx) {
    // A decision that needs an answer is never dismissed by a backdrop press.
    const decision = this.dialog.kind === 'trash';
    return div().absolute().inset_0().flex().items_center().justify_center().bg(T.scrim)
      .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); if (!this.busy && !decision) { this.dialog = null; this.focus.focus(); cx.notify(); } })
      .child(v_flex().w(420).max_w('92%').max_h('88%').bg(T.background).border(1).border_color(T.accent)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .child(this.renderDialog(cx)));
  }
  renderDialog(cx) {
    const dialog = this.dialog;
    const count = dialog.paths.length, one = count === 1 ? `“${basename(dialog.paths[0])}”` : `${count} items`;
    const titles = { new: 'New folder', rename: `Rename “${dialog.entry?.name ?? ''}”`, goto: 'Go to folder', trash: `Move ${one} to Trash?` };
    const commit = { new: 'Create', rename: 'Rename', goto: 'Go', trash: 'Move to Trash' }[dialog.kind];
    return v_flex().p(18).gap(14)
      .child(div().text_size(16).font_bold().child(titles[dialog.kind]))
      .when(dialog.kind === 'trash', (el) => el.child(div().text_color(T.secondary).child('You can restore it from Trash in the sidebar.')))
      .when(dialog.kind !== 'trash', (el) => el.child(div().track_focus(this.formFocus).child(Input.new(this.form).px(10).py(7).border(1).border_color(T.controlBorder).bg(T.normal))))
      .when(Boolean(dialog.error), (el) => el.child(div().max_h(130).id('dialog-errors').overflow_y_scrollbar().text_color(T.danger).child(dialog.error)))
      .child(h_flex().justify_end().gap(6)
        .child(this.button('dialog-cancel', 'Cancel', '', (cx) => { this.dialog = null; this.focus.focus(); cx.notify(); }, cx, { variant: 'outline', disabled: Boolean(this.busy) }))
        .child(this.button('dialog-confirm', this.busy ? 'Working…' : commit, '', (cx) => this.submitDialog(cx), cx, { variant: dialog.kind === 'trash' ? 'danger' : 'primary', disabled: Boolean(this.busy) || (dialog.kind !== 'trash' && !this.form.value().trim()) })));
  }
}
