import { View, div, image, svg } from 'gpui-kit';
import { h_flex, v_flex, h_resizable, resizable_panel, set_theme } from 'gpui-base';
import { Button, TitleBar } from 'gpui-component';
import { studioColors, signalColors } from './theme.js';

/** @typedef {{ id: string, name: string, company: string, avatar: string, brand: string, group: string, level: string, email: string }} Contact */
/** @type {Contact[]} */
const contacts = [
  { id: 'maya', name: 'Clara Ellis', company: 'Paper & Pine', avatar: 'maya', brand: 'northstar', group: 'Ready to send', level: 'high', email: 'clara@paperpine.example' },
  { id: 'noah', name: 'Owen Reed', company: 'Still House', avatar: 'noah', brand: 'common', group: 'Ready to send', level: 'high', email: 'owen@stillhouse.example' },
  { id: 'leo-field', name: 'Jules Morgan', company: 'Margin Press', avatar: 'leo', brand: 'field', group: 'Ready to send', level: 'high', email: 'jules@margin.example' },
  { id: 'iris-morrow', name: 'Nina Bell', company: 'Soft Assembly', avatar: 'iris', brand: 'morrow', group: 'Waiting for a reply', level: 'medium', email: 'nina@softassembly.example' },
  { id: 'leo-sunday', name: 'Elliot Gray', company: 'Daybreak Co.', avatar: 'leo2', brand: 'sunday', group: 'Waiting for a reply', level: 'medium', email: 'elliot@daybreak.example' },
  { id: 'iris-arc', name: 'Ada Quinn', company: 'Small Hours', avatar: 'iris2', brand: 'arc', group: 'Saved for later', level: 'medium', email: 'ada@smallhours.example' },
  { id: 'leo-kin', name: 'Miles Lane', company: 'Common Thread', avatar: 'leo2', brand: 'kin', group: 'Saved for later', level: 'low', email: 'miles@commonthread.example' },
  { id: 'leo-folio', name: 'Lena Woods', company: 'Quiet Objects', avatar: 'leo', brand: 'folio', group: 'Saved for later', level: 'low', email: 'lena@quietobjects.example' },
];
// Each correspondence has its own draft and context.
const notes = {
  "maya": {
    "subject": "A small edition, made with care",
    "summary": "The first sample pack is ready. Send Clara the paper options and arrange a short review before the print run.",
    "body": "The sample pack for Paper & Pine is ready. We’ve paired a soft cotton stock with a simple stitched binding, and left a little breathing room around the photographs. I’d love to hear which combination feels most like your collection.",
    "ask": "Could we review the samples on Tuesday morning? I’ll bring the two paper options and a first estimate for an edition of 150 copies."
  },
  "noah": {
    "subject": "A quieter welcome for Still House",
    "summary": "Owen is reviewing the welcome booklet. Follow up on the opening pages and confirm the next proof.",
    "body": "I’ve revised the welcome booklet for Still House. The opening pages now lead with the story of the space, followed by a short guide to the rooms and the people who make it feel like home.",
    "ask": "When you have a moment, could you share your thoughts on the opening spread? We can prepare a final proof once the photographs are in place."
  },
  "leo-field": {
    "subject": "Your spring catalogue, on paper",
    "summary": "The catalogue layout is ready for review. Ask Jules to confirm the product order before the proof goes to print.",
    "body": "The spring catalogue for Margin Press is taking shape. We’ve given each object a full page and kept the descriptions brief, so the materials and small details can do most of the talking.",
    "ask": "Could you confirm the product sequence by Friday? I’ll then prepare a printed proof with the cover and two interior paper options."
  },
  "iris-morrow": {
    "subject": "Notes for our workshop next week",
    "summary": "Nina’s workshop outline is ready. Confirm attendance and ask for any questions the team would like to explore.",
    "body": "I’ve put together a light outline for our session with Soft Assembly: a few reference books, a shared wall of ideas, and time to make something together. The aim is to leave with a clear direction and a handful of useful sketches.",
    "ask": "Would you send over the names of everyone joining us? If there’s a question the team is especially curious about, I’ll make room for it in the session."
  },
  "leo-sunday": {
    "subject": "A postcard for the first day of summer",
    "summary": "Share the postcard concept with Elliot and choose an illustration for the first batch.",
    "body": "For Daybreak Co., I’m imagining a small postcard that feels like a note from a friend: one illustration on the front, a few handwritten words on the back, and a warm uncoated stock.",
    "ask": "I’ve included two illustration directions in the outline. Which feels closer to the mood you had in mind for the summer collection?"
  },
  "iris-arc": {
    "subject": "An invitation to our next little gathering",
    "summary": "Invite Ada to a small editorial evening and offer to reserve a place for the Small Hours team.",
    "body": "We’re hosting a small evening of books, conversation, and works in progress next month. I thought of Small Hours immediately — your recent stories would be a lovely part of the conversation.",
    "ask": "Would you and a colleague like to join us on the 18th? I can set aside two places and send the details once the programme is settled."
  },
  "leo-kin": {
    "subject": "A material study for Common Thread",
    "summary": "The material study is complete. Ask Miles to select a fabric sample for the next prototype.",
    "body": "The first material study for Common Thread is complete. We’ve kept the palette natural and focused on three textures that work well together: linen, recycled board, and a soft woven label.",
    "ask": "Could you choose your preferred fabric from the sample sheet? Once we have that, we can make a complete prototype for the team to hold and review."
  },
  "leo-folio": {
    "subject": "Keeping a record of everyday objects",
    "summary": "Send Lena the archive proposal and discuss which objects should appear in the first chapter.",
    "body": "I’ve sketched a proposal for the Quiet Objects archive. Each entry pairs a photograph with a short note about the maker, the material, and the small moments that give an object its place in our lives.",
    "ask": "Which five pieces would you like to begin with? I’ll use those to build a first chapter that we can edit together."
  }
};
const asset = name => `forma/assets/${name}.svg`;
const icon = (name, size = 16) => svg(`forma/assets/${name}.svg`).size(size).flex_shrink_0();
const photo = (name, size) => image(asset(name)).size(size).rounded(8).flex_shrink_0();
const brand = (name, size = 13) => image(asset(name)).size(size).flex_shrink_0();
const text = (value, cx, size = 13, muted = false) => div().text_size(size).text_color(muted ? cx.theme().colors.muted_foreground : cx.theme().colors.foreground).child(value);

