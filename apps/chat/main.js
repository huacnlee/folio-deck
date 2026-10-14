// @ts-check
import { View, div, svg } from 'gpui-kit';
import { h_flex, v_flex, Button, Input, InputState, Textarea, TextareaState, TextView, Popup } from 'gpui-base';
import { MessageScroller, MessageScrollerState, ShimmerText } from 'gpui-component';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { applyPalette, tones as T } from './theme.js';
import { DEFAULT, systemPalette } from './lib/theme.js';
import { PROVIDERS, providerIds, buildArgs, createTurn, applyLine, finishError, contextPrompt } from './lib/providers.js';
import { newConversation, titleFrom, displayTitle, groupByDate, filterConversations, serialize, parseStore, formatDuration, formatCost } from './lib/store.js';

const home = homedir();
const PREFS = 'chat.preferences.v1';
const SUGGESTIONS = [
  'Explain the difference between a process and a thread',
  'Write a shell one-liner that finds the ten largest files in a folder',
  'Review this plan and list the risks I am missing',
  'Summarize the main ideas of the Unix philosophy',
];
const icon = (name, size = 14) => svg(`chat/icons/${name}.svg`).size(size).flex_shrink_0();
const reason = (error) => String(error?.message ?? error).replace(/^Error:\s*/, '');
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { return {}; } }
function savePrefs(value) { try { localStorage.setItem(PREFS, JSON.stringify(value)); } catch {} }

export default class Chat extends View {
  init(_props, cx) {
    const prefs = loadPrefs();
    applyPalette();
    this.palette = DEFAULT;
    this.font = process.platform === 'darwin' ? 'Menlo' : 'JetBrainsMono Nerd Font';
    this.focus = cx.focus_handle();
    this.focus.focus();
    this.conversations = [];
    this.currentId = null;
    this.loaded = false;
    this.loadError = null;
    this.provider = providerIds.includes(prefs.provider) ? prefs.provider : 'claude';
    this.model = typeof prefs.model === 'string' ? prefs.model : '';
    this.sidebar = prefs.sidebar !== false;
    this.running = null;
    this.message = null;
    this.dialog = null;
    this.menu = null;
    this.deleted = null;
    this.copied = null;
    this.saveVersion = 0;
    this.notifyQueued = false;
    this.scroller = MessageScrollerState.new(0);
    this.dataFile = process.dataDir ? `${process.dataDir}/conversations.json` : null;
    this.workdir = process.dataDir ? `${process.dataDir}/workspace` : null;
    this.composer = TextareaState.new({ placeholder: this.placeholder(), rows: 1 });
    this.composer.set_auto_grow(1, 8);
    this.composer.on('change', (_event, cx) => cx.notify());
    this.composer.on('submit', (event, cx) => { if (event.secondary) this.send(cx); });
    this.search = InputState.new({ placeholder: 'Search chats' });
    this.search.on('change', (_event, cx) => cx.notify());
    this.renameState = InputState.new({ placeholder: 'Chat name' });
    this.renameState.on('submit', (_event, cx) => this.confirmRename(cx));
    this.load(cx);
    cx.spawn(async (cx) => {
      if (process.platform === 'darwin') return;
      const result = await process.run('fc-match', ['monospace', '-f', '%{family[0]}']).catch(() => null);
      const family = result?.code === 0 ? result.stdout.trim() : '';
      if (family) { this.font = family; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const palette = await systemPalette(fs, home);
        if (JSON.stringify(palette) !== JSON.stringify(this.palette)) { this.palette = palette; applyPalette(palette); cx.notify(); }
        await cx.sleep(2500);
      }
    });
  }

  // ---- persistence -------------------------------------------------------

