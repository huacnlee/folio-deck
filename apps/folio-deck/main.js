import { View, div, image, svg } from 'gpui-kit';
import { h_flex, v_flex, h_resizable, resizable_panel, set_theme } from 'gpui-base';
import { Button, TitleBar, InputState, TextareaState, InputGroup, InputGroupInput, InputGroupTextarea } from 'gpui-component';
import { studioColors } from './theme.js';
import GmailView from './gmail-view.js';
import { contacts, notes, groups, draftText, Mailbox } from './mailbox.js';

const asset = name => `forma/assets/${name}.svg`;
const icon = (name, size = 16) => svg(asset(name)).size(size).flex_shrink_0();
const photo = (name, size) => image(asset(name)).size(size).rounded(8).flex_shrink_0();
const brand = (name, size = 13) => image(asset(name)).size(size).flex_shrink_0();
const text = (value, cx, size = 13, muted = false) => div().text_size(size)
  .text_color(muted ? cx.theme().colors.muted_foreground : cx.theme().colors.foreground).child(value);
const storageKey = 'folio-mail-v1';
// Styled component constructors in 0.7.3 are callable constructors; newer hosts
// expose the associated .new API advertised by their declarations.
const component = (Type, ...args) => typeof Type.new === 'function' ? Type.new(...args) : new Type(...args);

