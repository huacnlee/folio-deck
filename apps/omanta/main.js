// @ts-check
import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, Button, Input, InputState, v_virtual_list, VirtualListScrollHandle } from 'gpui-base';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { applyPalette } from './theme.js';
import { DEFAULT, systemPalette } from './lib/theme.js';
import {
  reason, join, parent, basename, displayPath, resolvePath, readDirectory, visibleEntries, formatSize,
  newFolder, rename, transfer, trash, readTrash, restore, preview, command, moveNoReplace,
} from './lib/files.js';

const home = homedir();
const appRoot = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(/\/$/, '');
const deps = { fs, home, store: process.dataDir ?? '', run: (name, args) => process.run(name, args), random: randomUUID, now: () => Date.now() };
const PREFS = 'omanta.preferences.v1';
const icon = (name, size = 16) => svg(`omanta/icons/${name}.svg`).size(size).flex_shrink_0();
const iconFor = (entry) => ({ Folder: 'folder', Image: 'image', Video: 'video', Audio: 'music', Archive: 'archive', Code: 'code' })[entry.directory ? 'Folder' : entry.type] ?? 'file';
function load() { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { return {}; } }
function store(value) { try { localStorage.setItem(PREFS, JSON.stringify(value)); } catch {} }
function date(value) { return value ? new Date(value).toLocaleDateString() : '—'; }