export default class StudioDemo extends View {
  init(_props, _cx) {
    this.selectedId = 'maya';
    this.sent = new Set();
    this.dismissed = new Set();
    this.attached = new Set();
    this.highOnly = false;
    this.reverse = false;
    set_theme({ appearance: 'light', tokens: {
      colors: studioColors,
      spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
      radius: { none: 0, sm: 4, md: 6, lg: 8, xl: 12, full: 9999 },
      typography: { sans: 'Helvetica Neue', md: { size: 13 }, sm: { size: 12 } },
    } });
  }

  visibleContacts() {
    const rows = contacts.filter(c => !this.dismissed.has(c.id) && (!this.highOnly || c.level === 'high'));
    return this.reverse ? rows.reverse() : rows;
  }

  select(id, cx) { this.selectedId = id; cx.notify(); }

  move(direction, cx) {
    const rows = this.visibleContacts();
    const ix = rows.findIndex(c => c.id === this.selectedId);
    if (rows.length) this.select(rows[(ix + direction + rows.length) % rows.length].id, cx);
  }

  iconButton(id, glyph, help, cx, action, outline = false) {
    return new Button(id).ghost().tooltip(help).size('small').w(26).h(26).px(0)
      .rounded(cx.theme().radius.md)
      .when(outline, el => el.border_1().border_color(cx.theme().colors.border).bg(cx.theme().colors.surface))
      .child(icon(glyph, 15)).on_click((_event, cx) => action(cx));
  }

  signals(level) {
    return div().size(6).rounded(3).flex_shrink_0().bg(signalColors[level]);
  }