  load(cx) {
    cx.spawn(async (cx) => {
      if (this.dataFile) {
        try {
          this.conversations = parseStore(await fs.readFile(this.dataFile, 'utf8'));
          // A reply still empty on disk was cut off when the app last closed.
          for (const conversation of this.conversations)
            for (const message of conversation.messages)
              if (message.role === 'assistant' && !message.text && !message.error) message.error = 'The reply was interrupted.';
        }
        catch (error) {
          // A missing file is a first launch; anything else must not be overwritten.
          if (!/ENOENT|No such file|not found/i.test(reason(error))) this.loadError = `Couldn’t read saved chats: ${reason(error)} New chats are not saved until this is fixed.`;
        }
        if (this.workdir) await fs.mkdir(this.workdir, { recursive: true }).catch(() => {});
      }
      this.loaded = true;
      if (this.loadError) this.message = { error: true, text: this.loadError };
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
  persistPrefs() { savePrefs({ provider: this.provider, model: this.model, sidebar: this.sidebar }); }

  // ---- conversations -----------------------------------------------------

  current() { return this.conversations.find((conversation) => conversation.id === this.currentId) ?? null; }
  placeholder() { return `Message ${PROVIDERS[this.provider].label}…`; }
  resetScroller(count) { this.scroller = MessageScrollerState.new(count); }
  select(id, cx) {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    this.currentId = id;
    this.provider = conversation.provider;
    this.model = conversation.model;
    this.composer.set_value('');
    this.resetScroller(conversation.messages.length);
    this.menu = null;
    cx.notify();
  }
  newChat(cx) {
    this.currentId = null;
    this.composer.set_value('');
    this.resetScroller(0);
    this.menu = null;
    cx.notify();
  }
  setProvider(provider, cx) {
    if (this.provider === provider) return;
    this.provider = provider;
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
  startTurn(conversation, text, history, cx, retried) {
    const provider = conversation.provider;
    // A session that missed turns answered by the other provider is stale.
    const lastProvider = [...history].reverse().find((message) => message.role === 'assistant')?.provider;
    if (lastProvider && lastProvider !== provider) delete conversation.sessions[provider];
    const sessionId = conversation.sessions[provider] ?? null;
    // Without a session for this provider, earlier messages travel in the prompt.
    const prompt = sessionId ? text : contextPrompt(history, text);
    const assistant = { id: randomUUID(), role: 'assistant', text: '', provider, ...(conversation.model ? { model: conversation.model } : {}), at: Date.now() };
    conversation.messages.push(assistant);
    const run = { conversation, assistant, provider, sessionId, text, history, retried, turn: createTurn(), stderr: [], startedAt: Date.now(), cancel: null, cancelled: false };
    this.running = run;
    this.resetScroller(conversation.messages.length);
    cx.notify();
    const command = PROVIDERS[provider].command;
    const args = buildArgs(provider, { prompt, sessionId, model: conversation.model });
    const onLine = (line, cx) => {
      if (this.running !== run || !applyLine(provider, run.turn, line)) return;
      assistant.text = run.turn.text;
      this.notifySoon(cx);
    };
    const onExit = (exit, cx) => this.finishTurn(run, exit, cx);
    // Stream when the runtime can; otherwise wait for the whole reply.
    if (typeof process.spawn === 'function') {
      try {
        const child = process.spawn(command, args, { lines: true, stdin: 'null', ...(this.workdir ? { cwd: this.workdir } : {}) });
        child.on('stdout', onLine).on('stderr', (line) => { run.stderr.push(line); }).on('exit', onExit);
        run.cancel = () => child.kill();
      } catch (error) { this.finishTurn(run, { code: null, error: reason(error) }, cx); }
    } else {
      cx.spawn(async (cx) => {
        let output;
        try { output = await process.run(command, args); }
        catch (error) { this.finishTurn(run, { code: null, error: reason(error) }, cx); return; }
        for (const line of output.stdout.split('\n')) onLine(line, cx);
        run.stderr.push(output.stderr);
        this.finishTurn(run, { code: output.code }, cx);
      });
    }
    cx.spawn(async (cx) => {
      while (this.running === run) { await cx.sleep(1000); if (this.running === run) cx.notify(); }
    });
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
      conversation.messages.pop();
      this.startTurn(conversation, run.text, run.history, cx, true);
      return;
    }
    assistant.text = turn.text;
    if (turn.thinking) assistant.thinking = turn.thinking;
    if (turn.model) assistant.model = turn.model;
    if (turn.cost !== null) assistant.cost = turn.cost;
    assistant.durationMs = Date.now() - run.startedAt;
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
  }
  composerKey(event, cx) {
    const key = event.key.toLowerCase();
    if (key !== 'enter' || event.modifiers.shift || event.modifiers.alt) return;
    // Enter sends; Shift + Enter falls through to the textarea as a newline.
    cx.stop_propagation();
    this.send(cx);
  }

  // ---- rendering ---------------------------------------------------------

  // Omarchy buttons: plain is transparent until hovered; outline, primary and
  // danger express emphasis through edge and text, never a solid fill.
  button(id, label, iconName, onClick, { disabled = false, selected = false, variant = 'plain', tip = '' } = {}) {
    const edge = { plain: T.clear, outline: T.controlBorder, primary: T.accent, danger: T.danger }[variant];
    const ink = { primary: T.accent, danger: T.danger }[variant] ?? T.foreground;
    return Button.new(id).flex_shrink_0().px(label ? 10 : 6).py(5)
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
    const conversation = this.current();
    return h_flex().id('chat').track_focus(this.focus).key_context('Chat').relative().size_full().min_w_0().items_stretch()
      .bg(T.background).text_color(T.foreground).text_size(12).font_family(this.font)
      .on_key_down((event, cx) => this.key(event, cx))
      .when(this.sidebar, (el) => el.child(this.renderSidebar(cx)))
      .child(v_flex().flex_1().min_w_0().min_h_0()
        .child(this.renderHeader(conversation, cx))
        .when(Boolean(this.message), (el) => el.child(this.renderBanner(cx)))
        .child(conversation && conversation.messages.length ? this.renderTranscript(conversation, cx) : this.renderWelcome(cx))
        .when(Boolean(conversation?.messages.length), (el) => { const actions = this.renderReplyActions(conversation, cx); return actions ? el.child(actions) : el; })
        .child(this.renderComposer(cx)))
      .when(Boolean(this.dialog), (el) => el.child(this.renderDialog(cx)))
      .when(Boolean(this.menu), (el) => el.child(this.renderMenu(cx)));
  }
  renderSidebar(cx) {
    const query = this.search.value();
    const groups = groupByDate(filterConversations(this.conversations, query), Date.now());
    const heading = (text) => div().h(28).px(8).pt(10).text_size(10).font_bold().text_color(T.secondary).child(text.toUpperCase());
    // Pointer listeners belong on an element the shell owns, so a row wraps its Button.
    const row = (conversation) => {
      const current = conversation.id === this.currentId, busy = this.running?.conversation.id === conversation.id;
      return div().w_full().flex_shrink_0()
        .on_mouse_down('right', (event, cx) => { cx.stop_propagation(); this.menu = { id: conversation.id, x: event.position.x, y: event.position.y }; cx.notify(); })
        .child(Button.new(`chat-${conversation.id}`).w_full().h(30).accessibility_label(displayTitle(conversation))
          .bg(current ? T.selected : T.clear).when(current, (el) => el.font_bold())
          .when(!current, (el) => el.hover((style) => style.bg(T.hover)))
          .on_click((_event, cx) => this.select(conversation.id, cx))
          .child(h_flex().w_full().h_full().px(8).gap(8).items_center().justify_start()
            .child(div().flex_1().min_w_0().truncate().child(displayTitle(conversation)))
            .when(busy, (el) => el.child(div().size(6).flex_shrink_0().bg(T.accent)))));
    };
    return v_flex().w(260).flex_shrink_0().min_h_0().p(8).gap(6).border_r(1).border_color(T.divider)
      .child(h_flex().gap(4).items_center()
        .child(this.button('new-chat', 'New chat', 'plus', (cx) => this.newChat(cx), { variant: 'outline', tip: 'Ctrl + N' }).flex_1())
        .child(this.button('hide-sidebar', '', 'panel-left', (cx) => { this.sidebar = false; this.persistPrefs(); cx.notify(); }, { tip: 'Hide sidebar (Ctrl + B)' })))
      .child(h_flex().h(28).px(8).gap(8).items_center().bg(T.normal).border(1).border_color(T.controlBorder)
        .child(div().text_color(T.secondary).child(icon('search', 12))).child(Input.new(this.search).flex_1().min_w_0().text_size(12)))
      .child(v_flex().id('chat-list').flex_1().min_h_0().overflow_y_scrollbar()
        .when(!this.loaded, (el) => el.child(div().p(8).text_color(T.secondary).child('Loading chats…')))
        .when(this.loaded && !groups.length, (el) => el.child(div().p(8).text_color(T.secondary).child(query.trim() ? 'No chats match this search.' : 'No chats yet. Start one on the right.')))
        .children(groups.flatMap((group) => [heading(group.label), ...group.items.map(row)])));
  }
  renderHeader(conversation, cx) {
    return h_flex().h(44).flex_shrink_0().px(12).gap(8).items_center().border_b(1).border_color(T.divider)
      .when(!this.sidebar, (el) => el.child(this.button('show-sidebar', '', 'panel-left', (cx) => { this.sidebar = true; this.persistPrefs(); cx.notify(); }, { tip: 'Show sidebar (Ctrl + B)' })))
      .child(div().flex_1().min_w_0().truncate().text_size(14).font_bold().child(conversation ? displayTitle(conversation) : 'New chat'))
      .when(Boolean(conversation), (el) => el
        .child(this.button('rename-chat', '', 'edit', (cx) => this.askRename(conversation.id, cx), { tip: 'Rename chat' }))
        .child(this.button('delete-chat', '', 'trash', (cx) => this.askDelete(conversation.id, cx), { tip: 'Delete chat…', disabled: this.running?.conversation.id === conversation?.id })));
  }
  renderBanner(cx) {
    const text = String(this.message.text).split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
    return h_flex().h(32).flex_shrink_0().px(12).gap(6).items_center().border_b(1).border_color(T.divider)
      .child(div().id('banner-text').flex_1().min_w_0().truncate().text_color(this.message.error ? T.danger : T.foreground).child(text))
      .when(Boolean(this.message.undo && this.deleted), (el) => el.child(this.button('undo-delete', 'Undo', '', (cx) => this.undoDelete(cx), { variant: 'outline' }).py(2)))
      .child(this.button('dismiss', '', 'close', (cx) => { this.message = null; cx.notify(); }, { tip: 'Dismiss' }).py(2));
  }
  renderWelcome(cx) {
    const provider = PROVIDERS[this.provider];
    return v_flex().flex_1().min_h_0().items_center().justify_center().p(24).gap(14)
      .child(div().text_size(24).font_bold().text_color(T.bright).child('What can I help with?'))
      .child(div().max_w(520).text_center().text_color(T.secondary)
        .child(`Replies come from ${provider.label} through your local \`${provider.command}\` sign-in. ${this.provider === 'claude' ? 'Tools are turned off.' : 'Codex runs read-only.'}`))
      .child(v_flex().w_full().max_w(560).gap(6).pt(6)
        .children(SUGGESTIONS.map((text, index) => Button.new(`suggestion-${index}`).w_full().accessibility_label(text)
          .border(1).border_color(T.controlBorder).bg(T.normal).hover((style) => style.bg(T.hover))
          .on_click((_event, cx) => { this.composer.set_value(text); cx.notify(); })
          .child(h_flex().w_full().px(12).py(8).gap(8).items_center().justify_start()
            .child(div().text_color(T.secondary).child(icon('message', 12)))
            .child(div().flex_1().min_w_0().truncate().child(text))))));
  }
  renderTranscript(conversation, cx) {
    return MessageScroller.new(`transcript-${conversation.id}`, this.scroller, (index) => {
      const message = conversation.messages[index];
      return message ? this.renderMessage(conversation, message) : null;
    }).scrollbar(true).jump_button(true).jump_button_label('Latest').flex_1().min_h_0().w_full();
  }
  renderMessage(conversation, message) {
    const column = (child) => h_flex().w_full().justify_center().py(10).child(v_flex().w_full().max_w(780).px(24).child(child));
    if (message.role === 'user') {
      return column(h_flex().w_full().justify_end()
        .child(div().max_w('85%').px(12).py(8).bg(T.selected).text_color(T.bright).whitespace_normal().child(message.text)));
    }
    const run = this.running?.assistant === message ? this.running : null;
    const provider = PROVIDERS[message.provider ?? conversation.provider];
    const meta = [provider.label, message.model, message.durationMs ? formatDuration(message.durationMs) : null, typeof message.cost === 'number' ? formatCost(message.cost) : null].filter(Boolean).join(' · ');
    const waiting = run && !message.text;
    return column(v_flex().w_full().gap(6)
      .child(h_flex().gap(6).items_center().text_size(11).text_color(T.secondary)
        .child(icon('terminal', 12)).child(run ? `${provider.label} · ${Math.round((Date.now() - run.startedAt) / 1000)} s` : meta))
      .when(Boolean(waiting), (el) => el.child(v_flex().gap(4)
        .child(ShimmerText.new(run.turn.activity || 'Thinking…').id(`shimmer-${message.id}`))
        .when(Boolean(run?.turn.thinking), (el) => el.child(div().text_size(11).text_color(T.secondary).whitespace_normal().child(run.turn.thinking.slice(-600))))))
      .when(Boolean(message.text), (el) => el.child(TextView.markdown(`reply-${message.id}`, message.text).selectable(true).w_full().text_size(13)))
      .when(Boolean(message.error), (el) => el.child(div().text_color(T.danger).whitespace_normal().child(message.error))));
  }
  // Transcript rows are laid out by the list and cannot own handlers, so the
  // latest reply's actions sit between the transcript and the composer.
  renderReplyActions(conversation, cx) {
    const last = conversation.messages[conversation.messages.length - 1];
    if (this.running || last?.role !== 'assistant') return null;
    return h_flex().w_full().flex_shrink_0().justify_center().px(24)
      .child(h_flex().w_full().max_w(780).gap(2).items_center()
        .when(Boolean(last.text), (el) => el.child(this.button('copy-reply', this.copied === last.id ? 'Copied' : 'Copy', this.copied === last.id ? 'check' : 'copy', (cx) => this.copy(last, cx), { tip: 'Copy the latest reply' })))
        .child(this.button('retry-reply', 'Retry', 'refresh', (cx) => this.retry(cx), { tip: 'Ask again' })));
  }
  renderComposer(cx) {
    const provider = PROVIDERS[this.provider], running = Boolean(this.running);
    const empty = !this.composer.value().trim();
    const model = provider.models.find((item) => item.id === this.model) ?? provider.models[0];
    return h_flex().w_full().flex_shrink_0().justify_center().px(24).pb(14).pt(6)
      .child(v_flex().w_full().max_w(780).gap(6)
        .child(v_flex().w_full().bg(T.normal).border(1).border_color(T.controlBorder)
          .child(div().w_full().px(12).pt(10).pb(4).on_key_down((event, cx) => this.composerKey(event, cx))
            .child(Textarea.new(this.composer).w_full().text_size(13)))
          .child(h_flex().h(36).px(6).gap(4).items_center()
            .child(h_flex().gap(2)
              .children(providerIds.map((id) => this.button(`provider-${id}`, PROVIDERS[id].label, '', (cx) => this.setProvider(id, cx), { selected: this.provider === id, disabled: running }))))
            .when(provider.models.length > 1, (el) => el.child(Popup.new('model-popup', this.button('model', model.label, 'chevron-down', (cx) => { this.menu = { kind: 'model' }; cx.notify(); }, { disabled: running, tip: 'Model' }))
              .anchor('bottom_left').when(this.menu?.kind === 'model', (el) => el.content(this.renderMenuList(cx)))))
            .child(div().flex_1())
            .child(div().text_size(11).text_color(T.secondary).child(running ? 'Esc stops' : 'Enter sends · Shift + Enter adds a line'))
            .child(running
              ? this.button('stop', 'Stop', 'stop', (cx) => this.stop(cx), { variant: 'danger', disabled: !this.running.cancel, tip: this.running.cancel ? 'Stop (Esc)' : 'Stopping needs streaming support (process.spawn) in gpui-shell' })
              : this.button('send', 'Send', 'send', (cx) => this.send(cx), { variant: 'primary', disabled: empty || !this.loaded }))))
        .child(div().w_full().text_center().text_size(10).text_color(T.secondary)
          .child(`${provider.label} can make mistakes. Chats are saved on this computer.`)));
  }
  renderMenuList(cx) {
    const menu = this.menu;
    const items = menu.kind === 'model'
      ? PROVIDERS[this.provider].models.map((model) => ({ label: model.label, check: model.id === this.model, run: (cx) => this.setModel(model.id, cx) }))
      : [
        { label: 'Rename…', icon: 'edit', run: (cx) => this.askRename(menu.id, cx) },
        { label: 'Delete…', icon: 'trash', danger: true, disabled: this.running?.conversation.id === menu.id, run: (cx) => this.askDelete(menu.id, cx) },
      ];
    return v_flex().w(menu.kind === 'model' ? 180 : 200).p(6).gap(2).bg(T.background).border(1).border_color(T.accent)
      .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
      .children(items.map((item, index) => Button.new(`menu-${index}`).w_full().h(28).accessibility_label(item.label).disabled(Boolean(item.disabled))
        .when(Boolean(item.disabled), (el) => el.opacity(0.45))
        .when(!item.disabled, (el) => el.hover((style) => style.bg(T.hover)))
        .on_click((_event, cx) => { this.menu = null; item.run(cx); cx.notify(); })
        .child(h_flex().w_full().h_full().px(8).gap(8).items_center().justify_start().text_color(item.danger ? T.danger : T.foreground)
          .child(div().w(14).flex_shrink_0().child(item.icon ? icon(item.icon) : item.check ? icon('check') : div()))
          .child(div().flex_1().min_w_0().truncate().child(item.label)))));
  }
  // A press outside the open menu closes it. The model menu is anchored to its
  // button in the composer; a chat's menu opens at the pointer.
  renderMenu(cx) {
    const menu = this.menu;
    return div().absolute().inset_0()
      .on_mouse_down('left', (_event, cx) => { this.menu = null; cx.notify(); })
      .on_mouse_down('right', (_event, cx) => { this.menu = null; cx.notify(); })
      .when(menu.kind !== 'model', (el) => el.child(div().absolute().left(menu.x).top(menu.y)
        .child(Popup.new('row-menu', div().size(1)).anchor('top_left').content(this.renderMenuList(cx)))));
  }
  renderDialog(cx) {
    const dialog = this.dialog;
    const conversation = this.conversations.find((item) => item.id === dialog.id);
    const title = conversation ? displayTitle(conversation) : '';
    const body = dialog.kind === 'rename'
      ? v_flex().gap(14)
        .child(div().text_size(16).font_bold().child('Rename chat'))
        .child(h_flex().h(30).px(10).items_center().bg(T.normal).border(1).border_color(T.controlBorder).child(Input.new(this.renameState).flex_1().text_size(12)))
        .child(h_flex().justify_end().gap(6)
          .child(this.button('rename-cancel', 'Cancel', '', (cx) => { this.dialog = null; cx.notify(); }, { variant: 'outline' }))
          .child(this.button('rename-save', 'Rename', '', (cx) => this.confirmRename(cx), { variant: 'primary' })))
      : v_flex().gap(14)
        .child(div().text_size(16).font_bold().child(`Delete “${title}”?`))
        .child(div().text_color(T.secondary).whitespace_normal().child(`The chat is removed from this app. The ${PROVIDERS[conversation?.provider ?? 'claude'].label} session files on disk are kept.`))
        .child(h_flex().justify_end().gap(6)
          .child(this.button('delete-cancel', 'Cancel', '', (cx) => { this.dialog = null; cx.notify(); }, { variant: 'outline' }))
          .child(this.button('delete-confirm', 'Delete', '', (cx) => this.confirmDelete(cx), { variant: 'danger' })));
    // A decision that needs an answer is never dismissed by a backdrop press.
    return div().absolute().inset_0().flex().items_center().justify_center().bg(T.scrim)
      .on_mouse_down('left', (_event, cx) => { cx.stop_propagation(); if (dialog.kind === 'rename') { this.dialog = null; cx.notify(); } })
      .child(v_flex().w(420).max_w('92%').p(18).bg(T.background).border(1).border_color(T.accent)
        .on_mouse_down('left', (_event, cx) => cx.stop_propagation())
        .child(body));
  }
}
