import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, h_resizable, resizable_panel } from 'gpui-base';
import { Button, InputState, TextareaState, InputGroup, InputGroupInput, InputGroupTextarea } from 'gpui-component';
import { CallbackListener } from './oauth-callback.js';
import { GmailClient, beginAuthorization, mailboxAddress, buildRawMessage } from './gmail.js';

const component = (Type, ...args) => typeof Type.new === 'function' ? Type.new(...args) : new Type(...args);
const icon = (name, size = 16) => svg(`forma/assets/${name}.svg`).size(size).flex_shrink_0();
const text = (value, cx, size = 13, muted = false) => div().text_size(size).text_color(muted ? cx.theme().colors.muted_foreground : cx.theme().colors.foreground).child(value);
const avatarNames = ['maya', 'clara', 'noah', 'leo2'];
const avatarName = sender => avatarNames[Array.from(sender || '').reduce((hash, char) => hash + char.charCodeAt(0), 0) % avatarNames.length];
const photo = (sender, size) => image(`forma/assets/${avatarName(sender)}.svg`).size(size).rounded(8).flex_shrink_0();
const domain = address => mailboxAddress(address).split('@')[1] || '';
const folders = [['INBOX', 'Inbox'], ['UNREAD', 'Unread'], ['STARRED', 'Starred'], ['SENT', 'Sent'], ['DRAFT', 'Drafts'], ['', 'All mail'], ['TRASH', 'Trash']];
const dateLabel = value => {
  if (!value) return '';
  const date = new Date(value);
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getMonth()]} ${date.getDate()}`;
};

export default class GmailView extends View {
  init(_props, cx) {
    this.client = new GmailClient();
    this.messages = [];
    this.message = null;
    this.selectedId = null;
    this.folder = 'INBOX';
    this.query = '';
    this.reverse = false;
    this.nextPageToken = '';
    this.loading = false;
    this.reading = false;
    this.sending = false;
    this.mutating = false;
    this.error = '';
    this.status = '';
    this.listRevision = 0;
    this.readRevision = 0;
    this.searchRevision = 0;
    this.pendingAuth = null;
    this.authorizing = false;
    this.listener = null;
    this.connecting = false;
    this.setupOpen = !this.client.session;
    this.remember = true;
    this.credentials = TextareaState('');
    this.callback = InputState('Paste the localhost callback address…');
    this.search = InputState('Search Gmail…');
    this.to = InputState('Recipient email address');
    this.subject = InputState('Subject');
    this.body = TextareaState('');
    this.draft = null;
    this.undoAction = null;
    this.focus = cx.focus_handle();
    cx.bind_keys([
      { keystroke: 'alt-up', action: 'gmail-previous', context: 'GmailMail' },
      { keystroke: 'alt-down', action: 'gmail-next', context: 'GmailMail' },
      { keystroke: 'ctrl-enter', action: 'gmail-send', context: 'GmailMail' },
      { keystroke: 'cmd-enter', action: 'gmail-send', context: 'GmailMail' },
      { keystroke: 'escape', action: 'gmail-close', context: 'GmailMail' },
    ]);
    if (this.client.session) cx.spawn(async cx => { await this.refresh(cx); });
  }

  draftKey() { return `folio-gmail-draft-v1:${this.client.session?.email || ''}`; }
  saveDraft() {
    if (!this.client.session || !this.draft) return;
    try { localStorage.setItem(this.draftKey(), JSON.stringify(this.draft)); }
    catch { this.error = 'This draft could not be saved locally. Keep the window open until you send it.'; }
  }
  setDraft(draft, cx) {
    this.draft = draft;
    this.to.set_value(draft.to || ''); this.subject.set_value(draft.subject || ''); this.body.set_value(draft.body || '');
    this.saveDraft(); cx.notify();
  }
  compose(cx, reply = null) {
    if (this.sending || !this.client.session) return;
    this.error = '';
    if (reply) {
      this.setDraft({ to: mailboxAddress(reply.replyTo), subject: /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`, body: '', threadId: reply.threadId, inReplyTo: reply.messageId, references: [reply.references, reply.messageId].filter(Boolean).join(' ') }, cx);
    } else {
      let saved;
      try { saved = JSON.parse(localStorage.getItem(this.draftKey()) || 'null'); } catch { saved = null; }
      this.setDraft(saved || { to: '', subject: '', body: '' }, cx);
    }
  }
  close(cx) {
    if (this.sending || this.connecting) return;
    this.cancelLogin(cx);
    if (this.draft) { this.saveDraft(); this.draft = null; }
    else if (this.setupOpen && this.client.session) { this.setupOpen = false; this.pendingAuth = null; this.callback.set_value(''); }
    this.focus.focus(); cx.notify();
  }

  async refresh(cx, append = false) {
    if (!this.client.session) return;
    const revision = ++this.listRevision;
    const clientRevision = this.client.revision;
    const folder = this.folder, query = this.query, pageToken = append ? this.nextPageToken : '';
    this.loading = true; this.error = ''; cx.notify();
    try {
      const page = await this.client.list({ folder, query, pageToken });
      if (revision !== this.listRevision || clientRevision !== this.client.revision) return;
      const rows = append ? [...this.messages, ...page.messages] : page.messages;
      this.messages = rows.filter((m, i) => rows.findIndex(other => other.id === m.id) === i);
      this.nextPageToken = page.nextPageToken;
      if (!this.messages.some(m => m.id === this.selectedId)) { this.selectedId = null; this.message = null; }
      this.status = 'Up to date';
    } catch (error) {
      if (revision === this.listRevision && clientRevision === this.client.revision) this.error = error.message;
    } finally { if (revision === this.listRevision) { this.loading = false; cx.notify(); } }
  }

  changeFolder(folder, cx) {
    if (this.sending) return;
    this.folder = folder; this.messages = []; this.selectedId = null; this.message = null; this.nextPageToken = '';
    ++this.readRevision; this.reading = false; this.draft = null;
    cx.spawn(async cx => { await this.refresh(cx); }); cx.notify();
  }

  select(message, cx) {
    if (this.sending) return;
    const revision = ++this.readRevision;
    const clientRevision = this.client.revision;
    this.selectedId = message.id; this.message = null; this.reading = true; this.draft = null; this.error = ''; cx.notify();
    cx.spawn(async cx => {
      try {
        const loaded = await this.client.read(message.id);
        if (revision !== this.readRevision || clientRevision !== this.client.revision) return;
        this.message = loaded; this.reading = false; cx.notify();
        if (loaded.unread) {
          await this.client.modify(loaded.id, [], ['UNREAD']);
          if (clientRevision !== this.client.revision) return;
          this.messages = this.messages.map(m => m.id === loaded.id ? { ...m, unread: false } : m);
          if (this.message?.id === loaded.id) this.message.unread = false;
          cx.notify();
        }
      } catch (error) {
        if (revision === this.readRevision && clientRevision === this.client.revision) { this.error = error.message; this.reading = false; cx.notify(); }
      }
    });
  }

  mutate(operation, cx) {
    const message = this.message;
    if (!message || this.mutating || this.sending) return;
    const clientRevision = this.client.revision;
    this.mutating = true; this.error = ''; cx.notify();
    cx.spawn(async cx => {
      try {
        if (operation === 'archive') await this.client.modify(message.id, [], ['INBOX']);
        else if (operation === 'trash') await this.client.trash(message.id);
        else if (operation === 'star') await this.client.modify(message.id, message.starred ? [] : ['STARRED'], message.starred ? ['STARRED'] : []);
        else if (operation === 'unread') await this.client.modify(message.id, ['UNREAD'], []);
        if (clientRevision !== this.client.revision) return;
        if (operation === 'archive' || operation === 'trash') {
          this.undoAction = { id: message.id, operation };
          this.selectedId = null; this.message = null; ++this.readRevision;
          this.status = operation === 'archive' ? 'Archived · Undo available' : 'Moved to Trash · Undo available';
        } else if (operation === 'star' && this.message?.id === message.id) this.message.starred = !message.starred;
        else if (operation === 'unread' && this.message?.id === message.id) this.message.unread = true;
        await this.refresh(cx);
      } catch (error) { if (clientRevision === this.client.revision) this.error = error.message; }
      finally { this.mutating = false; cx.notify(); }
    });
  }

  undo(cx) {
    const action = this.undoAction;
    if (!action || this.mutating) return;
    this.mutating = true; cx.notify();
    cx.spawn(async cx => {
      try {
        if (action.operation === 'trash') await this.client.untrash(action.id);
        else await this.client.modify(action.id, ['INBOX'], []);
        this.undoAction = null; await this.refresh(cx);
      } catch (error) { this.error = error.message; }
      finally { this.mutating = false; cx.notify(); }
    });
  }

  startLogin(cx) {
    if (this.authorizing || this.connecting) return;
    this.error = '';
    let authorization;
    try { authorization = beginAuthorization(this.credentials.value()); }
    catch (error) { this.error = error.message; cx.notify(); return; }
    this.pendingAuth = authorization.pending;
    this.listener = new CallbackListener(this.pendingAuth);
    const listener = this.listener;
    this.authorizing = true;
    this.status = 'Starting Google sign-in'; cx.notify();
    cx.spawn(async cx => {
      try {
        await listener.start();
        if (this.listener !== listener) return;
        this.status = 'Waiting for Google authorization';
        cx.open_url(authorization.url); cx.notify();
        while (this.listener === listener && Date.now() - authorization.pending.createdAt < 10 * 60 * 1000) {
          const callback = await listener.poll();
          if (this.listener !== listener) return;
          if (callback) { this.callback.set_value(callback); this.authorizing = false; this.finishLogin(cx); return; }
          await cx.sleep(400);
        }
        if (this.listener === listener) throw new Error('Google sign-in expired. Start again.');
      } catch (error) {
        if (this.listener === listener) { this.error = error.message; this.pendingAuth = null; }
      } finally {
        await listener.stop();
        if (this.listener === listener) { this.listener = null; this.authorizing = false; cx.notify(); }
      }
    });
  }
  cancelLogin(cx) {
    const listener = this.listener;
    this.listener = null; this.pendingAuth = null; this.authorizing = false; this.status = '';
    if (listener) cx.spawn(async () => { await listener.stop(); });
    cx.notify();
  }
  finishLogin(cx) {
    if (!this.pendingAuth || this.connecting) return;
    const pending = this.pendingAuth;
    this.connecting = true; this.error = ''; cx.notify();
    cx.spawn(async cx => {
      try {
        await this.client.connect(pending, this.callback.value(), this.remember);
        this.pendingAuth = null; this.callback.set_value(''); this.credentials.set_value('');
        this.setupOpen = false; this.messages = []; this.message = null; this.selectedId = null; this.draft = null;
        this.folder = 'INBOX'; this.query = ''; this.search.set_value(''); this.undoAction = null;
        ++this.readRevision; await this.refresh(cx);
      } catch (error) { this.error = error.message; }
      finally { this.connecting = false; cx.notify(); }
    });
  }
  disconnect(cx) {
    if (this.sending || this.connecting || this.mutating) return;
    this.saveDraft(); this.client.disconnect(); ++this.listRevision; ++this.readRevision;
    this.messages = []; this.message = null; this.selectedId = null; this.draft = null; this.undoAction = null;
    this.loading = false; this.reading = false; this.pendingAuth = null; this.setupOpen = true; this.error = ''; this.status = 'Disconnected'; cx.notify();
  }

  send(cx) {
    if (!this.draft || this.sending || this.draft.uncertain || !this.client.session) return;
    const draft = { ...this.draft };
    try { buildRawMessage({ ...draft, from: this.client.session.email }); } catch (error) { this.error = error.message; cx.notify(); return; }
    this.sending = true; this.error = ''; this.status = 'Sending email'; this.saveDraft(); cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.send(draft);
        if (!result.id) throw new Error('Gmail did not confirm delivery. Check Sent before sending again.');
        localStorage.removeItem(this.draftKey()); this.draft = null; this.status = 'Email sent';
        await this.refresh(cx);
      } catch (error) {
        this.error = error.message;
        if (['offline', 'unavailable', 'invalid_response'].includes(error.code) || !error.code) {
          this.draft.uncertain = true;
          this.error = 'Delivery could not be confirmed. Check Sent before trying again.';
        }
        this.saveDraft();
      } finally { this.sending = false; cx.notify(); }
    });
  }

  button(id, label, cx, action, disabled = false) {
    return component(Button, id).ghost().size('small').label(label).disabled(disabled).on_click((_event, cx) => action(cx));
  }
  input(id, state, cx, label, onChange) {
    return component(InputGroup, id).w_full().min_w_0().h(34)
      .input(component(InputGroupInput, state).aria_label(label).on_change((value, cx) => onChange(value, cx)));
  }

  setup(cx) {
    return v_flex().flex_1().min_h_0().id('gmail-setup-scroll').overflow_y_scroll().items_center().p_6()
      .child(v_flex().w_full().max_w(640).gap_4()
        .child(text('Your mail, in a quieter place.', cx, 24).font_medium())
        .child(text('Connect Gmail to read, search, reply and send from Folio.', cx, 14, true))
        .child(text('1. Create a Desktop app OAuth client in Google Cloud and enable the Gmail API.', cx, 13))
        .child(this.button('google-cloud', 'Open Google Cloud…', cx, cx => cx.open_url('https://console.cloud.google.com/apis/credentials')))
        .child(text('2. Paste the downloaded client JSON.', cx, 13))
        .child(component(InputGroup, 'oauth-client-json').w_full().h(160).input(component(InputGroupTextarea, this.credentials)
          .aria_label('Desktop OAuth client JSON').w_full().h_full().rows(6).placeholder('{ "installed": { "client_id": "…", "client_secret": "…" } }')))
        .child(h_flex().gap_3().child(this.button('remember-account', this.remember ? '✓ Remember this account' : 'Remember this account', cx, cx => { this.remember = !this.remember; cx.notify(); }))
          .child(div().flex_1()).child(component(Button, 'start-google-login').primary().size('small').label('Sign in with Google…')
            .disabled(this.connecting || this.authorizing).on_click((_event, cx) => this.startLogin(cx))))
        .when(this.pendingAuth, el => el.child(v_flex().gap_3().p_4().rounded(cx.theme().radius.lg).bg(cx.theme().colors.muted)
          .child(text(this.connecting ? 'Connecting your mailbox…' : 'Complete sign-in in your browser.', cx, 13).font_medium())
          .child(text('Folio receives Google’s callback automatically. Return here after granting access.', cx, 12, true).line_height('20px'))
          .child(this.button('cancel-google-login', 'Cancel sign-in', cx, cx => this.cancelLogin(cx), this.connecting))))
        .child(text('Remembered refresh tokens are stored in this app’s local data file. Access tokens stay in memory. No mail or tokens are sent to a Folio server.', cx, 11, true).line_height('18px'))
        .when(this.client.session, el => el.child(this.button('cancel-setup', 'Back to mail', cx, cx => this.close(cx), this.connecting)))
        .when(this.error, el => el.child(text(this.error, cx, 13))));
  }

  iconButton(id, glyph, help, cx, action, active = false, disabled = false) {
    return component(Button, id).ghost().tooltip(help).size('small').w(28).h(28).px(0)
      .rounded(cx.theme().radius.md).disabled(disabled)
      .when(active, el => el.border_1().border_color(cx.theme().colors.border).bg(cx.theme().colors.selection))
      .child(icon(glyph, 15)).on_click((_event, cx) => action(cx));
  }

  rail(cx) {
    return v_flex().w(56).h_full().flex_shrink_0().items_center().pt_3().pb_3().gap_2()
      .bg(cx.theme().colors.secondary).border_r_1().border_color(cx.theme().colors.border)
      .child(image('forma/assets/forma.svg').size(28).mb_4())
      .children([['INBOX','review','Inbox'], ['SENT','send','Sent letters'], ['STARRED','book','Starred letters']].map(([folder,glyph,label]) =>
        this.iconButton(`gmail-folder-${folder || 'all'}`, glyph, label, cx, cx => this.changeFolder(folder,cx), this.folder === folder, this.sending || !this.client.session)))
      .child(div().w(16).h(1).my_3().bg(cx.theme().colors.border))
      .child(this.iconButton('gmail-compose', 'plus', 'Write a letter', cx, cx => this.compose(cx), !!this.draft, this.sending || !this.client.session))
      .child(div().flex_1())
      .child(this.iconButton('gmail-refresh','refresh','Refresh letters',cx,cx => cx.spawn(async cx => { await this.refresh(cx); }),false,this.loading || !this.client.session))
      .child(this.iconButton('gmail-account', 'filter', 'Gmail account settings', cx, cx => { this.setupOpen = true; cx.notify(); }, this.setupOpen, this.sending || this.mutating))
      .child(image('forma/assets/user.svg').size(24).rounded(8));
  }

  messageRow(message, cx) {
    return component(Button, `gmail-${message.id}`).ghost().w_full().h(76).px_3().rounded(cx.theme().radius.lg)
      .when(message.id === this.selectedId, el => el.bg(cx.theme().colors.selection))
      .child(h_flex().w_full().gap_3()
        .child(photo(message.from, 34))
        .child(v_flex().flex_1().min_w_0().items_start().gap_1()
          .child(h_flex().w_full().gap_2()
            .child(text(message.sender, cx, 14).flex_1().min_w_0().truncate().when(message.unread, el => el.font_medium()))
            .child(text(`${message.unread ? '● ' : ''}${dateLabel(message.date)}`, cx, 10, true)))
          .child(text(message.subject, cx, 11, true).w_full().truncate())
          .child(h_flex().gap_1().child(icon(message.starred ? 'sparkmark' : 'message', 11))
            .child(text(domain(message.from), cx, 11, true).truncate()))))
      .on_click((_event, cx) => this.select(message, cx));
  }

  sidebar(cx) {
    const rows = this.reverse ? [...this.messages].reverse() : this.messages;
    const sections = [['Unread letters', rows.filter(m => m.unread)], ['Other letters', rows.filter(m => !m.unread)]];
    return v_flex().size_full().min_w_0().bg(cx.theme().colors.surface)
      .child(h_flex().h(56).px_4().gap_2().flex_shrink_0()
        .child(icon('review',14)).child(text('Correspondence',cx,14).font_semibold()).child(div().flex_1())
        .child(this.iconButton('gmail-filter','filter','Unread letters',cx,cx => this.changeFolder(this.folder === 'UNREAD' ? 'INBOX' : 'UNREAD',cx),this.folder === 'UNREAD',!this.client.session))
        .child(this.iconButton('gmail-sort','sort','Reverse letter order',cx,cx => { this.reverse = !this.reverse; cx.notify(); },this.reverse)))
      .child(div().w_full().min_w_0().px_4().mb_3().child(this.input('gmail-search',this.search,cx,'Search Gmail',(value,cx) => {
        this.query = value; ++this.listRevision; this.loading = false; const revision = ++this.searchRevision;
        cx.timer.after(350,cx => { if (revision === this.searchRevision) cx.spawn(async cx => { await this.refresh(cx); }); });
      })))
      .child(h_flex().px_4().pb_3().gap_1()
        .children([['','All'],['INBOX','Inbox'],['SENT','Sent']].map(([folder,label]) => component(Button,`gmail-tab-${folder || 'all'}`).ghost().size('xsmall').label(label)
          .disabled(!this.client.session).when(this.folder === folder,el => el.bg(cx.theme().colors.selection).font_medium()).on_click((_event,cx) => this.changeFolder(folder,cx))))
        .child(div().flex_1()).child(text(String(this.messages.length),cx,11,true)))
      .child(v_flex().id('gmail-message-list').flex_1().min_h_0().overflow_y_scroll().px_2().pt_2()
        .children(sections.filter(([,messages]) => messages.length).map(([title,messages],ix) => v_flex().gap_1().when(ix > 0,el => el.mt_5())
          .child(h_flex().px_3().mb_2().child(text(title,cx,11,true)).child(div().flex_1()).child(text(String(messages.length),cx,10,true)))
          .children(messages.map(message => this.messageRow(message,cx)))))
        .when(!this.messages.length,el => el.child(v_flex().p_4().gap_2()
          .child(text(this.loading ? 'Loading letters…' : 'No letters here',cx,14).font_medium())
          .child(text(this.client.session ? 'Try another search or choose All.' : 'Connect Gmail to bring your letters here.',cx,12,true))))
        .when(this.nextPageToken,el => el.child(this.button('more-mail','Load more',cx,cx => cx.spawn(async cx => { await this.refresh(cx,true); }),this.loading))))
      .child(h_flex().h(42).px_4().gap_2().flex_shrink_0().border_t_1().border_color(cx.theme().colors.border)
        .child(div().size(5).rounded_full().bg(cx.theme().colors.muted_foreground))
        .child(text(this.client.session?.email || 'Personal workspace',cx,11,true).flex_1().min_w_0().truncate())
        .child(text(`${this.messages.length} letters`,cx,10,true)));
  }

  move(direction, cx) {
    const ix = this.messages.findIndex(message => message.id === this.selectedId);
    if (this.messages.length) this.select(this.messages[(ix + direction + this.messages.length) % this.messages.length],cx);
  }

  addressRow(label, address, sender, cx, first = false) {
    return h_flex().h(39).px_4().gap_3().border_b_1().border_color(cx.theme().colors.border)
      .when(first,el => el.rounded_t(cx.theme().radius.xl))
      .child(text(label,cx,12,true).w(56)).child(photo(sender,16))
      .child(text(address,cx,12).flex_1().min_w_0().truncate()).child(icon('message',14));
  }

  composer(cx) {
    return v_flex().w_full().bg(cx.theme().colors.surface).border_1().border_color(cx.theme().colors.border).rounded(cx.theme().radius.xl)
      .child(this.addressRow('From',this.client.session.email,this.client.session.email,cx,true))
      .child(h_flex().min_h(39).px_4().gap_3().border_b_1().border_color(cx.theme().colors.border)
        .child(text('To',cx,12,true).w(56)).child(photo(this.draft.to,16))
        .child(div().flex_1().min_w_0().child(this.input('compose-to',this.to,cx,'Recipient',(value,cx) => { this.draft.to = value; this.saveDraft(); cx.notify(); }).readonly(this.sending))))
      .child(v_flex().p_6()
        .child(h_flex().gap_3().mb_5()
          .child(div().flex_1().min_w_0().child(this.input('compose-subject',this.subject,cx,'Subject',(value,cx) => { this.draft.subject = value; this.saveDraft(); cx.notify(); }).readonly(this.sending)))
          .child(this.button('close-compose','Save & close',cx,cx => this.close(cx),this.sending)))
        .child(component(InputGroup,'compose-body').w_full().min_w_0().h(300).input(component(InputGroupTextarea,this.body)
          .aria_label('Message body').w_full().min_w_0().h_full().rows(12).readonly(this.sending)
          .on_change((value,cx) => { this.draft.body = value; this.saveDraft(); cx.notify(); })))
        .when(this.draft.uncertain,el => el.child(v_flex().gap_2().mt_4()
          .child(text('Check Gmail’s Sent folder before another attempt.',cx,12))
          .child(this.button('check-sent','Open Sent in Gmail…',cx,cx => cx.open_url(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(this.client.session.email)}#sent`)))
          .child(this.button('allow-send-again','Allow another send',cx,cx => { this.draft.uncertain = false; this.saveDraft(); cx.notify(); }))))
        .child(h_flex().mt_5().pt_4().gap_2().border_t_1().border_color(cx.theme().colors.border)
          .child(text(this.sending ? 'Sending to Gmail' : 'Saved locally',cx,10,true)).child(div().flex_1())
          .child(component(Button,'gmail-send-message').primary().size('small').label(this.sending ? 'Sending' : 'Send email').loading(this.sending)
            .disabled(this.sending || this.draft.uncertain || !this.draft.body?.trim() || !this.draft.to?.trim()).on_click((_event,cx) => this.send(cx)))));
  }

  reader(cx) {
    if (!this.message && !this.draft) return v_flex().flex_1().h_full().items_center().justify_center().gap_3()
      .child(icon('review',28)).child(text(this.reading ? 'Opening your letter…' : 'A little room to breathe.',cx,20).font_medium())
      .child(text('Select a letter or write something new.',cx,13,true))
      .child(component(Button,'empty-compose').outline().size('small').label('Write a letter').disabled(!this.client.session)
        .on_click((_event,cx) => this.compose(cx)));
    const message = this.message;
    const position = this.messages.findIndex(m => m.id === this.selectedId) + 1;
    return v_flex().flex_1().min_w_0().h_full()
      .child(h_flex().h(56).px_6().gap_3().flex_shrink_0().border_b_1().border_color(cx.theme().colors.border)
        .child(photo(message?.from || this.client.session?.email || '',22))
        .child(text(this.draft ? 'Your letter' : message.sender,cx,13).font_medium().min_w_0().truncate())
        .child(text(' / ',cx,12,true)).child(text(domain(message?.from || this.client.session?.email || ''),cx,12,true).min_w_0().truncate())
        .child(div().flex_1())
        .when(!this.draft,el => el.child(text(`${position} of ${this.messages.length}`,cx,11,true))
          .child(this.iconButton('gmail-previous','up','Previous letter · Alt ↑',cx,cx => this.move(-1,cx)))
          .child(this.iconButton('gmail-next','down','Next letter · Alt ↓',cx,cx => this.move(1,cx)))
          .child(component(Button,'gmail-archive').outline().size('small').label('Archive')
            .disabled(this.mutating || !message.labels.includes('INBOX')).on_click((_event,cx) => this.mutate('archive',cx)))))
      .child(v_flex().id('gmail-reader-scroll').flex_1().min_h_0().overflow_y_scroll().items_center().px_6().py_6()
        .child(v_flex().w_full().max_w(680).gap_5()
          .child(h_flex().gap_2().child(text('YOUR NEXT LETTER',cx,10,true).font_medium())
            .child(div().flex_1()).child(text(this.draft ? 'Saved locally' : dateLabel(message.date),cx,11,true)))
          .when(!this.draft,el => el.child(v_flex().bg(cx.theme().colors.muted).border_1().border_color(cx.theme().colors.border).rounded(cx.theme().radius.xl).p_4().gap_3()
            .child(h_flex().gap_2().child(icon('pointer',15)).child(text('Letter context',cx,13).font_semibold()))
            .child(text(message.snippet || message.subject,cx,13).line_height('21px'))))
          .when(this.draft,el => el.child(this.composer(cx)))
          .when(!this.draft,el => el.child(v_flex().w_full().bg(cx.theme().colors.surface).border_1().border_color(cx.theme().colors.border).rounded(cx.theme().radius.xl)
            .child(this.addressRow('From',message.from,message.from,cx,true))
            .child(this.addressRow('To',message.to,this.client.session.email,cx))
            .child(v_flex().p_6()
              .child(text(message.subject,cx,16).font_semibold().mb_5())
              .child(text(message.body || 'This letter has no readable text body.',cx,14).line_height('23px'))
              .when(message.attachments.length,el => el.child(v_flex().gap_3().mt_4().children(message.attachments.map(attachment =>
                h_flex().gap_2().child(icon('attach',14)).child(text(attachment.name,cx,12).flex_1().min_w_0().truncate())
                  .child(text(`· ${Math.ceil(attachment.size / 1024)} KB`,cx,11,true))))))
              .child(h_flex().mt_5().pt_4().gap_2().border_t_1().border_color(cx.theme().colors.border)
                .child(this.iconButton('gmail-star','sparkmark',message.starred ? 'Unstar letter' : 'Star letter',cx,cx => this.mutate('star',cx),message.starred,this.mutating))
                .child(this.iconButton('gmail-unread','message','Mark unread',cx,cx => this.mutate('unread',cx),false,this.mutating))
                .child(this.button('gmail-trash','Trash',cx,cx => this.mutate('trash',cx),this.mutating || message.labels.includes('TRASH')))
                .child(div().flex_1())
                .child(this.button('open-gmail-message','Open in Gmail…',cx,cx => cx.open_url(`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(this.client.session.email)}#all/${message.id}`)))
                .child(component(Button,'gmail-reply').primary().size('small').label('Reply').disabled(this.mutating)
                  .on_click((_event,cx) => this.compose(cx,message)))))))
          .child(h_flex().justify_between().child(text('A quieter place for your correspondence.',cx,11,true))
            .child(text('FOLIO DESK',cx,10,true).font_medium()))));
  }

  render(cx) {
    return v_flex().size_full().track_focus(this.focus).key_context('GmailMail')
      .on_action('gmail-previous',(_event,cx) => this.move(-1,cx)).on_action('gmail-next',(_event,cx) => this.move(1,cx))
      .on_action('gmail-send', (_event, cx) => this.send(cx)).on_action('gmail-close', (_event, cx) => this.close(cx))
      .child(h_flex().flex_1().min_h_0().items_stretch()
        .child(this.rail(cx))
        .child(h_resizable('gmail-workspace').flex_1().min_w_0().h_full()
          .child(resizable_panel().size(320).size_range(280,440).child(this.sidebar(cx)))
          .child(resizable_panel().size_range(520).child(this.setupOpen ? v_flex().size_full()
            .child(h_flex().h(56).px_6().gap_3().flex_shrink_0().border_b_1().border_color(cx.theme().colors.border)
              .child(text('Gmail account',cx,13).font_medium()).child(div().flex_1())
              .when(this.client.session,el => el.child(this.button('account-back','Back to letters',cx,cx => this.close(cx),this.connecting)))
              .when(this.client.session,el => el.child(this.button('disconnect-gmail','Disconnect',cx,cx => this.disconnect(cx),this.connecting || this.sending))))
            .child(this.setup(cx)) : this.reader(cx)))))
      .child(h_flex().h(32).px_4().gap_3().flex_shrink_0().bg(cx.theme().colors.surface).border_t_1().border_color(cx.theme().colors.border)
        .child(text(this.error || this.status || 'Gmail connected', cx, 11,true).flex_1().min_w_0().truncate())
        .when(this.undoAction && !this.setupOpen, el => el.child(this.button('undo-mail-action', 'Undo', cx, cx => this.undo(cx), this.mutating)))
        .child(component(Button,'sample-workspace').ghost().size('xsmall').label('Sample workspace').disabled(this.authorizing || this.connecting || this.sending)
          .on_click((_event,cx) => cx.dispatch_action('folio-preview')))
        .child(text('Ctrl / ⌘ ↵ Send', cx, 10, true)));
  }
}
