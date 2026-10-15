// @ts-check
import { View, div, svg } from 'gpui-kit';
import { h_flex, v_flex, Input, InputState, Textarea, TextareaState, TextView, Popup } from 'gpui-base';
import * as components from 'gpui-component';
import { MessageScroller, MessageScrollerState, ShimmerText } from 'gpui-component';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import * as os from 'os';
import {
  AppFrame, Badge, Button, Card, Chip, EmptyState, IconBadge, IconButton, Kbd, Legend, MenuList, NavItem, NavSection,
  PageHeader, Pulse, ScanLine, SearchField, Segmented, SelectTrigger, Sidebar, Steps, Tag, applyTheme, theme,
} from 'zion-ui';
import { PROVIDERS, providerIds, shellCommand, isMac, buildArgs, createTurn, applyLine, finishError, contextPrompt, parseVersion, codexSession, describeActivity, continuePrompt } from './lib/providers.js';
import { extractLinks, isWebUrl } from './lib/links.js';
import { newConversation, titleFrom, displayTitle, groupByDate, filterConversations, serialize, parseStore, formatDuration, formatCost, markInterrupted } from './lib/store.js';

const PREFS = 'chat.preferences.v1';
const SUGGESTIONS = [
  'Explain the difference between a process and a thread',
  'Write a shell one-liner that finds the ten largest files in a folder',
  'Review this plan and list the risks I am missing',
  'Summarize the main ideas of the Unix philosophy',
];
// Asset paths resolve against the application root.
const asset = (name) => `chat/icons/${name}.svg`;
const icon = (name, size = 14) => svg(asset(name)).size(size).flex_shrink_0();
const reason = (error) => String(error?.message ?? error).replace(/^Error:\s*/, '');
/** A tool's program and arguments, started through the user's login shell. */
const tool = (command, args) => shellCommand(command, args, { platform: process.platform, home: os.homedir() });
const TICK_MS = 450;
// macOS draws the window's close, minimise and zoom buttons over the content's
// top-left corner; content there moves below or beside them.
const MAC = isMac(process.platform);
const TRAFFIC_LIGHTS = MAC ? { top: 20, left: 64 } : { top: 0, left: 0 };
const MAX_LINKS = 6;
const LINK_MIN = 280;
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// Timestamps a turn's last output, and the moment its stage changed.
const stamp = (turn, before) => { const now = Date.now(); turn.eventAt = now; if (turn.stage !== before) turn.stageAt = now; };
// `WebView` arrived after gpui-shell 0.7.3; without it a link opens in the
// system browser.
const { WebView, WebViewState } = /** @type {any} */ (components);
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { return {}; } }
function savePrefs(value) { try { localStorage.setItem(PREFS, JSON.stringify(value)); } catch {} }

export default class Chat extends View {
  init(_props, cx) {
    const prefs = loadPrefs();
    applyTheme({ mono: MAC ? 'Menlo' : 'JetBrainsMono Nerd Font' });
    // `null` while checking; a version string, or `false` when not installed.
    this.versions = { claude: null, codex: null };
    this.codex = null;
    this.focus = cx.focus_handle();
    this.focus.focus();
    this.conversations = [];
    this.currentId = null;
    this.loaded = false;
    this.loadError = null;
    this.provider = providerIds.includes(prefs.provider) ? prefs.provider : 'claude';
    this.model = typeof prefs.model === 'string' ? prefs.model : '';
    this.sidebar = prefs.sidebar !== false;
    this.sidebarWidth = Number.isFinite(prefs.sidebarWidth) ? prefs.sidebarWidth : 248;
    this.running = null;
    this.message = null;
    this.dialog = null;
    this.menu = null;
    this.deleted = null;
    this.copied = null;
    this.saveVersion = 0;
    this.notifyQueued = false;
    this.scroller = MessageScrollerState.new(0);
    // The link pane: one retained page, its address and title, and whether
    // the pane is open. A closed pane keeps its page for the next link.
    this.browser = null;
    this.linkWidth = Number.isFinite(prefs.linkWidth) ? prefs.linkWidth : null;
    this.linkFull = false;
    this.linkDrag = null;
    this.linkZoom = ZOOMS.includes(prefs.linkZoom) ? prefs.linkZoom : 1;
    this.dataFile = process.dataDir ? `${process.dataDir}/conversations.json` : null;
    this.workdir = process.dataDir ? `${process.dataDir}/workspace` : null;
    this.composer = TextareaState.new({ placeholder: 'Ask anything…', rows: 1 });
    this.composer.set_auto_grow(1, 8);
    this.composer.on('change', (_event, cx) => cx.notify());
    // Enter sends and Shift + Enter adds a line. The textarea reports Enter
    // after it has inserted the newline, which send() trims away.
    this.composer.on('submit', (event, cx) => { if (!event.shift) this.send(cx); });
    this.search = InputState.new({ placeholder: 'Search chats' });
    this.search.on('change', (_event, cx) => cx.notify());
    this.renameState = InputState.new({ placeholder: 'Chat name' });
    this.renameState.on('submit', (_event, cx) => this.confirmRename(cx));
    this.load(cx);
    cx.spawn(async (cx) => {
      if (MAC) return;
      const result = await process.run('fc-match', ['monospace', '-f', '%{family[0]}']).catch(() => null);
      const family = result?.code === 0 ? result.stdout.trim() : '';
      if (family) { applyTheme({ mono: family }); cx.notify(); }
    });
    // GPUI lowers a mixed line's baseline to fit a fallback font's ascent, so
    // Chinese drawn from a fallback sits low. A CJK family that also draws
    // Latin as the sans family keeps every line on one set of metrics.
    cx.spawn(async (cx) => {
      if (MAC) { applyTheme({ sans: 'PingFang SC' }); cx.notify(); return; }
      const result = await process.run('fc-list', [':lang=zh:style=Regular', 'family']).catch(() => null);
      if (result?.code !== 0) return;
      const families = result.stdout.split('\n').flatMap((line) => line.split(',')).map((name) => name.trim());
      const family = ['Noto Sans CJK SC', 'Source Han Sans SC', 'Noto Sans SC', 'Source Han Sans CN', 'WenQuanYi Micro Hei'].find((name) => families.includes(name));
      if (family) { applyTheme({ sans: family }); cx.notify(); }
    });
    for (const id of providerIds) {
      cx.spawn(async (cx) => {
        const result = await process.run(...tool(PROVIDERS[id].command, ['--version']), { timeoutMs: 15000 }).catch(() => null);
        this.versions[id] = (result?.code === 0 && parseVersion(result.stdout)) || false;
        cx.notify();
      });
    }
  }

