import test from 'node:test';
import assert from 'node:assert/strict';
import { newConversation, titleFrom, displayTitle, groupByDate, filterConversations, serialize, parseStore, formatDuration, formatCost } from '../lib/store.js';

const DAY = 86400000;

test('titles come from the first line and cut at a word', () => {
  assert.equal(titleFrom('\n  Plan a trip to Kyoto\nwith details'), 'Plan a trip to Kyoto');
  assert.equal(titleFrom('word '.repeat(20), 20), 'word word word word…');
  assert.equal(titleFrom(''), 'New chat');
  const conversation = newConversation('claude', '', 1, 'c1');
  conversation.messages.push({ id: 'm', role: 'user', text: 'Hello there', at: 1 });
  assert.equal(displayTitle(conversation), 'Hello there');
  conversation.title = 'Renamed';
  assert.equal(displayTitle(conversation), 'Renamed');
});

test('conversations group by date, newest first', () => {
  const now = new Date(2026, 9, 14, 12).getTime();
  const at = (updatedAt, id) => ({ ...newConversation('codex', '', updatedAt, id), updatedAt });
  const groups = groupByDate([at(now - 40 * DAY, 'old'), at(now - 1000, 'today2'), at(now - DAY, 'yday'), at(now - 3 * DAY, 'week'), at(now, 'today1')], now);
  assert.deepEqual(groups.map((group) => group.label), ['Today', 'Yesterday', 'Previous 7 days', 'Older']);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['today1', 'today2']);
});

test('search matches every word across titles and messages', () => {
  const a = newConversation('claude', '', 1, 'a'); a.messages.push({ id: '1', role: 'user', text: 'Rust lifetimes explained', at: 1 });
  const b = newConversation('claude', '', 1, 'b'); b.title = 'Kyoto trip'; b.messages.push({ id: '2', role: 'assistant', text: 'Temples and food', at: 1 });
  assert.deepEqual(filterConversations([a, b], 'kyoto food').map((item) => item.id), ['b']);
  assert.deepEqual(filterConversations([a, b], 'RUST').map((item) => item.id), ['a']);
  assert.equal(filterConversations([a, b], '  ').length, 2);
});

test('the file format round-trips and drops malformed entries', () => {
  const conversation = newConversation('claude', 'sonnet', 5, 'c1');
  conversation.sessions.claude = 's1';
  conversation.messages.push({ id: 'm1', role: 'user', text: 'Hi', at: 6 }, { id: 'm2', role: 'assistant', text: 'Hello', provider: 'claude', cost: 0.01, durationMs: 1200, at: 7 });
  const parsed = parseStore(serialize([conversation, { id: 7 }, { id: 'x', provider: 'gpt', messages: [] }]));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], conversation);
  const damaged = JSON.parse(serialize([conversation]));
  damaged.conversations[0].messages.push({ id: 'm3', role: 'system', text: 'x' }, null);
  damaged.conversations[0].sessions.codex = 42;
  const repaired = parseStore(JSON.stringify(damaged))[0];
  assert.equal(repaired.messages.length, 2);
  assert.deepEqual(repaired.sessions, { claude: 's1' });
  assert.throws(() => parseStore('{'), /not valid JSON/);
  assert.throws(() => parseStore('{"format":9,"conversations":[]}'), /unknown format/);
});

test('durations and costs read naturally', () => {
  assert.equal(formatDuration(3200), '3.2 s');
  assert.equal(formatDuration(64000), '1 min 4 s');
  assert.equal(formatCost(0.02182), '$0.022');
  assert.equal(formatCost(0.0031), '$0.0031');
});