  rail(cx) {
    const nav = [['clock', 'Activity'], ['review', 'Correspondence'], ['book', 'Playbooks'], ['spark', 'Signals'], ['ai', 'Assistant'],
      [null], ['chart', 'Analytics'], ['people', 'Contacts'], [null], ['tasks', 'Tasks'], ['calendar', 'Calendar'], ['message', 'Messages'], [null], ['plus', 'Add']];
    return v_flex().w(56).h_full().flex_shrink_0().items_center().pt(12).pb(6).gap(2)
      .bg(cx.theme().colors.secondary)
      .child(image(asset('forma')).size(28).mb(16))
      .children(nav.map(([glyph, label], ix) => glyph
        ? new Button(`nav-${glyph}`).ghost().tooltip(label).w(28).h(28).px(0).rounded(6)
          .text_color(cx.theme().colors.muted_foreground)
          .when(glyph === 'review', el => el.bg(cx.theme().colors.surface).border_1().border_color(cx.theme().colors.border))
          .child(icon(glyph, 15))
        : div().w(16).h(1).my(11).bg(cx.theme().colors.border)))
      .child(div().flex_1()).child(photo('user', 19));
  }

  contactRow(contact, cx) {
    return new Button(`contact-${contact.id}`).ghost().w_full().h(64).px(12).rounded(8)
      .when(contact.id === this.selectedId, el => el.bg(cx.theme().colors.selection))
      .child(h_flex().w_full().gap(12)
        .child(photo(contact.avatar, 32))
        .child(v_flex().flex_1().items_start().gap(4)
          .child(text(contact.name, cx, 14))
          .child(h_flex().gap(6).child(brand(contact.brand)).child(text(contact.company, cx, 13, true))))
        .child(this.signals(contact.level)))
      .on_click((_event, cx) => this.select(contact.id, cx));
  }

  sidebar(cx) {
    const rows = this.visibleContacts();
    return v_flex().w_full().h_full().min_w_0().bg(cx.theme().colors.surface)
      .child(h_flex().h(56).px(20).gap(8).flex_shrink_0()
        .child(icon('review', 14)).child(text('Correspondence', cx, 14).font_semibold())
        .child(div().flex_1())
        .child(this.iconButton('filter', 'filter', this.highOnly ? 'Show all letters' : 'Show ready drafts', cx, cx => {
          this.highOnly = !this.highOnly;
          const rows = this.visibleContacts();
          if (!rows.some(c => c.id === this.selectedId)) this.selectedId = rows[0]?.id;
          cx.notify();
        }))
        .child(this.iconButton('sort', 'sort', 'Reverse order', cx, cx => { this.reverse = !this.reverse; cx.notify(); })))
      .child(h_flex().px(20).pb(12).gap(6).child(text(`${rows.length} letters`, cx, 11, true)).child(div().flex_1()).child(text(this.highOnly ? 'Ready only' : 'All letters', cx, 10, true)))
      .child(v_flex().id('contacts-scroll').flex_1().min_h_0().overflow_y_scroll().px(8).pt(12)
        .children(['Ready to send', 'Waiting for a reply', 'Saved for later'].filter(group => rows.some(c => c.group === group)).map((group, ix) => {
          const groupRows = rows.filter(c => c.group === group);
          return v_flex().when(ix > 0, el => el.mt(28)).gap(3)
            .child(text(group, cx, 12, true).px(10).mb(8))
            .children(groupRows.map(c => this.contactRow(c, cx)));
        })));
  }

  addressRow(label, address, avatar, company, cx) {
    return h_flex().h(39).px(16).gap(12).border_b_1().border_color(cx.theme().colors.border)
      .child(text(label, cx, 12, true).w(72))
      .child(photo(avatar, 16)).child(text(address, cx, 12))
      .child(div().flex_1()).child(brand(company, 14));
  }