  // ---- persistence -------------------------------------------------------

  load(cx) {
    cx.spawn(async (cx) => {
      let resume = null;
      if (this.dataFile) {
        try {
          this.conversations = parseStore(await fs.readFile(this.dataFile, 'utf8'));
          // A reply still being written on disk was cut off when the app last
          // stopped; one cut off moments ago was a reload and carries on.
          resume = markInterrupted(this.conversations, Date.now());
        }
        catch (error) {
          // A missing file is a first launch; anything else must not be overwritten.
          if (!/ENOENT|No such file|not found/i.test(reason(error))) this.loadError = `Couldn’t read saved chats: ${reason(error)} New chats are not saved until this is fixed.`;
        }
        if (this.workdir) await fs.mkdir(this.workdir, { recursive: true }).catch(() => {});
      }
      this.loaded = true;
      if (this.loadError) this.message = { error: true, text: this.loadError };
      // Reopen the chat that was open, and finish a reply a reload cut off.
      const open = resume ?? loadPrefs().current;
      if (open && this.conversations.some((item) => item.id === open)) this.select(open, cx);
      this.prewarm();
      if (resume && !this.loadError) this.continueReply(cx);
      cx.notify();
    });
  }
  save(cx) {
    if (!this.dataFile || this.loadError || !this.loaded) return;
    const version = ++this.saveVersion;
    cx.spawn(async (cx) => {
      await cx.sleep(250);
      if (version !== this.saveVersion) return;
      try { await fs.writeFile(this.dataFile, serialize(this.conversations)); }
      catch (error) { this.message = { error: true, text: `Couldn’t save chats: ${reason(error)}` }; cx.notify(); }
    });
  }
  persistPrefs() { savePrefs({ provider: this.provider, model: this.model, sidebar: this.sidebar, sidebarWidth: this.sidebarWidth, linkWidth: this.linkWidth, linkZoom: this.linkZoom, current: this.currentId }); }

  // ---- conversations -----------------------------------------------------

  current() { return this.conversations.find((conversation) => conversation.id === this.currentId) ?? null; }
  resetScroller(count) { this.scroller = MessageScrollerState.new(count); }
  select(id, cx) {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    this.currentId = id;
    this.provider = conversation.provider;
    this.model = conversation.model;
    this.persistPrefs();
    this.composer.set_value('');
    this.resetScroller(conversation.messages.length);
    this.menu = null;
    cx.notify();
  }
  newChat(cx) {
    this.currentId = null;
    this.persistPrefs();
    this.composer.set_value('');
    this.resetScroller(0);
    this.menu = null;
    cx.notify();
  }
  // Start the Codex app server ahead of the first message when Codex is chosen.
  prewarm() {
    if (this.provider === 'codex' && typeof process.spawn === 'function' && this.versions.codex !== false) this.codexServer();
  }
  setProvider(provider, cx) {
    if (this.provider === provider) return;
    this.provider = provider;
    this.prewarm();
    if (!PROVIDERS[provider].models.some((model) => model.id === this.model)) this.model = '';
    this.persistPrefs();
    cx.notify();
  }
  setModel(model, cx) { this.model = model; this.persistPrefs(); cx.notify(); }

  // ---- turns -------------------------------------------------------------

