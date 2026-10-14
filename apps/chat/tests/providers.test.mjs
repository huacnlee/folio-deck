import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, createTurn, applyLine, finishError, contextPrompt } from '../lib/providers.js';

const feed = (provider, events) => {
  const turn = createTurn();
  for (const event of events) applyLine(provider, turn, typeof event === 'string' ? event : JSON.stringify(event));
  return turn;
};

test('claude arguments disable tools, resume sessions and keep the prompt after --', () => {
  const args = buildArgs('claude', { prompt: '-n is a flag?', sessionId: 'abc', model: 'sonnet' });
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']);
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(args.includes('--resume') && args[args.indexOf('--resume') + 1] === 'abc');
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'sonnet');
  assert.deepEqual(args.slice(-2), ['--', '-n is a flag?']);
  assert.ok(!buildArgs('claude', { prompt: 'hi' }).includes('--resume'));
});

test('codex arguments start read-only and resume by thread id', () => {
  assert.deepEqual(buildArgs('codex', { prompt: 'hi' }), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--', 'hi']);
  assert.deepEqual(buildArgs('codex', { prompt: 'again', sessionId: 't1' }), ['exec', 'resume', '--json', '--skip-git-repo-check', '--', 't1', 'again']);
  assert.throws(() => buildArgs('other', { prompt: 'x' }));
});

test('claude stream: deltas build the text, the final message and result settle it', () => {
  const turn = feed('claude', [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Counting.' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '1\n' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '2' } } },
  ]);
  assert.equal(turn.text, '1\n2');
  assert.equal(turn.thinking, 'Counting.');
  assert.equal(turn.sessionId, 's1');
  applyLine('claude', turn, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '1\n2\n3' }] } }));
  applyLine('claude', turn, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '1\n2\n3', session_id: 's1', total_cost_usd: 0.02, usage: { output_tokens: 5 } }));
  assert.equal(turn.text, '1\n2\n3');
  assert.equal(turn.done, true);
  assert.equal(turn.cost, 0.02);
  assert.equal(finishError(turn, { code: 0 }, ''), null);
});

test('claude reports a missing session through its errors list', () => {
  const turn = feed('claude', [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', errors: ['No conversation found with session ID: 0000'] }]);
  assert.equal(turn.error, 'No conversation found with session ID: 0000');
});

test('claude errors and non-JSON lines', () => {
  const turn = feed('claude', ['not json', '', { type: 'result', is_error: true, result: 'No conversation found with session ID: x' }]);
  assert.equal(turn.error, 'No conversation found with session ID: x');
  assert.equal(finishError(turn, { code: 1 }, ''), 'No conversation found with session ID: x');
});

test('codex events: thread id, messages, command activity, failures', () => {
  const turn = feed('codex', [
    { type: 'thread.started', thread_id: 't9' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
  ]);
  assert.equal(turn.sessionId, 't9');
  assert.equal(turn.activity, 'Running ls');
  applyLine('codex', turn, JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'First.' } }));
  applyLine('codex', turn, JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Second.' } }));
  applyLine('codex', turn, JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 4 } }));
  assert.equal(turn.text, 'First.\n\nSecond.');
  assert.equal(turn.activity, '');
  assert.equal(turn.done, true);
  const failed = feed('codex', [{ type: 'turn.failed', error: { message: 'usage limit' } }]);
  assert.equal(failed.error, 'usage limit');
});

test('finish errors explain timeouts, exit codes and empty replies', () => {
  assert.match(finishError(createTurn(), { code: null, error: '`claude` timed out after 30000 ms' }, ''), /30 seconds/);
  assert.equal(finishError(createTurn(), { code: 2 }, 'Reading additional input from stdin...\nnot logged in\n'), 'not logged in');
  assert.equal(finishError(createTurn(), { code: 0 }, ''), 'The reply was empty.');
  assert.equal(finishError(createTurn(), { code: null, error: 'running `codex` failed: executable was not found on the host PATH' }, ''),
    'Couldn’t find `codex`. Install it and start gpui-shell from a shell that has it on PATH.');
});

test('context prompts carry recent history within a bound', () => {
  const history = [{ role: 'user', text: 'a'.repeat(50) }, { role: 'assistant', text: 'b'.repeat(50) }, { role: 'user', text: 'Name?' }];
  const prompt = contextPrompt(history, 'Continue', 120);
  assert.ok(prompt.includes('User: Name?'));
  assert.ok(prompt.includes('Assistant: ' + 'b'.repeat(50)));
  assert.ok(!prompt.includes('a'.repeat(50)));
  assert.equal(contextPrompt([], 'Hello'), 'Hello');
});