export default class StudioDemo extends View {
  init(_props, cx) {
    let snapshot;
    try { snapshot = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { snapshot = {}; }
    this.mailbox = new Mailbox(snapshot);
    this.search = InputState('Search letters…');
    this.editors = Object.fromEntries(contacts.map(c => [c.id, TextareaState(this.mailbox.draft(c.id))]));
    this.editingId = null;
    this.previewId = null;
    this.assistantId = null;
    this.generatingId = null;
    this.tone = 'Warm';
    this.online = true;
    this.undoId = null;
    this.notice = '';
    this.noticeRevision = 0;
    this.generation = 0;
    this.rootFocus = cx.focus_handle();
    cx.bind_keys([
      { keystroke: 'alt-up', action: 'folio-previous', context: 'FolioMail' },
      { keystroke: 'alt-down', action: 'folio-next', context: 'FolioMail' },
      { keystroke: 'ctrl-enter', action: 'folio-send', context: 'FolioMail' },
      { keystroke: 'cmd-enter', action: 'folio-send', context: 'FolioMail' },
      { keystroke: 'escape', action: 'folio-close', context: 'FolioMail' },
    ]);
    set_theme({ appearance: 'light', tokens: {
      colors: studioColors,
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
      radius: { none: 0, sm: 4, md: 6, lg: 8, xl: 12, full: 9999 },
      typography: { sans: 'Helvetica Neue', md: { size: 13 }, sm: { size: 12 } },
    } });
    this.mode = localStorage.getItem('folio-gmail-session-v1') ? 'gmail' : 'demo';
    this.gmailView = cx.new(GmailView);
  }

  persist() { localStorage.setItem(storageKey, JSON.stringify(this.mailbox.snapshot())); }

  feedback(message, cx) {
    this.notice = message;
    const revision = ++this.noticeRevision;
    cx.notify();
    cx.timer.after(4500, cx => {
      if (revision === this.noticeRevision) { this.notice = ''; cx.notify(); }
    });
  }

  select(id, cx) {
    this.mailbox.selectedId = id;
    this.editingId = null;
    this.previewId = null;
    this.assistantId = null;
    cx.notify();
  }

  folder(folder, cx) {
    this.mailbox.folder = folder;
    this.mailbox.reconcile();
    this.select(this.mailbox.selectedId, cx);
  }

  move(direction, cx) {
    const rows = this.mailbox.rows();
    const ix = rows.findIndex(c => c.id === this.mailbox.selectedId);
    if (rows.length) this.select(rows[(ix + direction + rows.length) % rows.length].id, cx);
  }

  reset(cx) {
    ++this.generation;
    this.mailbox = new Mailbox();
    contacts.forEach(c => this.editors[c.id].set_value(draftText(c.id)));
    this.search.set_value('');
    this.online = true;
    this.undoId = null;
    this.generatingId = null;
    this.persist();
    this.select(this.mailbox.selectedId, cx);
    this.feedback('Sample letters restored', cx);
  }

  dismiss(id, cx) {
    if (!this.mailbox.dismiss(id)) return;
    this.undoId = id;
    this.persist();
    this.select(this.mailbox.selectedId, cx);
  }

  undo(cx) {
    const id = this.undoId;
    if (!id) return;
    this.mailbox.dismissed.delete(id);
    this.mailbox.folder = 'all';
    this.mailbox.query = '';
    this.search.set_value('');
    this.undoId = null;
    this.persist();
    this.select(id, cx);
  }

  send(id, cx) {
    if (this.generatingId === id || !this.mailbox.beginSend(id)) return;
    this.editingId = null;
    const mailbox = this.mailbox;
    cx.notify();
    cx.spawn(async cx => {
      await cx.sleep(1100);
      if (mailbox !== this.mailbox) return;
      mailbox.finishSend(id, this.online);
      this.persist();
      this.feedback(this.online ? `Demo email sent to ${contacts.find(c => c.id === id).name}` : 'Offline — reconnect and retry your draft', cx);
    });
  }

  rewrite(id, cx) {
    if (this.generatingId || this.mailbox.sent.has(id) || this.mailbox.pending.has(id)) return;
    const revision = ++this.generation;
    const tone = this.tone;
    const before = this.mailbox.draft(id);
    this.generatingId = id;
    cx.notify();
    cx.spawn(async cx => {
      await cx.sleep(900);
      if (revision !== this.generation) return;
      this.generatingId = null;
      if (this.mailbox.draft(id) !== before || this.mailbox.dismissed.has(id)) { cx.notify(); return; }
      const firstName = contacts.find(c => c.id === id).name.split(' ')[0];
      const note = notes[id];
      const value = tone === 'Concise'
        ? `Hi ${firstName},\n\n${note.body.split('. ')[0]}.\n\n${note.ask}\n\nBest,\nRobin`
        : tone === 'Formal'
          ? `Dear ${firstName},\n\n${note.body}\n\n${note.ask}\n\nKind regards,\nRobin`
          : draftText(id);
      this.mailbox.drafts[id] = value;
      this.editors[id].set_value(value);
      this.persist();
      this.feedback(`${tone} draft applied · local writing demo`, cx);
    });
  }

  iconButton(id, glyph, help, cx, action, active = false) {
    return component(Button, id).ghost().tooltip(help).size('small').w(28).h(28).px(0)
      .rounded(cx.theme().radius.md)
      .when(active, el => el.border_1().border_color(cx.theme().colors.border).bg(cx.theme().colors.selection))
      .child(icon(glyph, 15)).on_click((_event, cx) => action(cx));
  }

  rail(cx) {
    const nav = [['review', 'All letters', 'all'], ['send', 'Sent letters', 'Sent'], ['book', 'Saved for later', 'Saved for later']];
    return v_flex().w(56).h_full().flex_shrink_0().items_center().pt_3().pb_3().gap_2()
      .bg(cx.theme().colors.secondary).border_r_1().border_color(cx.theme().colors.border)
      .child(image(asset('forma')).size(28).mb_4())
      .children(nav.map(([glyph, label, folder]) => this.iconButton(`nav-${glyph}`, glyph, label, cx,
        cx => this.folder(folder, cx), this.mailbox.folder === folder)))
      .child(div().w(16).h(1).my_3().bg(cx.theme().colors.border))
      .child(this.iconButton('assistant-nav', 'ai', 'Writing assistant', cx, cx => {
        this.assistantId = this.assistantId ? null : this.mailbox.selectedId; cx.notify();
      }, !!this.assistantId))
      .child(div().flex_1())
      .child(this.iconButton('restore-nav', 'refresh', 'Restore sample letters', cx, cx => this.reset(cx)))
      .child(photo('user', 24));
  }

  contactRow(contact, cx) {
    const selected = contact.id === this.mailbox.selectedId;
    const sent = this.mailbox.sent.has(contact.id);
    const pending = this.mailbox.pending.has(contact.id);
    return component(Button, `contact-${contact.id}`).ghost().w_full().h(76).px_3().rounded(cx.theme().radius.lg)
      .when(selected, el => el.bg(cx.theme().colors.selection))
      .child(h_flex().w_full().gap_3()
        .child(photo(contact.avatar, 34))
        .child(v_flex().flex_1().min_w_0().items_start().gap_1()
          .child(h_flex().w_full().gap_2().child(text(contact.name, cx, 14).font_medium()).child(div().flex_1())
            .child(text(pending ? 'Sending' : sent ? 'Sent ✓' : contact.level === 'high' ? 'Draft' : 'Oct 12', cx, 10, true)))
          .child(text(notes[contact.id].subject, cx, 11, true).w_full().truncate())
          .child(h_flex().gap_1().child(brand(contact.brand, 11)).child(text(contact.company, cx, 11, true)))))
      .on_click((_event, cx) => this.select(contact.id, cx));
  }

  sidebar(cx) {
    const rows = this.mailbox.rows();
    return v_flex().w_full().h_full().min_w_0().bg(cx.theme().colors.surface)
      .child(h_flex().h(56).px_4().gap_2().flex_shrink_0()
        .child(icon('review', 14)).child(text('Correspondence', cx, 14).font_semibold())
        .child(div().flex_1())
        .child(this.iconButton('filter', 'filter', 'Show ready drafts', cx,
          cx => this.folder(this.mailbox.folder === 'Ready to send' ? 'all' : 'Ready to send', cx), this.mailbox.folder === 'Ready to send'))
        .child(this.iconButton('sort', 'sort', 'Reverse letter order', cx, cx => { this.mailbox.reverse = !this.mailbox.reverse; cx.notify(); }, this.mailbox.reverse)))
      .child(div().w_full().min_w_0().px_4().mb_3()
        .child(component(InputGroup, 'search-group').w_full().min_w_0().h(32)
          .input(component(InputGroupInput, this.search).aria_label('Search letters').on_change((value, cx) => {
            this.mailbox.query = value; this.mailbox.reconcile(); cx.notify();
          }))))
      .child(h_flex().px_4().pb_3().gap_1()
        .children([['all', 'All'], ['Ready to send', 'Ready'], ['Sent', 'Sent']].map(([folder, label]) =>
          component(Button, `folder-${folder}`).ghost().size('xsmall').label(label)
            .when(this.mailbox.folder === folder, el => el.bg(cx.theme().colors.selection).font_medium())
            .on_click((_event, cx) => this.folder(folder, cx))))
        .child(div().flex_1()).child(text(String(rows.length), cx, 11, true)))
      .child(v_flex().id('contacts-scroll').flex_1().min_h_0().overflow_y_scroll().px_2().pt_2()
        .children(groups.filter(group => rows.some(c => this.mailbox.group(c) === group)).map((group, ix) => {
          const groupRows = rows.filter(c => this.mailbox.group(c) === group);
          return v_flex().when(ix > 0, el => el.mt_5()).gap_1()
            .child(h_flex().px_3().mb_2().child(text(group, cx, 11, true)).child(div().flex_1()).child(text(String(groupRows.length), cx, 10, true)))
            .children(groupRows.map(c => this.contactRow(c, cx)));
        }))
        .when(!rows.length, el => el.child(v_flex().p_4().gap_2()
          .child(text('No letters here', cx, 14).font_medium())
          .child(text('Try another search or choose All.', cx, 12, true)))))
      .child(h_flex().h(42).px_4().gap_2().border_t_1().border_color(cx.theme().colors.border)
        .child(div().size(5).rounded_full().bg(cx.theme().colors.muted_foreground))
        .child(text('Personal workspace', cx, 11, true)).child(div().flex_1()).child(text('8 samples', cx, 10, true)));
  }

  addressRow(label, address, avatar, company, cx, first = false) {
    return h_flex().h(39).px_4().gap_3().border_b_1().border_color(cx.theme().colors.border)
      .when(first, el => el.rounded_t(cx.theme().radius.xl))
      .child(text(label, cx, 12, true).w(56))
      .child(photo(avatar, 16)).child(text(address, cx, 12).truncate())
      .child(div().flex_1()).child(brand(company, 14));
  }

  assistant(contact, cx) {
    const busy = this.generatingId === contact.id;
    return v_flex().gap_3().p_4().bg(cx.theme().colors.muted).rounded(cx.theme().radius.lg)
      .child(h_flex().gap_2().child(icon('sparkmark', 14)).child(text('Make it sound like you', cx, 13).font_medium())
        .child(div().flex_1()).child(component(Button, 'close-assistant').ghost().size('xsmall').label('Close')
          .on_click((_event, cx) => { this.assistantId = null; cx.notify(); })))
      .child(text('Choose a tone for the sample draft. Your edits are saved locally.', cx, 12, true))
      .child(h_flex().gap_2().children(['Warm', 'Concise', 'Formal'].map(tone => component(Button, `tone-${tone}`)
        .outline().size('small').label(tone).disabled(!!this.generatingId)
        .when(tone === this.tone, el => el.bg(cx.theme().colors.selection).border_color(cx.theme().colors.ring))
        .on_click((_event, cx) => { this.tone = tone; cx.notify(); })))
        .child(div().flex_1()).child(component(Button, 'rewrite').outline().size('small').loading(busy)
          .disabled(!!this.generatingId || this.mailbox.sent.has(contact.id) || this.mailbox.pending.has(contact.id))
          .label(busy ? 'Rewriting' : 'Apply tone').on_click((_event, cx) => this.rewrite(contact.id, cx))));
  }

  attachment(contact, cx) {
    const preview = this.previewId === contact.id;
    return v_flex().gap_3().mt_4()
      .child(component(Button, 'attachment-preview').outline().size('small').w_full()
        .child(h_flex().w_full().gap_2().child(icon('attach', 14)).child(text('Project outline.pdf', cx, 12))
          .child(text('· 248 KB', cx, 11, true)).child(div().flex_1()).child(text(preview ? 'Hide preview' : 'Preview', cx, 11, true)))
        .on_click((_event, cx) => { this.previewId = preview ? null : contact.id; cx.notify(); }))
      .when(preview, el => el.child(v_flex().p_4().gap_3().rounded(cx.theme().radius.md).bg(cx.theme().colors.muted)
        .child(text(contact.company, cx, 11, true)).child(text('Project outline', cx, 16).font_medium())
        .child(text(notes[contact.id].summary, cx, 12).line_height('20px'))
        .child(text('01   Direction & references\n02   Materials & first proof\n03   Review & next steps', cx, 12).line_height('24px'))
        .child(text('Sample preview · no file is downloaded', cx, 10, true))));
  }

  email(contact, cx) {
    const id = contact.id;
    const sent = this.mailbox.sent.has(id);
    const pending = this.mailbox.pending.has(id);
    const failed = this.mailbox.failed.has(id);
    const editing = this.editingId === id;
    return v_flex().w_full().bg(cx.theme().colors.surface).border_1().border_color(cx.theme().colors.border).rounded(cx.theme().radius.xl)
      .child(this.addressRow('From', 'robin@folio.example', 'user', 'forma', cx, true))
      .child(this.addressRow('To', contact.email, contact.avatar, contact.brand, cx))
      .child(v_flex().p_6()
        .child(h_flex().gap_3().mb_5().child(text(notes[id].subject, cx, 16).font_semibold().flex_1())
          .child(component(Button, 'edit-draft').ghost().size('xsmall').disabled(sent || pending || this.generatingId === id)
            .label(editing ? 'Done' : 'Edit').on_click((_event, cx) => { this.editingId = editing ? null : id; cx.notify(); })))
        .when(editing, el => el.child(component(InputGroup, `draft-editor-${id}`).h(300)
          .input(component(InputGroupTextarea, this.editors[id]).aria_label('Email draft').w_full().min_w_0().h_full().rows(12)
            .on_change((value, cx) => { this.mailbox.drafts[id] = value; this.persist(); cx.notify(); }))))
        .when(!editing, el => el.child(text(this.mailbox.draft(id), cx, 14).line_height('23px')))
        .when(this.mailbox.attached.has(id), el => el.child(this.attachment(contact, cx)))
        .when(failed, el => el.child(h_flex().mt_4().gap_2().child(icon('message', 14))
          .child(text('Couldn’t send while offline. Reconnect, then retry.', cx, 12))))
        .child(h_flex().mt_5().pt_4().gap_2().border_t_1().border_color(cx.theme().colors.border)
          .child(component(Button, 'attach').ghost().tooltip('Toggle sample attachment')
            .size('small').disabled(sent || pending).child(icon('attach', 14))
            .when(this.mailbox.attached.has(id), el => el.bg(cx.theme().colors.selection))
            .on_click((_event, cx) => {
              this.mailbox.attached.has(id) ? this.mailbox.attached.delete(id) : this.mailbox.attached.add(id);
              this.previewId = null; this.persist(); cx.notify();
            }))
          .child(text(sent ? 'Sent locally' : editing ? 'Edits saved' : 'Saved locally', cx, 10, true))
          .child(div().flex_1())
          .child(component(Button, 'assistant').ghost().size('small').tooltip('Change draft tone')
            .child(icon('sparkmark', 14)).on_click((_event, cx) => { this.assistantId = this.assistantId === id ? null : id; cx.notify(); }))
          .child(component(Button, 'send-email').primary().size('small').loading(pending)
            .disabled(sent || pending || this.generatingId === id || !this.mailbox.draft(id).trim())
            .label(pending ? 'Sending' : sent ? 'Sent ✓' : failed ? 'Retry send' : 'Send email')
            .on_click((_event, cx) => this.send(id, cx)))));
  }

  detail(cx) {
    const contact = this.mailbox.rows().find(c => c.id === this.mailbox.selectedId);
    if (!contact) return v_flex().flex_1().h_full().items_center().justify_center().gap_3()
      .child(icon('review', 28)).child(text('A little room to breathe.', cx, 20).font_medium())
      .child(text(this.mailbox.query ? 'No letters match your search.' : 'There are no letters in this view.', cx, 13, true))
      .child(component(Button, 'show-all').outline().label('Show all letters').on_click((_event, cx) => {
        this.mailbox.query = ''; this.search.set_value(''); this.folder('all', cx);
      }))
      .when(this.mailbox.dismissed.size > 0, el => el.child(component(Button, 'restore-empty').ghost().label('Restore samples').on_click((_event, cx) => this.reset(cx))));
    const position = this.mailbox.rows().findIndex(c => c.id === contact.id) + 1;
    return v_flex().flex_1().min_w_0().h_full()
      .child(h_flex().h(56).px_6().gap_3().flex_shrink_0().border_b_1().border_color(cx.theme().colors.border)
        .child(photo(contact.avatar, 22)).child(text(contact.name, cx, 13).font_medium())
        .child(text(' / ', cx, 12, true)).child(text(contact.company, cx, 12, true).truncate())
        .child(div().flex_1()).child(text(`${position} of ${this.mailbox.rows().length}`, cx, 11, true))
        .child(this.iconButton('previous', 'up', 'Previous letter · Alt ↑', cx, cx => this.move(-1, cx)))
        .child(this.iconButton('next', 'down', 'Next letter · Alt ↓', cx, cx => this.move(1, cx)))
        .child(component(Button, 'dismiss').outline().size('small').label('Dismiss').disabled(this.mailbox.pending.has(contact.id))
          .on_click((_event, cx) => this.dismiss(contact.id, cx))))
      .child(v_flex().id('detail-scroll').flex_1().min_h_0().overflow_y_scroll().items_center().px_6().py_6()
        .child(v_flex().w_full().max_w(680).gap_5()
          .child(h_flex().gap_2().child(text('YOUR NEXT LETTER', cx, 10, true).font_medium())
            .child(div().flex_1()).child(text(this.mailbox.group(contact), cx, 11, true)))
          .child(v_flex().bg(cx.theme().colors.muted).border_1().border_color(cx.theme().colors.border).rounded(cx.theme().radius.xl).p_4().gap_3()
            .child(h_flex().gap_2().child(icon('pointer', 15)).child(text('Draft context', cx, 13).font_semibold()))
            .child(text(notes[contact.id].summary, cx, 13).line_height('21px')))
          .when(this.assistantId === contact.id, el => el.child(this.assistant(contact, cx)))
          .child(this.email(contact, cx))
          .child(h_flex().justify_between().child(text('A quieter place for your correspondence.', cx, 11, true))
            .child(text('FOLIO DESK', cx, 10, true).font_medium()))));
  }

  render(cx) {
    if (this.mode === 'gmail') return v_flex().size_full().font_family('Helvetica Neue').text_size(13)
      .text_color(cx.theme().colors.foreground).bg(cx.theme().colors.background)
      .on_action('folio-preview', (_event, cx) => { this.mode = 'demo'; cx.notify(); })
      .child(component(TitleBar).h(30).bg(cx.theme().colors.secondary)
        .child(text('FOLIO  /  CORRESPONDENCE', cx, 10, true).font_medium()))
      .child(div().flex_1().min_h_0().child(this.gmailView));
    return v_flex().size_full().track_focus(this.rootFocus).font_family('Helvetica Neue').text_size(13)
      .text_color(cx.theme().colors.foreground).bg(cx.theme().colors.background)
      .key_context('FolioMail')
      .on_action('folio-previous', (_event, cx) => this.move(-1, cx))
      .on_action('folio-next', (_event, cx) => this.move(1, cx))
      .on_action('folio-send', (_event, cx) => this.send(this.mailbox.selectedId, cx))
      .on_action('folio-close', (_event, cx) => {
        if (this.assistantId || this.previewId || this.editingId) {
          this.assistantId = null; this.previewId = null; this.editingId = null;
          this.rootFocus.focus(); cx.notify();
        }
      })
      .child(component(TitleBar).h(30).bg(cx.theme().colors.secondary)
        .child(text('FOLIO  /  CORRESPONDENCE', cx, 10, true).font_medium()))
      .child(h_flex().flex_1().min_h_0().items_stretch()
        .child(this.rail(cx))
        .child(h_resizable('studio-workspace').flex_1().min_w_0().h_full()
          .child(resizable_panel().size(320).size_range(280, 440).child(this.sidebar(cx)))
          .child(resizable_panel().size_range(520).child(this.detail(cx)))))
      .child(h_flex().h(32).px_4().gap_3().flex_shrink_0().border_t_1().border_color(cx.theme().colors.border).bg(cx.theme().colors.surface)
        .child(component(Button, 'connection').ghost().size('xsmall').label(this.online ? '○ Online' : '○ Offline')
          .tooltip('Simulate an offline connection').on_click((_event, cx) => { this.online = !this.online; cx.notify(); }))
        .child(text(this.notice || 'Demo workspace · no email is delivered', cx, 11, true).truncate())
        .child(div().flex_1())
        .when(this.undoId, el => el.child(component(Button, 'undo-dismiss').ghost().size('xsmall').label('Undo dismiss').on_click((_event, cx) => this.undo(cx))))
        .child(component(Button, 'open-gmail').ghost().size('xsmall').label('Connect Gmail…').on_click((_event, cx) => { this.mode = 'gmail'; cx.notify(); }))
        .child(text('Alt ↑ ↓   Navigate     Ctrl / ⌘ ↵   Send', cx, 10, true)));
  }
}