  send(cx) {
    const text = this.composer.value().trim();
    if (!text || this.running || !this.loaded) return;
    let conversation = this.current();
    if (!conversation) {
      conversation = newConversation(this.provider, this.model, Date.now(), randomUUID());
      conversation.title = titleFrom(text);
      this.conversations.unshift(conversation);
      this.currentId = conversation.id;
    }
    const history = conversation.messages.filter((message) => !message.error);
    conversation.provider = this.provider;
    conversation.model = this.model;
    conversation.messages.push({ id: randomUUID(), role: 'user', text, at: Date.now() });
    conversation.updatedAt = Date.now();
    this.composer.set_value('');
    this.message = this.loadError ? this.message : null;
    this.startTurn(conversation, text, history, cx, false);
    this.save(cx);
  }
  retry(cx) {
    const conversation = this.current();
    if (!conversation || this.running) return;
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role === 'assistant') conversation.messages.pop();
    const userIndex = conversation.messages.map((message) => message.role).lastIndexOf('user');
    if (userIndex < 0) return;
    const text = conversation.messages[userIndex].text;
    const history = conversation.messages.slice(0, userIndex).filter((message) => !message.error);
    conversation.provider = this.provider;
    conversation.model = this.model;
    this.startTurn(conversation, text, history, cx, false);
  }
  /**
   * Finishes the latest reply where it was cut off: the tool is asked to
   * carry on from the tail of what it wrote, and its words are appended.
   */
  continueReply(cx) {
    const conversation = this.current();
    if (!conversation || this.running) return;
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role !== 'assistant' || !last.interrupted) return;
    if (!last.text) { this.retry(cx); return; }
    const userIndex = conversation.messages.map((message) => message.role).lastIndexOf('user');
    if (userIndex < 0) return;
    const history = conversation.messages.slice(0, userIndex + 1).filter((message) => !message.error);
    delete last.error;
    delete last.interrupted;
    last.resumes = (last.resumes ?? 0) + 1;
    conversation.provider = last.provider ?? conversation.provider;
    this.provider = conversation.provider;
    this.startTurn(conversation, continuePrompt(last.text), history, cx, false, last);
  }
  startTurn(conversation, text, history, cx, retried, resumed = null) {
    const provider = conversation.provider;
    // A session that missed turns answered by the other provider is stale.
    const lastProvider = [...history].reverse().find((message) => message.role === 'assistant')?.provider;
    if (lastProvider && lastProvider !== provider) delete conversation.sessions[provider];
    const sessionId = conversation.sessions[provider] ?? null;
    // Without a session for this provider, earlier messages travel in the prompt.
    const prompt = sessionId ? text : contextPrompt(history, text);
    // A continued reply keeps its message and adds to what it already says.
    const assistant = resumed ?? { id: randomUUID(), role: 'assistant', text: '', provider, ...(conversation.model ? { model: conversation.model } : {}), at: Date.now() };
    if (!resumed) conversation.messages.push(assistant);
    assistant.pending = true;
    const prefix = resumed ? assistant.text : '';
    const run = { conversation, assistant, provider, sessionId, text, history, retried, resumed, prefix, turn: createTurn(), stderr: [], startedAt: Date.now(), cancel: null, cancelled: false, tick: 0 };
    run.turn.stageAt = run.startedAt;
    this.running = run;
    this.resetScroller(conversation.messages.length);
    cx.notify();
    const command = PROVIDERS[provider].command;
    const args = buildArgs(provider, { prompt, sessionId, model: conversation.model });
    const onLine = (line, cx) => {
      if (this.running !== run) return;
      const stage = run.turn.stage;
      const changed = applyLine(provider, run.turn, line);
      stamp(run.turn, stage);
      if (!changed) return;
      this.progress(run, cx);
    };
    const onExit = (exit, cx) => this.finishTurn(run, exit, cx);
    // Stream when the runtime can; otherwise wait for the whole reply.
    if (typeof process.spawn === 'function' && provider === 'codex') {
      // `codex exec --json` prints a reply only once it is whole; the app
      // server streams it as it is written, and stays running between turns.
      this.codexTurn(run, prompt, cx);
    } else if (typeof process.spawn === 'function') {
      try {
        const child = process.spawn(...tool(command, args), { lines: true, stdin: 'null', ...(this.workdir ? { cwd: this.workdir } : {}) });
        child.on('stdout', onLine).on('stderr', (line) => { run.stderr.push(line); }).on('exit', onExit);
        run.cancel = () => child.kill();
      } catch (error) { this.finishTurn(run, { code: null, error: reason(error) }, cx); }
    } else {
      cx.spawn(async (cx) => {
        let output;
        try { output = await process.run(...tool(command, args)); }
        catch (error) { this.finishTurn(run, { code: null, error: reason(error) }, cx); return; }
        for (const line of output.stdout.split('\n')) onLine(line, cx);
        run.stderr.push(output.stderr);
        this.finishTurn(run, { code: output.code }, cx);
      });
    }
    // Advance the activity bar's pulse and scan line a step at a time; the
    // runtime eases each step natively, so a redraw every TICK_MS is enough
    // for smooth motion and keeps the elapsed time current.
    cx.spawn(async (cx) => {
      while (this.running === run) {
        await cx.sleep(TICK_MS);
        if (this.running === run) { run.tick += 1; cx.notify(); }
      }
    });
  }

  // ---- codex app server ----------------------------------------------------

  /**
   * One `codex app-server` serves every Codex turn: it is started and
   * initialized once, ahead of the first message when Codex is chosen, so a
   * turn starts with its thread request instead of a cold start.
   */
  codexServer() {
    if (this.codex && !this.codex.exited) return this.codex;
    const server = { child: null, ready: false, exited: false, queue: [], turn: null, nextId: 1000 };
    this.codex = server;
    try {
      server.child = process.spawn(...tool(PROVIDERS.codex.command, ['app-server', '-c', 'sandbox_mode="read-only"']), { lines: true, stdin: 'pipe', ...(this.workdir ? { cwd: this.workdir } : {}) });
    } catch (error) {
      server.exited = true;
      server.error = reason(error);
      return server;
    }
    const write = (line) => server.child.write(`${line}\n`);
    server.write = write;
    server.child.on('stdout', (line, cx) => {
      if (!server.ready) {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 0) return;
        if (message.error) { server.error = message.error.message; server.child.kill(); return; }
        server.ready = true;
        write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
        for (const start of server.queue.splice(0)) start(cx);
        return;
      }
      server.turn?.(line, cx);
    }).on('stderr', (line) => { server.stderr = line; })
      .on('exit', (exit, cx) => {
        server.exited = true;
        if (this.codex === server) this.codex = null;
        server.onExit?.(exit, cx);
      });
    write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'gpui-shell-chat', version: '0.1.0' }, capabilities: null } }));
    return server;
  }
  codexTurn(run, prompt, cx) {
    const server = this.codexServer();
    if (server.exited) { this.finishTurn(run, { code: null, error: server.error ?? 'Codex did not start.' }, cx); return; }
    const session = codexSession({ prompt, sessionId: run.sessionId, model: run.conversation.model, cwd: this.workdir, connected: true, firstId: (server.nextId += 1000) });
    run.turn = session.turn;
    session.turn.stageAt = run.startedAt;
    if (!server.ready) { session.turn.phase = 'starting'; session.turn.stage = 'launching'; }
    const send = (lines) => lines.forEach((line) => server.write(line));
    const end = (exit, cx) => { server.turn = null; server.onExit = null; this.finishTurn(run, exit, cx); };
    server.turn = (line, cx) => {
      const stage = session.turn.stage;
      const { write, changed } = session.receive(line);
      stamp(session.turn, stage);
      send(write);
      if (changed) this.progress(run, cx);
      if (session.done) end({ code: 0 }, cx);
    };
    // The server ending mid-turn ends the turn with whatever it said last.
    server.onExit = (exit, cx) => end(exit.error || exit.code ? exit : { code: null, error: server.stderr || 'Codex stopped unexpectedly.' }, cx);
    run.cancel = () => {
      const lines = session.interrupt();
      if (lines.length) send(lines); else server.child.kill();
      // A turn that does not acknowledge the interrupt promptly takes the
      // server with it; the next turn starts a fresh one.
      cx.spawn(async (cx) => { await cx.sleep(1500); if (this.running === run) server.child.kill(); });
    };
    const start = (cx) => { session.turn.phase = 'thinking'; session.turn.stage = 'opening'; stamp(session.turn, 'launching'); send(session.start()); this.notifySoon(cx); };
    if (server.ready) start(cx); else server.queue.push(start);
  }
  // Output arrived: show it, and keep the session and the words so far on
  // disk, so a reload or a crash mid-reply can pick the reply up again.
  progress(run, cx) {
    const { conversation, assistant, turn, provider } = run;
    assistant.text = run.prefix + turn.text;
    let save = false;
    if (turn.sessionId && conversation.sessions[provider] !== turn.sessionId) { conversation.sessions[provider] = turn.sessionId; save = true; }
    const now = Date.now();
    if (save || now - (assistant.savedAt ?? 0) >= 1500) { assistant.savedAt = now; this.save(cx); }
    this.notifySoon(cx);
  }
  // Coalesce redraws while tokens stream in.
  notifySoon(cx) {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    cx.spawn(async (cx) => { await cx.sleep(40); this.notifyQueued = false; cx.notify(); });
  }
  finishTurn(run, exit, cx) {
    if (this.running !== run) return;
    const { conversation, assistant, turn, provider } = run;
    this.running = null;
    if (turn.sessionId) conversation.sessions[provider] = turn.sessionId;
    const error = run.cancelled ? 'Stopped.' : finishError(turn, exit, run.stderr.join('\n'));
    // A session the tool no longer knows: start a fresh one carrying the history.
    if (error && !turn.text && run.sessionId && !run.retried && /no conversation found|(session|thread)\b.*\b(not found|unknown|does not exist|no such)|no (session|thread|rollout)/i.test(error)) {
      delete conversation.sessions[provider];
      if (!run.resumed) conversation.messages.pop();
      this.startTurn(conversation, run.text, run.history, cx, true, run.resumed);
      return;
    }
    delete assistant.pending;
    assistant.text = run.prefix + turn.text;
    if (turn.thinking) assistant.thinking = turn.thinking;
    if (turn.model) assistant.model = turn.model;
    if (turn.cost !== null) assistant.cost = turn.cost;
    assistant.durationMs = (run.resumed ? assistant.durationMs ?? 0 : 0) + Date.now() - run.startedAt;
    if (error) assistant.error = error;
    conversation.updatedAt = Date.now();
    this.save(cx);
    cx.notify();
  }
  stop(cx) {
    const run = this.running;
    if (!run?.cancel) return;
    run.cancelled = true;
    run.cancel();
    cx.notify();
  }
  copy(message, cx) {
    cx.write_to_clipboard(message.text);
    this.copied = message.id;
    cx.notify();
    cx.spawn(async (cx) => { await cx.sleep(1500); if (this.copied === message.id) { this.copied = null; cx.notify(); } });
  }

  // ---- rename and delete -------------------------------------------------

  askRename(id, cx) {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    this.menu = null;
    this.dialog = { kind: 'rename', id };
    this.renameState.set_value(displayTitle(conversation));
    cx.notify();
  }
  confirmRename(cx) {
    const conversation = this.conversations.find((item) => item.id === this.dialog?.id);
    const title = this.renameState.value().trim();
    if (!conversation || !title) return;
    conversation.title = title;
    this.dialog = null;
    this.focus.focus();
    this.save(cx);
    cx.notify();
  }
  askDelete(id, cx) {
    if (this.running?.conversation.id === id) return;
    this.menu = null;
    this.dialog = { kind: 'delete', id };
    cx.notify();
  }
  confirmDelete(cx) {
    const index = this.conversations.findIndex((item) => item.id === this.dialog?.id);
    this.dialog = null;
    this.focus.focus();
    if (index < 0) return;
    const [conversation] = this.conversations.splice(index, 1);
    this.deleted = { conversation, index };
    if (this.currentId === conversation.id) this.newChat(cx);
    this.message = { text: `Deleted “${displayTitle(conversation)}”.`, undo: true };
    this.save(cx);
    cx.notify();
  }
  undoDelete(cx) {
    const deleted = this.deleted;
    if (!deleted) return;
    this.conversations.splice(Math.min(deleted.index, this.conversations.length), 0, deleted.conversation);
    this.deleted = null;
    this.message = null;
    this.select(deleted.conversation.id, cx);
    this.save(cx);
  }

  // ---- keyboard ----------------------------------------------------------

  key(event, cx) {
    const key = event.key.toLowerCase(), ctrl = event.modifiers.control || event.modifiers.platform;
    if (this.menu) {
      if (key === 'escape') { this.menu = null; cx.notify(); cx.stop_propagation(); }
      return;
    }
    if (this.dialog) {
      if (key === 'escape') { this.dialog = null; this.focus.focus(); cx.notify(); }
      else if (key === 'enter' && this.dialog.kind === 'delete') this.confirmDelete(cx);
      return;
    }
    if (ctrl && key === 'n') { this.newChat(cx); cx.stop_propagation(); }
    else if (ctrl && key === 'b') { this.sidebar = !this.sidebar; this.persistPrefs(); cx.notify(); cx.stop_propagation(); }
    else if (key === 'escape' && this.running) this.stop(cx);
    else if (key === 'escape' && this.browser?.open) this.closeLink(cx);
  }
  // ---- links -------------------------------------------------------------

  // A link in a reply, or from the bar under the transcript, opens beside the
  // chat in one pane whose page later links reuse. It goes to the system
  // browser when the runtime has no WebView or cannot create one (a Wayland
  // window on Linux).
  openLink(url, cx) {
    if (!isWebUrl(url)) return;
    try {
      if (this.browser) this.browser.page.load_url(url);
      else if (WebViewState) { this.browser = { page: WebViewState.new(url) }; this.applyZoom(); }
      if (this.browser) { Object.assign(this.browser, { url, title: '', loading: true, open: true }); cx.notify(); return; }
    } catch (error) {
      this.message = { error: false, text: `Opened the link in your browser — ${reason(error)}` };
    }
    try { cx.open_url(url); } catch (error) { this.message = { error: true, text: `Couldn’t open ${url}: ${reason(error)}` }; }
    cx.notify();
  }
  closeLink(cx) {
    if (this.browser) this.browser.open = false;
    this.linkFull = false;
    this.focus.focus();
    cx.notify();
  }
  linkLoaded(url, cx) {
    if (!this.browser) return;
    // The page navigates on its own too, so the address follows the document.
    this.browser.url = url;
    this.browser.loading = false;
    try { this.browser.page.evaluate_script('window.ipc.postMessage(document.title)'); } catch {}
    cx.notify();
  }
  // The engine's own zoom, which it keeps across navigations.
  applyZoom() {
    try { this.browser?.page.set_zoom(this.linkZoom); } catch (error) { console.error(reason(error)); }
  }
  zoomLink(step, cx) {
    const index = ZOOMS.indexOf(this.linkZoom);
    this.linkZoom = step === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + step))];
    this.applyZoom();
    this.persistPrefs();
    cx.notify();
  }
  // How wide the link pane is: the width it was dragged to, or under half of
  // what the sidebar leaves, and never so wide that the chat column drops
  // below 360 pixels.
  linkPaneWidth() {
    return this.clampLinkWidth(this.linkWidth ?? Math.min(760, this.linkAvailable() * 0.46));
  }
  clampLinkWidth(width) {
    return Math.round(Math.max(LINK_MIN, Math.min(width, this.linkAvailable() - 360)));
  }
  linkAvailable() {
    let width = 1180;
    try { width = window.viewport_size().width; } catch {}
    return width - (this.sidebar ? this.sidebarWidth : 0);
  }
  // Dragging the pane's left edge, leftwards to widen it. The native page
  // would take the pointer as the edge moves over it, and relay out on every
  // move, so while the drag lasts the pane shows a placeholder instead.
  dragLink(event, cx) {
    const drag = this.linkDrag;
    if (!drag) return;
    const next = this.clampLinkWidth(drag.width - (event.position.x - drag.x));
    if (next !== drag.next) { drag.next = next; cx.notify(); }
  }
  endLinkDrag(cx) {
    const drag = this.linkDrag;
    if (!drag) return;
    this.linkDrag = null;
    this.linkWidth = drag.next;
    this.persistPrefs();
    cx.notify();
  }
  // ---- rendering ---------------------------------------------------------

  render(cx) {
    const conversation = this.current();
    const full = Boolean(this.browser?.open && this.linkFull);
    const main = full ? null : v_flex().size_full().min_h_0()
      .child(this.renderHeader(conversation, cx))
      .when(Boolean(this.message), (el) => el.child(this.renderBanner(cx)))
      .child(conversation && conversation.messages.length ? this.renderTranscript(conversation, cx) : this.renderWelcome(cx))
      .when(Boolean(conversation?.messages.length), (el) => { const actions = this.renderReplyActions(conversation, cx); return actions ? el.child(actions) : el; })
      .child(this.renderComposer(cx));
    // Full, the pane takes the whole chat area; the chat keeps its state and
    // comes back as it was.
    const content = !this.browser?.open ? main
      : full ? this.renderLinkPane(cx)
      : h_flex().size_full().min_h_0()
        .on_mouse_move((event, cx) => this.dragLink(event, cx))
        .on_mouse_up('left', (_event, cx) => this.endLinkDrag(cx))
        .child(div().flex_1().min_w_0().h_full().child(main))
        .child(div().id('link-resize').w(6).h_full().flex_shrink_0().cursor_col_resize()
          .on_mouse_down('left', (event, cx) => { const width = this.linkPaneWidth(); this.linkDrag = { x: event.position.x, width, next: width }; cx.stop_propagation(); cx.notify(); })
          .child(div().mx(2).w(2).h_full().rounded(1).bg(this.linkDrag ? theme().colors.borderStrong : theme().colors.clear).hover((style) => style.bg(theme().colors.border))))
        .child(this.renderLinkPane(cx));
    // Overlays — dialogs, menus — sit beside the frame, not inside it, so the
    // root carries the font for them to inherit.
    const sans = theme().fonts.sans;
    return div().id('chat').track_focus(this.focus).key_context('Chat').relative().size_full()
      .when(Boolean(sans), (el) => el.font_family(sans))
      .on_key_down((event, cx) => this.key(event, cx))
      .child(new AppFrame('chat-frame').sidebar(this.renderSidebar(cx)).main(content).collapsed(!this.sidebar).sidebarWidth(this.sidebarWidth)
        .resizable({ min: 200, max: 380, onResize: (width, cx) => { this.sidebarWidth = width; this.persistPrefs(); cx.notify(); } })
        .build(cx))
      // A native page that stops being drawn stays on screen, so a closed
      // pane's page is drawn at no size, which hides it.
      .when(Boolean(this.browser && !this.browser.open), (el) => el.child(div().absolute().w(0).h(0).overflow_hidden().child(WebView.new(this.browser.page).w(0).h(0))))
      .when(Boolean(this.dialog), (el) => el.child(this.renderDialog(cx)))
      .when(Boolean(this.menu && this.menu.kind !== 'model'), (el) => el.child(this.renderMenu(cx)))
      .when(this.menu?.kind === 'model', (el) => el.child(this.renderBackdrop(cx)));
  }
  renderSidebar(cx) {
    const query = this.search.value();
    const groups = groupByDate(filterConversations(this.conversations, query), Date.now());
    const items = [
      new Button('new-chat').label('New chat').icon(asset('plus')).variant('primary').fullWidth().tooltip('Ctrl + N')
        .onClick((_event, cx) => this.newChat(cx)).build(cx),
    ];
    if (!this.loaded) items.push(div().px(8).py(10).text_size(12).text_color(theme().colors.secondary).child('Loading chats…'));
    else if (!groups.length) items.push(div().px(8).py(10).text_size(12).text_color(theme().colors.secondary).child(query.trim() ? 'No chats match this search.' : 'No chats yet.'));
    for (const group of groups) {
      items.push(new NavSection(group.label).build(cx));
      for (const conversation of group.items) {
        items.push(new NavItem(`chat-${conversation.id}`).label(displayTitle(conversation))
          .selected(conversation.id === this.currentId).indicator(this.running?.conversation.id === conversation.id)
          .onClick((_event, cx) => this.select(conversation.id, cx))
          .onSecondaryPress((event, cx) => { cx.stop_propagation(); this.menu = { id: conversation.id, x: event.position.x, y: event.position.y }; cx.notify(); })
          .build(cx));
      }
    }
    const t = theme(), c = t.colors;
    const status = (id) => {
      const version = this.versions[id];
      return h_flex().h(26).px(8).gap(8).items_center()
        .child(div().text_color(version ? c.foreground : c.tertiary).child(icon(id, 13)))
        .child(div().flex_1().min_w_0().text_size(t.type.body).text_color(version ? c.foreground : c.secondary).child(PROVIDERS[id].label))
        .child(div().flex_shrink_0().text_size(t.type.small).font_family(t.fonts.mono).text_color(version ? c.secondary : c.tertiary)
          .child(version === null ? 'checking' : version || 'not installed'));
    };
    const sidebar = new Sidebar('nav').brand('Chat').brandMark(asset('message')).brandAction(this.renderToggle(cx))
      .search(new SearchField('chat-search', this.search).icon(asset('search')).build(cx))
      .children(items)
      .footer(v_flex().gap(1).children(providerIds.map(status)))
      .build(cx);
    return v_flex().size_full().min_h_0().pt(TRAFFIC_LIGHTS.top).child(sidebar);
  }
  renderHeader(conversation, cx) {
    const provider = PROVIDERS[this.provider];
    const model = provider.models.find((item) => item.id === this.model) ?? provider.models[0];
    const busy = Boolean(this.running && this.running.conversation === conversation);
    const actions = conversation ? [
      new IconButton('rename-chat').icon(asset('edit')).description('Rename chat').onClick((_e, cx) => this.askRename(conversation.id, cx)).build(cx),
      new IconButton('delete-chat').icon(asset('trash')).description('Delete chat…').disabled(busy).onClick((_e, cx) => this.askDelete(conversation.id, cx)).build(cx),
    ] : [];
    const count = conversation ? conversation.messages.length : 0;
    const header = new PageHeader(conversation ? displayTitle(conversation) : 'New chat').compact()
      .breadcrumb([provider.label, model.id || 'default model'])
      .badge(new Badge(busy ? 'Replying' : 'Ready').tone(busy ? 'accent' : 'neutral').dot().build(cx))
      .actions(actions);
    if (count) header.meta(`${count} message${count === 1 ? '' : 's'}`);
    if (!this.sidebar) header.leading(div().pl(TRAFFIC_LIGHTS.left).child(this.renderToggle(cx)));
    return header.build(cx);
  }
  // The toggle sits in the sidebar while it is open and moves to the start of
  // the title once the sidebar is shut.
  renderToggle(cx) {
    return new IconButton('toggle-sidebar').icon(asset('panel-left')).size('sm')
      .description(this.sidebar ? 'Hide sidebar (Ctrl + B)' : 'Show sidebar (Ctrl + B)')
      .onClick((_e, cx) => { this.sidebar = !this.sidebar; this.persistPrefs(); cx.notify(); }).build(cx);
  }
  renderBanner(cx) {
    const t = theme(), text = String(this.message.text).split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
    const tone = t.tone(this.message.error ? 'danger' : 'neutral');
    return h_flex().flex_shrink_0().mx(24).mb(8).px(12).h(34).gap(8).items_center().rounded(t.radius.control).bg(tone.bg).border(1).border_color(tone.border)
      .child(div().flex_1().min_w_0().truncate().text_size(t.type.body).text_color(tone.fg).child(text))
      .when(Boolean(this.message.undo && this.deleted), (el) => el.child(new Button('undo-delete').label('Undo').variant('outline').size('sm').onClick((_e, cx) => this.undoDelete(cx)).build(cx)))
      .child(new IconButton('dismiss').icon(asset('close')).description('Dismiss').size('sm').onClick((_e, cx) => { this.message = null; cx.notify(); }).build(cx));
  }
  renderWelcome(cx) {
    const provider = PROVIDERS[this.provider];
    const step = (id) => {
      const version = this.versions[id];
      return { title: id === 'claude' ? 'Claude Code' : 'Codex CLI', detail: version === null ? 'checking…' : version ? `v${version}` : 'not installed', done: Boolean(version) };
    };
    return div().id('welcome').flex_1().min_h_0().overflow_y_scrollbar().px(24).py(12)
      .child(h_flex().w_full().justify_center()
        .child(div().w_full().max_w(720)
          .child(new Card('welcome-card').title('New chat').subtitle(`${provider.label} · your local ${provider.command} sign-in`).icon(asset('message'))
            .trailing(new Tag(`${this.conversations.length} saved`).build(cx))
            .body(new EmptyState('What can I help with?').art(new IconBadge(asset('terminal')).size(48).build(cx))
              .description(`Replies come from your own ${provider.label} account through the ${provider.command} command. ${this.provider === 'claude' ? 'Tools are turned off.' : 'Codex runs read-only.'}`)
              .children([
                new Steps([step('claude'), step('codex'), { title: 'First message', detail: 'not yet' }]).build(cx),
                h_flex().flex_wrap().gap(8).justify_center().children(SUGGESTIONS.map((text, index) => new Chip(`suggestion-${index}`).label(text).sans()
                  .onClick((_event, cx) => { this.composer.set_value(text); cx.notify(); }).build(cx))),
              ]).build(cx))
            .build(cx))));
  }
  renderTranscript(conversation, cx) {
    return MessageScroller.new(`transcript-${conversation.id}`, this.scroller, (index) => {
      const message = conversation.messages[index];
      return message ? this.renderMessage(conversation, message) : null;
    }).scrollbar(true).jump_button(false).flex_1().min_h_0().w_full();
  }
  // Transcript rows are laid out by the list, so they hold no retained
  // components and paint with the theme's colors directly.
  renderMessage(conversation, message) {
    const t = theme(), c = t.colors;
    const column = (child) => h_flex().w_full().justify_center().py(10).child(v_flex().w_full().max_w(760).px(24).child(child));
    if (message.role === 'user') {
      return column(h_flex().w_full().justify_end()
        .child(h_flex().max_w('85%').min_h(36).px(14).py(8).items_center().rounded(t.radius.well).bg(c.raised)
          .child(div().text_size(t.type.body + 1).text_color(c.bright).whitespace_normal().child(message.text))));
    }
    const run = this.running?.assistant === message ? this.running : null;
    const provider = PROVIDERS[message.provider ?? conversation.provider];
    const parts = run ? [provider.label, `${Math.round((Date.now() - run.startedAt) / 1000)} s`] : [provider.label, message.model, message.durationMs ? formatDuration(message.durationMs) : null].filter(Boolean);
    const cost = !run && typeof message.cost === 'number' ? formatCost(message.cost) : null;
    const waiting = run && !message.text;
    return column(v_flex().w_full().gap(6)
      .child(h_flex().gap(6).items_center().text_size(t.type.small).font_family(t.fonts.mono).text_color(c.secondary)
        .child(div().text_color(run ? c.accent : c.secondary).child(icon(message.provider ?? conversation.provider, 12)))
        .child(parts.join(' · '))
        .when(Boolean(cost), (el) => el.child(div().text_color(c.accent).child(cost))))
      .when(Boolean(waiting), (el) => el.child(v_flex().gap(4)
        .child(ShimmerText.new(`${this.activityOf(run, Date.now()).label}…`).id(`shimmer-${message.id}`).text_size(t.type.body))
        .when(Boolean(run?.turn.thinking), (el) => el.child(div().text_size(t.type.small).text_color(c.tertiary).whitespace_normal().child(run.turn.thinking.slice(-600))))))
      .when(Boolean(message.text), (el) => el.child(TextView.markdown(`reply-${message.id}`, message.text).selectable(true).w_full().text_size(t.type.body + 1)
        // A runtime with WebView also lets transcript rows hold handlers; on
        // 0.7.3 the row would refuse this, and links go to the system browser.
        .when(Boolean(WebViewState), (el) => el.on_link_click((url, cx) => this.openLink(url, cx)))))
      .when(Boolean(message.error), (el) => el.child(div().text_size(t.type.body).text_color(t.tone('danger').fg).whitespace_normal().child(message.error))));
  }
  // Transcript rows cannot hold buttons, so the latest reply's actions sit
  // just under the transcript, on the same column as the messages' text,
  // with its web links, which open in the link pane.
  renderReplyActions(conversation, cx) {
    const last = conversation.messages[conversation.messages.length - 1];
    if (this.running || last?.role !== 'assistant') return null;
    const copied = this.copied === last.id;
    const links = extractLinks(last.text).slice(0, MAX_LINKS);
    return h_flex().w_full().flex_shrink_0().justify_center()
      .child(h_flex().w_full().max_w(760).px(18).gap(2).items_center()
        .when(Boolean(last.text), (el) => el.child(new IconButton('copy-reply').icon(asset(copied ? 'check' : 'copy')).size('sm').description(copied ? 'Copied' : 'Copy reply').onClick((_e, cx) => this.copy(last, cx)).build(cx)))
        .child(new IconButton('retry-reply').icon(asset('refresh')).size('sm').description('Retry').onClick((_e, cx) => this.retry(cx)).build(cx))
        .when(Boolean(last.interrupted && last.text), (el) => el.child(new Button('continue-reply').label('Continue').icon(asset('send')).variant('secondary').size('sm')
          .tooltip('Finish this reply from where it stopped').onClick((_e, cx) => this.continueReply(cx)).build(cx)))
        .when(links.length > 0, (el) => el.child(h_flex().flex_1().min_w_0().ml(6).gap(6).items_center().overflow_hidden()
          .child(div().flex_shrink_0().text_color(theme().colors.tertiary).child(icon('globe', 13)))
          .children(links.map((link, index) => new Chip(`reply-link-${index}`).label(link.label.length > 36 ? `${link.label.slice(0, 35)}…` : link.label).sans()
            .selected(Boolean(this.browser?.open) && this.browser.url === link.url).onClick((_e, cx) => this.openLink(link.url, cx)).build(cx))))));
  }
  renderComposer(cx) {
    const t = theme(), c = t.colors, provider = PROVIDERS[this.provider], running = Boolean(this.running);
    const empty = !this.composer.value().trim();
    const model = provider.models.find((item) => item.id === this.model) ?? provider.models[0];
    let wide = true, mainWidth = 800;
    try { mainWidth = window.viewport_size().width - (this.sidebar ? this.sidebarWidth : 0) - (this.browser?.open ? this.linkPaneWidth() + 6 : 0); wide = mainWidth >= 640; } catch {}
    // The scan line moves in pixels: the composer column, less its border
    // and the inset that keeps the bar off the rounded corners.
    const scanWidth = Math.max(40, Math.min(760, mainWidth - 48) - 2 - 2 * t.radius.card);
    const modelMenu = new MenuList('model-list').width(200).items(provider.models.map((item) => ({
      id: item.id || 'default', label: item.label, checked: item.id === this.model,
      onSelect: (cx) => { this.menu = null; this.setModel(item.id, cx); },
    }))).build(cx);
    return h_flex().w_full().flex_shrink_0().justify_center().px(24).pb(16).pt(8)
      .child(v_flex().w_full().max_w(760).gap(6)
        .when(running, (el) => el.child(this.renderActivity(wide, cx)))
        .child(v_flex().w_full().rounded(t.radius.card).overflow_hidden().bg(c.card).border(1).border_color(c.borderStrong)
          .when(running, (el) => el.child(div().w_full().px(t.radius.card).child(new ScanLine('composer-scan').step(Math.floor(this.running.tick / 2)).period(TICK_MS * 2).width(scanWidth).build(cx))))
          .child(div().w_full().px(14).pt(running ? 10 : 12).pb(12)
            .child(Textarea.new(this.composer).w_full().text_size(t.type.body + 1).when(Boolean(t.fonts.sans), (el) => el.font_family(t.fonts.sans))))
          .child(h_flex().w_full().min_w_0().px(8).pb(8).gap(6).items_center()
            .child(new Segmented('provider').options(providerIds.map((id) => ({ id, label: PROVIDERS[id].label }))).selected(this.provider)
              .disabled(running).onSelect((id, cx) => this.setProvider(id, cx)).build(cx))
            .when(provider.models.length > 1, (el) => el.child(Popup.new('model-popup', new SelectTrigger('model').value(model.label).mono().chevron(asset('chevron-down')).open(this.menu?.kind === 'model').disabled(running)
                .onClick((_e, cx) => { this.menu = this.menu?.kind === 'model' ? null : { kind: 'model' }; cx.notify(); }).build(cx))
              .anchor('bottom_left').when(this.menu?.kind === 'model', (el) => el.content(modelMenu))))
            .child(div().flex_1().min_w_0())
            .when(wide && !running, (el) => el.child(new Kbd('Enter sends').build(cx)))
            .child(running
              ? new Button('stop').label('Stop').icon(asset('stop')).variant('danger').size('sm').disabled(!this.running.cancel)
                .tooltip(this.running.cancel ? 'Stop (Esc)' : 'Stopping needs process.spawn in gpui-shell').onClick((_e, cx) => this.stop(cx)).build(cx)
              : new Button('send').label('Send').icon(asset('send')).variant('primary').size('sm').disabled(empty || !this.loaded).onClick((_e, cx) => this.send(cx)).build(cx))))
        .child(div().w_full().text_center().text_size(t.type.caption).text_color(c.tertiary)
          .child(`${provider.label} can make mistakes. Chats are saved on this computer.`)));
  }
  // The page a reply linked to, with its own history, beside the transcript.
  renderLinkPane(cx) {
    const t = theme(), c = t.colors, browser = this.browser;
    const nav = (id, name, description, action) => new IconButton(id).icon(asset(name)).size('sm').description(description)
      .onClick((_e, cx) => { try { action(cx); } catch (error) { console.error(reason(error)); } cx.notify(); }).build(cx);
    let host = browser.url;
    try { host = new URL(browser.url).host; } catch {}
    return v_flex().h_full().min_h_0().bg(c.main)
      .map((el) => this.linkFull ? el.flex_1().w_full() : el.flex_shrink_0().w(this.linkDrag?.next ?? this.linkPaneWidth()).border_l(1).border_color(c.border))
      .child(h_flex().flex_shrink_0().h(44).px(8).gap(2).items_center().border_b(1).border_color(c.border)
        .child(nav('link-back', 'chevron-left', 'Back', () => browser.page.back()))
        .child(nav('link-forward', 'chevron-right', 'Forward', () => browser.page.forward()))
        .child(nav('link-reload', 'refresh', 'Reload', () => { browser.loading = true; browser.page.reload(); }))
        .child(h_flex().flex_1().min_w_0().px(6).gap(6).items_center()
          .child(div().text_color(browser.loading ? c.accent : c.tertiary).child(icon('globe', 13)))
          .child(v_flex().flex_1().min_w_0()
            .child(div().truncate().text_size(t.type.body).text_color(c.bright).child(browser.title || host))
            .child(div().truncate().text_size(t.type.small).font_family(t.fonts.mono).text_color(c.tertiary).child(browser.url))))
        .child(nav('link-zoom-out', 'zoom-out', 'Zoom out', (cx) => this.zoomLink(-1, cx)))
        .child(new Button('link-zoom-reset').label(`${Math.round(this.linkZoom * 100)}%`).variant('ghost').size('sm').tooltip('Actual size').onClick((_e, cx) => this.zoomLink(0, cx)).build(cx))
        .child(nav('link-zoom-in', 'zoom-in', 'Zoom in', (cx) => this.zoomLink(1, cx)))
        .child(nav('link-full', this.linkFull ? 'minimize' : 'maximize', this.linkFull ? 'Restore (show the chat)' : 'Maximize (fill the chat area)', () => { this.linkFull = !this.linkFull; }))
        .child(nav('link-external', 'external', 'Open in browser', (cx) => cx.open_url(browser.page.url() || browser.url)))
        .child(nav('link-close', 'close', 'Close (Esc)', (cx) => this.closeLink(cx))))
      .child(this.linkDrag
        // Drawn at no size, the page is hidden until the drag ends.
        ? v_flex().flex_1().min_h_0().w_full().items_center().justify_center().gap(8).text_color(c.tertiary)
          .child(icon('globe', 28))
          .child(div().text_size(t.type.body).child(`${this.linkDrag.next} px`))
          .child(div().absolute().w(0).h(0).overflow_hidden().child(WebView.new(browser.page).w(0).h(0)))
        : WebView.new(browser.page).flex_1().min_h_0().w_full()
          .on_load((url, cx) => this.linkLoaded(url, cx))
          .on_message((title, cx) => { if (this.browser) { this.browser.title = String(title).trim(); cx.notify(); } }));
  }
  // What the turn is doing, just above the composer: a pulse that keeps
  // moving, the phase, and a running clock, so a long wait never looks stuck.
  renderActivity(wide, cx) {
    const t = theme(), c = t.colors, run = this.running, now = Date.now();
    const { label, detail } = this.activityOf(run, now);
    const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    return h_flex().w_full().h(24).px(6).gap(8).items_center()
      .child(new Pulse('activity-pulse').step(run.tick).period(TICK_MS).build(cx))
      .child(h_flex().flex_1().min_w_0().gap(8).items_baseline().overflow_hidden()
        .child(div().flex_shrink_0().max_w('60%').truncate().text_size(t.type.body).text_color(c.bright).child(label))
        .when(Boolean(detail), (el) => el.child(div().flex_1().min_w_0().truncate().text_size(t.type.small).text_color(c.tertiary).child(detail))))
      .child(div().flex_shrink_0().font_family(t.fonts.mono).text_size(t.type.small).text_color(c.tertiary).child(clock(now - run.startedAt)))
      .when(wide, (el) => el.child(new Kbd('Esc stops').build(cx)));
  }
  activityOf(run, now) {
    return describeActivity(run.turn, { label: PROVIDERS[run.provider].label, model: run.conversation.model, resuming: Boolean(run.sessionId), now });
  }
  // A press outside an open menu closes it.
  renderBackdrop(_cx) {
    return div().absolute().inset_0()
      .on_mouse_down('left', (_event, cx) => { this.menu = null; cx.notify(); })
      .on_mouse_down('right', (_event, cx) => { this.menu = null; cx.notify(); });
  }
  renderMenu(cx) {
    const menu = this.menu;
    const list = new MenuList('row-menu-list').width(180).items([
      { id: 'rename', label: 'Rename…', icon: asset('edit'), onSelect: (cx) => { this.menu = null; this.askRename(menu.id, cx); } },
      { id: 'delete', label: 'Delete…', icon: asset('trash'), danger: true, disabled: this.running?.conversation.id === menu.id, onSelect: (cx) => { this.menu = null; this.askDelete(menu.id, cx); } },
    ]).build(cx);
    return this.renderBackdrop(cx)
      .child(div().absolute().left(menu.x).top(menu.y).child(Popup.new('row-menu', div().size(1)).anchor('top_left').content(list)));
  }
  renderDialog(cx) {
    const t = theme(), dialog = this.dialog;
    const conversation = this.conversations.find((item) => item.id === dialog.id);
    const title = conversation ? displayTitle(conversation) : '';
    const rename = dialog.kind === 'rename';
    const body = rename
      ? h_flex().h(32).px(10).items_center().rounded(t.radius.control).bg(t.colors.well).border(1).border_color(t.colors.borderStrong).child(Input.new(this.renameState).flex_1().text_size(t.type.body).when(Boolean(t.fonts.sans), (el) => el.font_family(t.fonts.sans)))
      : div().text_size(t.type.body).text_color(t.colors.secondary).whitespace_normal()
        .child(`The chat is removed from this app. The ${PROVIDERS[conversation?.provider ?? 'claude'].label} session files on disk are kept.`);
    const footer = h_flex().w_full().justify_end().gap(8)
      .child(new Button(rename ? 'rename-cancel' : 'delete-cancel').label('Cancel').variant('secondary').onClick((_e, cx) => { this.dialog = null; this.focus.focus(); cx.notify(); }).build(cx))
      .child(rename
        ? new Button('rename-save').label('Rename').variant('primary').onClick((_e, cx) => this.confirmRename(cx)).build(cx)
        : new Button('delete-confirm').label('Delete').variant('danger').onClick((_e, cx) => this.confirmDelete(cx)).build(cx));
    // A decision that needs an answer is never dismissed by a backdrop press.
    return div().absolute().inset_0().flex().items_center().justify_center().bg(t.colors.scrim)
      .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); if (rename) { this.dialog = null; cx.notify(); } })
      .child(div().w(440).max_w('92%').on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .child(new Card('dialog').title(rename ? 'Rename chat' : `Delete “${title}”?`).icon(asset(rename ? 'edit' : 'trash')).body(body).footer(footer).build(cx)));
  }
}