export default class Omanta extends View {
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
  persist() { store({ paths: this.tabs.filter((tab) => tab.path !== '@trash').map((tab) => tab.path), bookmarks: this.bookmarks, viewMode: this.viewMode, hidden: this.hidden, sidebar: this.sidebar, sort: this.sort, descending: this.descending }); }
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
      if (tab.generation === generation) { tab.loading = false; cx.notify(); }
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
    cx.notify();
  }
  open(entry, cx, tab = this.active()) {
    if (entry.directory) this.navigate(entry.path, cx, tab);
    else this.perform(cx, 'Opening file', () => command(deps, process.platform === 'darwin' ? 'open' : 'xdg-open', [entry.path]), false);
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
      try { await this.submitDialogWork(dialog); this.dialog = null; this.message = { text: dialog.kind === 'trash' ? 'Moved to Trash. Undo is available.' : 'Done.' }; }
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
      try { const text = await work(); this.message = { text: typeof text === 'string' && text ? text : 'Done.' }; }
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
  showPreview(cx) {
    const entry = this.selected()[0];
    if (!entry) return;
    const generation = ++this.previewGeneration;
    this.previewEntry = entry; this.previewData = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const data = await preview(fs, entry);
        if (data.kind === 'image') {
          const name = `preview-${randomUUID()}.${entry.name.split('.').pop().toLowerCase()}`;
          await fs.mkdir(`${appRoot}/omanta/cache`, { recursive: true });
          await fs.writeFile(`${appRoot}/omanta/cache/${name}`, await fs.readFile(entry.path));
          data.asset = `omanta/cache/${name}`;
          const current = `${appRoot}/omanta/cache/${name}`;
          if (generation !== this.previewGeneration) { await command(deps, 'rm', ['-f', '--', current]).catch(() => {}); return; }
          const previous = this.previewAsset;
          this.previewAsset = current;
          if (previous) await command(deps, 'rm', ['-f', '--', previous]).catch(() => {});
        }
        if (generation === this.previewGeneration) this.previewData = data;
      } catch (error) { if (generation === this.previewGeneration) this.previewData = { kind: 'error', text: reason(error) }; }
      cx.notify();
    });
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
    if (this.previewEntry) { if (key === 'escape' || key === 'space') { this.previewEntry = null; this.previewGeneration++; cx.notify(); } return; }
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
    else if (key === 'f9') { this.sidebar = !this.sidebar; this.persist(); cx.notify(); }
    else if (key === 'f2') this.showDialog('rename', cx);
    else if (key === 'f5') { this.scan(this.active(), cx); cx.notify(); }
    else if (key === 'delete' && this.selected().length && this.active().path !== '@trash') this.showDialog('trash', cx);
    else if (key === 'space') this.showPreview(cx);
    else if (key === 'enter') { const entry = this.selected()[0]; if (entry && this.active().path !== '@trash') this.open(entry, cx); }
    else if (key === 'escape') { this.active().selected.clear(); cx.notify(); }
    else if (key === 'up' || key === 'down') {
      const tab = this.active(), entries = this.visible(tab), index = entries.findIndex((entry) => tab.selected.has(entry.path));
      const next = Math.max(0, Math.min(entries.length - 1, index + (key === 'up' ? -1 : 1)));
      if (entries[next]) { tab.selected = new Set([entries[next].path]); tab.anchor = entries[next].path; tab.scroll.scroll_to_item(next); cx.notify(); }
    } else handled = false;
    if (handled) cx.stop_propagation();
  }
  button(id, label, iconName, onClick, cx, { disabled = false, active = false, primary = false } = {}) {
    const colors = cx.theme().colors;
    return Button.new(id).h(32).px(label ? 10 : 8).flex().gap(7).items_center().flex_shrink_0()
      .border(1).border_color(active ? colors.primary : colors.border)
      .bg(primary ? colors.primary : active ? colors.accent : colors.background)
      .text_color(primary ? colors.primary_foreground : colors.foreground).text_size(12)
      .disabled(disabled).when(disabled, (el) => el.opacity(0.4))
      .when(!disabled, (el) => el.cursor_pointer().hover((style) => style.bg(colors.accent)))
      .tooltip(label || id).on_click((_event, cx) => onClick(cx))
      .when(Boolean(iconName), (el) => el.child(icon(iconName)))
      .when(Boolean(label), (el) => el.child(label));
  }
  render(cx) {
    const colors = cx.theme().colors, active = this.active();
    return v_flex().id('omanta').track_focus(this.focus).key_context('Omanta').relative().size_full().min_w_0()
      .bg(colors.background).text_color(colors.foreground).text_size(13)
      .on_key_down((event, cx) => this.key(event, cx))
      .child(this.renderHeader(cx))
      .child(h_flex().flex_1().min_h_0().min_w_0()
        .when(this.sidebar, (el) => el.child(this.renderSidebar(cx)))
        .child(v_flex().flex_1().min_w_0().min_h_0()
          .child(this.renderTabs(cx))
          .child(this.renderToolbar(cx))
          .when(Boolean(this.message), (el) => el.child(h_flex().px(16).py(8).gap(8).border_b(1).border_color(colors.border).bg(colors.surface)
            .child(div().flex_1().min_w_0().text_size(12).text_color(this.message.error ? colors.destructive : colors.foreground).child(this.message.text))
            .child(this.button('dismiss-message', '', 'close', (cx) => { this.message = null; cx.notify(); }, cx))))
          .child(h_flex().flex_1().min_h_0().min_w_0()
            .child(this.renderPane(active, cx))
            .when(Boolean(this.splitId && this.splitId !== active.id), (el) => el.child(this.renderPane(this.tabs.find((tab) => tab.id === this.splitId), cx))))))
      .child(this.renderStatus(cx))
      .when(Boolean(this.dialog || this.previewEntry), (el) => el.child(this.renderOverlay(cx)));
  }
  renderHeader(cx) {
    const colors = cx.theme().colors;
    return h_flex().h(48).px(16).gap(10).items_center().flex_shrink_0().bg(colors.surface).border_b(1).border_color(colors.border)
      .child(div().text_color(colors.primary).child(icon('folder', 22)))
      .child(div().font_semibold().text_size(14).child('OMANTA'))
      .child(div().ml(8).text_size(11).opacity(0.65).child('FILES, AT HOME'))
      .child(div().flex_1())
      .child(this.button('sidebar', '', 'list', (cx) => { this.sidebar = !this.sidebar; this.persist(); cx.notify(); }, cx, { active: this.sidebar }))
      .child(this.button('split', '', 'computer', (cx) => this.toggleSplit(cx), cx, { active: Boolean(this.splitId) }))
      .child(this.button('undo', 'Undo', 'undo', (cx) => this.undo(cx), cx, { disabled: !this.lastUndo.length || Boolean(this.busy) }));
  }
  renderSidebar(cx) {
    const colors = cx.theme().colors;
    const places = [['home', 'Home', home], ['download', 'Downloads', join(home, 'Downloads')], ['file', 'Documents', join(home, 'Documents')], ['computer', 'Desktop', join(home, 'Desktop')], ['image', 'Pictures', join(home, 'Pictures')], ['music', 'Music', join(home, 'Music')], ['video', 'Videos', join(home, 'Videos')]];
    const label = (text) => div().px(14).pt(22).pb(8).text_size(10).font_semibold().opacity(0.55).child(text);
    const item = (name, text, path) => Button.new(`place-${path}`).flex().w_full().h(36).px(14).gap(10).items_center()
      .bg(this.active().path === path ? colors.accent : colors.surface).text_color(this.active().path === path ? colors.primary : colors.foreground)
      .cursor_pointer().hover((style) => style.bg(colors.accent)).on_click((_event, cx) => this.navigate(path, cx))
      .child(icon(name)).child(div().truncate().child(text));
    return v_flex().w(188).min_w(140).max_w('27%').flex_shrink_0().min_h_0().bg(colors.surface).border_r(1).border_color(colors.border)
      .child(v_flex().id('places-scroll').flex_1().min_h_0().overflow_y_scrollbar()
        .child(label('PLACES')).children(places.map(([name, text, path]) => item(name, text, path)))
        .child(label('BOOKMARKS'))
        .when(!this.bookmarks.length, (el) => el.child(div().px(14).pb(12).text_size(11).opacity(0.55).child('Ctrl+D to add a folder')))
        .children(this.bookmarks.map((path) => item('bookmark', basename(path), path)))
        .child(label('LOCATIONS')).child(item('computer', 'File system', '/')).child(item('trash', 'Trash', '@trash')))
      .child(div().px(14).py(12).border_t(1).border_color(colors.border).text_size(10).opacity(0.6).child('F9  SIDEBAR    F3  SPLIT'));
  }
  renderTabs(cx) {
    const colors = cx.theme().colors;
    return h_flex().id('tabs-scroll').h(38).flex_shrink_0().overflow_x_scrollbar().items_center().border_b(1).border_color(colors.border)
      .children(this.tabs.map((tab) => h_flex().h_full().min_w(120).max_w(200).px(10).gap(8).items_center()
        .bg(tab.id === this.activeId ? colors.accent : colors.background).border_r(1).border_color(colors.border)
        .child(Button.new(`tab-${tab.id}`).flex_1().min_w_0().text_size(12).cursor_pointer().on_click((_e, cx) => this.activate(tab.id, cx)).child(div().truncate().child(tab.path === '@trash' ? 'Trash' : tab.path === home ? 'Home' : basename(tab.path))))
        .when(this.tabs.length > 1, (el) => el.child(this.button(`close-${tab.id}`, '', 'close', (cx) => this.closeTab(tab.id, cx), cx)))))
      .child(this.button('new-tab', '', 'plus', (cx) => this.addTab(home, cx), cx));
  }
  renderToolbar(cx) {
    const colors = cx.theme().colors, tab = this.active();
    return v_flex().flex_shrink_0().border_b(1).border_color(colors.border)
      .child(h_flex().flex_wrap().px(12).py(9).gap(8).items_center()
        .child(this.button('back', '', 'left', (cx) => this.history(-1, cx), cx, { disabled: tab.historyIndex === 0 }))
        .child(this.button('forward', '', 'right', (cx) => this.history(1, cx), cx, { disabled: tab.historyIndex >= tab.history.length - 1 }))
        .child(this.button('parent', '', 'up', (cx) => this.navigate(parent(tab.path), cx), cx, { disabled: tab.path === '/' || tab.path === '@trash' }))
        .child(h_flex().track_focus(this.pathFocus).flex_grow(1).flex_basis(300).min_w_0().h(32).px(10).gap(8).items_center().bg(colors.surface).border(1).border_color(colors.border)
          .child(icon('folder')).child(Input.new(this.location).flex_1().min_w_0().text_size(12)))
        .child(this.button('goto', '', 'right', (cx) => { try { this.navigate(resolvePath(this.location.value(), tab.path, home), cx); } catch (error) { this.message = { error: true, text: reason(error) }; cx.notify(); } }, cx))
        .child(this.button('bookmark', '', 'bookmark', (cx) => this.bookmark(cx), cx, { active: this.bookmarks.includes(tab.path), disabled: tab.path === '@trash' }))
        .child(this.button('refresh', '', 'refresh', (cx) => { this.scan(tab, cx); cx.notify(); }, cx)))
      .child(h_flex().flex_wrap().px(12).pb(9).gap(8).items_center()
        .child(h_flex().track_focus(this.searchFocus).flex_grow(1).flex_basis(180).min_w_0().h(32).px(10).gap(8).items_center().bg(colors.surface).border(1).border_color(colors.border)
          .child(icon('search')).child(Input.new(this.search).flex_1().min_w_0().text_size(12)))
        .child(this.button('new-folder', 'New folder', 'plus', (cx) => this.showDialog('new', cx), cx, { disabled: Boolean(this.busy) || tab.path === '@trash' }))
        .child(this.button('hidden', '', this.hidden ? 'eye' : 'eye-off', (cx) => { this.hidden = !this.hidden; this.persist(); cx.notify(); }, cx, { active: this.hidden }))
        .child(this.button('list-view', '', 'list', (cx) => { this.viewMode = 'list'; this.persist(); cx.notify(); }, cx, { active: this.viewMode === 'list' }))
        .child(this.button('grid-view', '', 'grid', (cx) => { this.viewMode = 'grid'; this.persist(); cx.notify(); }, cx, { active: this.viewMode === 'grid' })))
      .when(this.selected().length > 0, (el) => el.child(h_flex().flex_wrap().px(12).pb(9).gap(6).items_center()
        .when(tab.path !== '@trash', (el) => el
          .child(this.button('copy', 'Copy', 'copy', (cx) => this.copy(false, cx), cx, { disabled: Boolean(this.busy) }))
          .child(this.button('cut', 'Cut', 'cut', (cx) => this.copy(true, cx), cx, { disabled: Boolean(this.busy) }))
          .child(this.button('rename', 'Rename', 'rename', (cx) => this.showDialog('rename', cx), cx, { disabled: this.selected().length !== 1 || Boolean(this.busy) }))
          .child(this.button('trash', 'Trash', 'trash', (cx) => this.showDialog('trash', cx), cx, { disabled: Boolean(this.busy) })))
        .when(tab.path === '@trash', (el) => el.child(this.button('restore', 'Restore', 'undo', (cx) => this.restoreSelected(cx), cx, { disabled: Boolean(this.busy) })))
        .child(this.button('preview', 'Preview', 'eye', (cx) => this.showPreview(cx), cx, { disabled: this.selected().length !== 1 }))
        .child(this.button('copy-path', 'Copy path', 'copy', (cx) => { cx.write_to_clipboard(this.selected().map((item) => item.originalPath ?? item.path).join('\n')); this.message = { text: 'Path copied.' }; cx.notify(); }, cx))))
      .when(Boolean(this.clipboard && tab.path !== '@trash'), (el) => el.child(h_flex().px(12).pb(9).gap(8).items_center()
        .child(this.button('paste', `Paste ${this.clipboard.paths.length} item${this.clipboard.paths.length === 1 ? '' : 's'}`, 'paste', (cx) => this.paste(cx), cx, { disabled: Boolean(this.busy), primary: true }))
        .child(this.button('cancel-paste', 'Cancel', 'close', (cx) => { this.clipboard = null; cx.notify(); }, cx))));
  }
  renderPane(tab, cx) {
    const colors = cx.theme().colors, entries = this.visible(tab);
    const empty = (title, description) => v_flex().flex_1().px(24).py(60).items_center().justify_center().gap(12)
      .child(div().text_color(colors.primary).child(icon(tab.error ? 'info' : 'folder', 40)))
      .child(div().text_size(16).child(title)).child(div().max_w(440).text_size(12).opacity(0.65).child(description));
    const header = h_flex().h(36).px(16).gap(12).items_center().border_b(1).border_color(colors.border).text_size(11).bg(colors.surface)
      .child(Button.new(`sort-name-${tab.id}`).flex_1().min_w_0().text_left().cursor_pointer().on_click((_e, cx) => this.sortBy('name', cx)).child(`NAME ${this.sort === 'name' ? this.descending ? '↓' : '↑' : ''}`))
      .child(Button.new(`sort-size-${tab.id}`).w(74).max_w("18%").min_w_0().truncate().text_right().cursor_pointer().on_click((_e, cx) => this.sortBy('size', cx)).child(`SIZE ${this.sort === 'size' ? '↕' : ''}`))
      .child(Button.new(`sort-date-${tab.id}`).w(88).max_w("24%").min_w_0().truncate().text_right().cursor_pointer().on_click((_e, cx) => this.sortBy('modified', cx)).child(`MODIFIED ${this.sort === 'modified' ? '↕' : ''}`));
    return v_flex().flex_1().min_w_0().min_h_0().border_r(1).border_color(colors.border)
      .when(Boolean(this.splitId), (el) => el.child(Button.new(`pane-${tab.id}`).w_full().h(28).px(12).bg(tab.id === this.activeId ? colors.accent : colors.surface).text_size(11).cursor_pointer().on_click((_event, cx) => this.activate(tab.id, cx)).child(div().truncate().child(tab.path === '@trash' ? 'Trash' : displayPath(tab.path, home)))))
      .when(tab.loading, (el) => el.child(empty('Reading folder…', displayPath(tab.path, home))))
      .when(Boolean(tab.error), (el) => el.child(empty('This folder could not be opened', tab.error)).child(this.button(`retry-${tab.id}`, 'Retry', 'refresh', (cx) => { this.scan(tab, cx); cx.notify(); }, cx)))
      .when(!tab.loading && !tab.error && entries.length === 0, (el) => el.child(empty(tab.query ? 'No matching files' : tab.path === '@trash' ? 'Trash is empty' : 'This folder is empty', tab.query ? 'Try another search or show hidden files.' : tab.path === '@trash' ? 'Items moved to Trash in Omanta can be restored here.' : 'Create a folder or paste files here.')))
      .when(!tab.loading && !tab.error && entries.length > 0 && this.viewMode === 'list', (el) => el.child(header).child(v_virtual_list(`files-${tab.id}`, entries.length, 40, (index) => entries[index].path,
        (range, cx) => entries.slice(range.start, range.end).map((entry) => this.fileRow(entry, tab, cx)))
        .flex_1().min_h_0().w_full().track_scroll(tab.scroll)))
      .when(!tab.loading && !tab.error && entries.length > 0 && this.viewMode === 'grid', (el) => el.child(v_flex().id(`grid-${tab.id}`).flex_1().min_h_0().overflow_y_scrollbar().p(16).gap(12)
        .child(h_flex().flex_wrap().gap(12).children(entries.slice(0, this.gridLimit).map((entry) => this.fileTile(entry, tab, cx))))
        .when(entries.length > this.gridLimit, (el) => el.child(this.button(`more-${tab.id}`, `Show more (${entries.length - this.gridLimit} remaining)`, 'plus', (cx) => { this.gridLimit += 240; cx.notify(); }, cx)))));
  }
  sortBy(sort, cx) { this.descending = this.sort === sort ? !this.descending : false; this.sort = sort; this.persist(); cx.notify(); }
  fileRow(entry, tab, cx) {
    const colors = cx.theme().colors;
    return h_flex().id(`row-${entry.path}`).h(40).px(16).gap(12).items_center().w_full().cursor_pointer()
      .bg(tab.selected.has(entry.path) ? colors.accent : colors.background).hover((style) => style.bg(colors.surface))
      .on_click((event, cx) => this.select(entry, event, cx, tab))
      .on_mouse_down('right', (_event, cx) => { this.activate(tab.id, cx); tab.selected = new Set([entry.path]); this.message = { text: 'Use the file actions above, or Space to preview.' }; cx.notify(); })
      .child(div().text_color(entry.directory ? colors.primary : entry.error ? colors.destructive : colors.foreground).child(icon(iconFor(entry), 18)))
      .child(div().flex_1().min_w_0().truncate().text_size(12).child(entry.name))
      .child(div().w(74).max_w("18%").min_w_0().truncate().text_right().text_size(11).opacity(0.6).child(entry.directory ? '—' : formatSize(entry.size)))
      .child(div().w(88).max_w("24%").min_w_0().truncate().text_right().text_size(11).opacity(0.6).child(date(entry.modified)));
  }
  fileTile(entry, tab, cx) {
    const colors = cx.theme().colors;
    return v_flex().id(`tile-${entry.path}`).w(140).max_w('100%').min_h(126).p(12).gap(10).items_center().cursor_pointer()
      .border(1).border_color(tab.selected.has(entry.path) ? colors.primary : colors.border)
      .bg(tab.selected.has(entry.path) ? colors.accent : colors.background).hover((style) => style.bg(colors.surface))
      .on_click((event, cx) => this.select(entry, event, cx, tab))
      .child(div().text_color(entry.directory ? colors.primary : entry.error ? colors.destructive : colors.foreground).child(icon(iconFor(entry), 44)))
      .child(div().w_full().truncate().text_center().text_size(12).child(entry.name))
      .child(div().text_size(10).opacity(0.55).child(entry.directory ? 'Folder' : formatSize(entry.size)));
  }
  renderStatus(cx) {
    const colors = cx.theme().colors, tab = this.active(), count = this.visible(tab).length;
    return h_flex().h(30).px(14).gap(10).items_center().flex_shrink_0().bg(colors.surface).border_t(1).border_color(colors.border).text_size(11)
      .child(div().child(this.busy ?? `${count} item${count === 1 ? '' : 's'}${tab.selected.size ? ` · ${tab.selected.size} selected` : ''}`))
      .child(div().flex_1())
      .child(div().opacity(0.55).child(tab.path === '@trash' ? 'OMANTA TRASH' : 'SPACE  PREVIEW   ·   CTRL+L  LOCATION'));
  }
  renderOverlay(cx) {
    const colors = cx.theme().colors;
    return div().absolute().inset_0().flex().items_center().justify_center().bg('#00000090')
      .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); if (!this.busy) { this.dialog = null; this.previewEntry = null; this.previewGeneration++; this.focus.focus(); cx.notify(); } })
      .child(v_flex().w(this.previewEntry ? 720 : 460).max_w('92%').max_h('88%').bg(colors.surface).border(1).border_color(colors.border)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .child(this.previewEntry ? this.renderPreview(cx) : this.renderDialog(cx)));
  }
  renderDialog(cx) {
    const colors = cx.theme().colors, dialog = this.dialog;
    const titles = { new: 'New folder', rename: 'Rename item', goto: 'Go to folder', trash: `Move ${dialog.paths.length} item${dialog.paths.length === 1 ? '' : 's'} to Trash?` };
    return v_flex().p(22).gap(16)
      .child(div().text_size(17).font_medium().child(titles[dialog.kind]))
      .when(dialog.kind === 'trash', (el) => el.child(div().text_size(12).child('Items can be restored from Omanta Trash. Existing files are never overwritten.')))
      .when(dialog.kind !== 'trash', (el) => el.child(div().track_focus(this.formFocus).child(Input.new(this.form).h(36).px(10).border(1).border_color(colors.border).bg(colors.background))))
      .when(Boolean(dialog.error), (el) => el.child(div().max_h(130).id('dialog-errors').overflow_y_scrollbar().text_color(colors.destructive).text_size(12).child(dialog.error)))
      .child(h_flex().justify_end().gap(8)
        .child(this.button('dialog-cancel', 'Cancel', '', (cx) => { this.dialog = null; this.focus.focus(); cx.notify(); }, cx, { disabled: Boolean(this.busy) }))
        .child(this.button('dialog-confirm', this.busy ? 'Working…' : dialog.kind === 'trash' ? 'Move to Trash' : dialog.kind === 'goto' ? 'Go' : 'Save', dialog.kind === 'trash' ? 'trash' : '', (cx) => this.submitDialog(cx), cx, { primary: true, disabled: Boolean(this.busy) || (dialog.kind !== 'trash' && !this.form.value().trim()) })));
  }
  renderPreview(cx) {
    const colors = cx.theme().colors, entry = this.previewEntry, data = this.previewData;
    return v_flex().min_h_0()
      .child(h_flex().px(18).py(12).gap(10).items_center().border_b(1).border_color(colors.border)
        .child(icon(iconFor(entry), 20)).child(div().flex_1().min_w_0().truncate().font_medium().child(entry.name))
        .child(this.button('close-preview', '', 'close', (cx) => { this.previewEntry = null; this.previewGeneration++; this.focus.focus(); cx.notify(); }, cx)))
      .child(v_flex().id('preview-content').min_h_0().max_h(450).overflow_y_scrollbar().p(20).gap(12)
        .when(!data, (el) => el.child('Loading preview…'))
        .when(data?.kind === 'image', (el) => el.child(image(data.asset).w_full().h(300)))
        .when(Boolean(data && data.kind !== 'image'), (el) => el.child(div().text_size(12).font_family(data.kind === 'text' ? 'monospace' : '.SystemUIFont').text_color(data.kind === 'error' ? colors.destructive : colors.foreground).child(data.text)))
        .when(data?.truncated, (el) => el.child(div().text_size(11).opacity(0.6).child('Showing the first 12,000 characters.'))))
      .child(h_flex().px(18).py(12).gap(12).items_center().border_t(1).border_color(colors.border)
        .child(div().flex_1().text_size(11).opacity(0.6).child(`${entry.type} · ${entry.directory ? 'Folder' : formatSize(entry.size)} · ${date(entry.modified)}`))
        .when(this.active().path !== '@trash', (el) => el.child(this.button('preview-open', 'Open', 'right', (cx) => { this.previewEntry = null; this.open(entry, cx); }, cx))));
  }
}