  email(contact, cx) {
    const firstName = contact.name.split(' ')[0];
    const note = notes[contact.id];
    const sent = this.sent.has(contact.id);
    return v_flex().w_full().bg(cx.theme().colors.surface).border_1().border_color(cx.theme().colors.border).rounded(12)
      .child(this.addressRow('From', 'robin@folio.example', 'user', 'forma', cx))
      .child(this.addressRow('To', contact.email, contact.avatar, contact.brand, cx))
      .child(v_flex().px(28).pt(24).pb(24)
        .child(text(note.subject, cx, 16).font_semibold().mb(18))
        .child(h_flex().mb(20).child(text('Hello ', cx, 14))
          .child(div().text_size(14).text_color(cx.theme().colors.primary).font_medium().child(firstName)).child(text(',', cx, 14)))
        .child(text(note.body, cx, 14).line_height('22px').mb(18))
        .child(text(note.ask, cx, 14).line_height('22px').mb(18))
        .child(text('Warmly,', cx, 14).mb(4)).child(text('Robin', cx, 14))
        .child(h_flex().mt(24).gap(8)
          .child(this.iconButton('attach', 'attach', 'Attach project outline', cx, cx => {
            this.attached.has(contact.id) ? this.attached.delete(contact.id) : this.attached.add(contact.id); cx.notify();
          }, true))
          .when(this.attached.has(contact.id), el => el.child(text('Project outline.pdf', cx, 11, true)))
          .child(div().flex_1())
          .child(brand('sparkmark', 15)).child(text('Writing assistant', cx, 12, true))
          .child(new Button('send-email').primary().size('small').h(28).px(9).rounded(7).ml(8)
            .disabled(sent).child(h_flex().gap(7).child(div().child(sent ? 'Sent ✓' : 'Send email')).when(!sent, el => el.child(icon('send', 14))))
            .on_click((_event, cx) => { this.sent.add(contact.id); cx.notify(); }))));
  }

  detail(cx) {
    const contact = contacts.find(c => c.id === this.selectedId && !this.dismissed.has(c.id));
    if (!contact) return v_flex().flex_1().h_full().items_center().justify_center().gap(14)
      .child(text('Every letter has found its place.', cx, 20).font_medium())
      .child(text('Your correspondence is up to date.', cx, 13, true))
      .child(new Button('restore').outline().label('Restore demo').on_click((_event, cx) => {
        this.dismissed.clear(); this.sent.clear(); this.attached.clear(); this.highOnly = false; this.reverse = false; this.select('maya', cx);
      }));
    return v_flex().flex_1().min_w_0().h_full()
      .child(h_flex().h(56).px(24).gap(12).flex_shrink_0()
        .child(text(contact.name, cx, 13).font_medium())
        .child(h_flex().gap(7).child(brand(contact.brand, 14)).child(text(contact.company, cx, 14)))
        .child(div().flex_1())
        .child(this.iconButton('previous', 'up', 'Previous contact', cx, cx => this.move(-1, cx), true))
        .child(this.iconButton('next', 'down', 'Next contact', cx, cx => this.move(1, cx), true))
        .child(new Button('dismiss').outline().size('small').h(27).label('Dismiss')
          .on_click((_event, cx) => { this.dismissed.add(contact.id); this.selectedId = this.visibleContacts()[0]?.id; cx.notify(); })))
      .child(v_flex().id('detail-scroll').flex_1().min_h_0().overflow_y_scroll().items_center().px(32).pt(28).pb(28)
        .child(v_flex().w_full().max_w(680).gap(20)
          .child(v_flex().bg(cx.theme().colors.muted).border_1().border_color(cx.theme().colors.border).rounded(12).p(18).gap(12)
            .child(h_flex().gap(12).child(icon('pointer', 15)).child(text('Draft context', cx, 13).font_semibold())
              .child(div().bg(cx.theme().colors.surface).border_1().border_color(cx.theme().colors.border).rounded(4).px(5).py(1).child(text('Email draft', cx, 12))))
            .child(text(notes[contact.id].summary, cx, 13).line_height('21px')))
          .child(this.email(contact, cx))
          .child(h_flex().justify_between().child(text('A quieter place for your correspondence.', cx, 11, true)).child(text('FOLIO DESK', cx, 10, true).font_medium()))));
  }

  render(cx) {
    return v_flex().size_full().font_family('Helvetica Neue').text_size(13).text_color(cx.theme().colors.foreground).bg(cx.theme().colors.background)
      .child(new TitleBar().h(28).bg(cx.theme().colors.secondary).child(text('FOLIO  /  CORRESPONDENCE', cx, 10, true).font_medium()))
      .child(h_flex().flex_1().min_h_0().items_stretch()
        .child(this.rail(cx))
        .child(h_resizable('studio-workspace').flex_1().min_w_0().h_full()
          .child(resizable_panel().size(300).size_range(280, 460).child(this.sidebar(cx)))
          .child(resizable_panel().size_range(520).child(this.detail(cx)))));
  }
}
