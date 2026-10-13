/** @typedef {{ id: string, name: string, company: string, avatar: string, brand: string, group: string, level: string, email: string }} Contact */
/** @type {Contact[]} */
export const contacts = [
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
export const notes = {
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

export const groups = ['Ready to send', 'Waiting for a reply', 'Saved for later', 'Sent'];
export const draftText = id => `Hello ${contacts.find(c => c.id === id).name.split(' ')[0]},\n\n${notes[id].body}\n\n${notes[id].ask}\n\nWarmly,\nRobin`;

// Persist only completed local work. In-flight simulations never survive a restart.
export class Mailbox {
  constructor(snapshot = {}) {
    const ids = new Set(contacts.map(c => c.id));
    const validIds = value => new Set(Array.isArray(value) ? value.filter(id => ids.has(id)) : []);
    this.sent = validIds(snapshot?.sent);
    this.dismissed = validIds(snapshot?.dismissed);
    this.attached = validIds(snapshot?.attached);
    this.drafts = Object.fromEntries(Object.entries(snapshot?.drafts || {}).filter(([id, value]) => ids.has(id) && typeof value === 'string'));
    this.pending = new Set();
    this.failed = new Set();
    this.query = '';
    this.folder = 'all';
    this.reverse = false;
    this.selectedId = this.rows()[0]?.id;
  }
  group(contact) { return this.sent.has(contact.id) ? 'Sent' : contact.group; }
  rows() {
    const query = this.query.trim().toLowerCase();
    const rows = contacts.filter(c => !this.dismissed.has(c.id)
      && (this.folder === 'all' || this.group(c) === this.folder)
      && `${c.name} ${c.company} ${c.email} ${notes[c.id].subject}`.toLowerCase().includes(query));
    return this.reverse ? rows.reverse() : rows;
  }
  reconcile() {
    if (!this.rows().some(c => c.id === this.selectedId)) this.selectedId = this.rows()[0]?.id;
  }
  draft(id) { return this.drafts[id] ?? draftText(id); }
  dismiss(id) {
    if (this.pending.has(id)) return false;
    this.dismissed.add(id);
    this.reconcile();
    return true;
  }
  beginSend(id) {
    if (!id || this.sent.has(id) || this.pending.has(id) || this.dismissed.has(id) || !this.draft(id).trim()) return false;
    this.pending.add(id);
    this.failed.delete(id);
    return true;
  }
  finishSend(id, online) {
    if (!this.pending.delete(id)) return false;
    if (online) this.sent.add(id); else this.failed.add(id);
    this.reconcile();
    return true;
  }
  snapshot() {
    return { sent: [...this.sent], dismissed: [...this.dismissed], attached: [...this.attached], drafts: this.drafts };
  }
}
