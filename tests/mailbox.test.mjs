import test from 'node:test';
import assert from 'node:assert/strict';
import { Mailbox, contacts, draftText } from '../mailbox.js';

test('search covers sender, company, address and subject; selection follows visible results', () => {
  const mailbox = new Mailbox();
  for (const query of ['Jules', 'Margin Press', 'jules@margin.example', 'spring catalogue']) {
    mailbox.query = query;
    mailbox.reconcile();
    assert.deepEqual(mailbox.rows().map(c => c.id), ['leo-field']);
    assert.equal(mailbox.selectedId, 'leo-field');
  }
  mailbox.query = '  NO MATCH  ';
  mailbox.reconcile();
  assert.equal(mailbox.selectedId, undefined);
  mailbox.query = '';
  mailbox.reconcile();
  assert.equal(mailbox.selectedId, 'maya');
});

test('send prevents duplicates, offline failure is retryable, sent drafts leave Ready', () => {
  const mailbox = new Mailbox();
  mailbox.folder = 'Ready to send';
  assert.equal(mailbox.beginSend('maya'), true);
  assert.equal(mailbox.beginSend('maya'), false);
  assert.equal(mailbox.dismiss('maya'), false);
  mailbox.finishSend('maya', false);
  assert.equal(mailbox.failed.has('maya'), true);
  assert.equal(mailbox.sent.size, 0);
  assert.equal(mailbox.beginSend('maya'), true);
  mailbox.finishSend('maya', true);
  assert.equal(mailbox.failed.size, 0);
  assert.equal(mailbox.selectedId, 'noah');
  assert.equal(mailbox.rows().length, 2);
  assert.equal(mailbox.beginSend('maya'), false);
  mailbox.folder = 'Sent';
  mailbox.reconcile();
  assert.deepEqual(mailbox.rows().map(c => c.id), ['maya']);
});

test('blank drafts cannot send; draft contents and completed changes survive restart', () => {
  const mailbox = new Mailbox();
  mailbox.drafts.maya = '  \n  ';
  assert.equal(mailbox.beginSend('maya'), false);
  mailbox.drafts.maya = 'An edited letter';
  mailbox.attached.add('maya');
  mailbox.beginSend('maya');
  mailbox.finishSend('maya', true);
  mailbox.beginSend('noah');
  mailbox.finishSend('noah', false);
  mailbox.beginSend('leo-field');
  mailbox.dismiss('iris-arc');
  const restored = new Mailbox(JSON.parse(JSON.stringify(mailbox.snapshot())));
  assert.equal(restored.draft('maya'), 'An edited letter');
  assert.equal(restored.draft('noah'), draftText('noah'));
  assert.equal(restored.sent.has('maya'), true);
  assert.equal(restored.attached.has('maya'), true);
  assert.equal(restored.dismissed.has('iris-arc'), true);
  assert.equal(restored.pending.size, 0);
  assert.equal(restored.failed.size, 0);
});

test('discarded/unknown saved ids are ignored; reversing preserves identity', () => {
  const mailbox = new Mailbox({ sent: ['deleted-contact', 'maya'], dismissed: null, attached: 'invalid', drafts: { maya: 12, fake: 'text' } });
  assert.deepEqual([...mailbox.sent], ['maya']);
  assert.equal(mailbox.draft('maya'), draftText('maya'));
  mailbox.reverse = true;
  mailbox.reconcile();
  assert.equal(mailbox.rows()[0].id, contacts.at(-1).id);
  assert.equal(mailbox.selectedId, 'maya');
  contacts.forEach(c => mailbox.dismiss(c.id));
  assert.equal(mailbox.rows().length, 0);
  assert.equal(mailbox.selectedId, undefined);
  assert.equal(new Mailbox(null).rows().length, 8);
});
