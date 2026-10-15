import test from 'node:test';
import assert from 'node:assert/strict';
import { shellCommand, buildArgs, createTurn, applyLine, finishError, contextPrompt, parseVersion, codexSession, describeActivity, continuePrompt } from '../lib/providers.js';

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

test('codex stays read-only on new and resumed turns, and resumes by thread id', () => {
  const readOnly = ['-c', 'sandbox_mode="read-only"'];
  assert.deepEqual(buildArgs('codex', { prompt: 'hi' }), ['exec', '--json', '--skip-git-repo-check', ...readOnly, '--', 'hi']);
  // `exec resume` has no --sandbox flag; without the override a resumed turn
  // ran with the user's configured sandbox, which can be full access.
  assert.deepEqual(buildArgs('codex', { prompt: 'again', sessionId: 't1' }), ['exec', 'resume', '--json', '--skip-git-repo-check', ...readOnly, '--', 't1', 'again']);
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
  assert.equal(turn.phase, 'thinking');
  assert.equal(createTurn().phase, 'starting');
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
    'Couldn’t find `codex`. Install it, or add its folder to PATH in your shell profile.');
  // Through the login shell, a missing tool is exit code 127 and the shell's own message.
  assert.equal(finishError(createTurn(), { code: 127 }, 'zsh:1: command not found: claude'),
    'Couldn’t find `claude`. Install it, or add its folder to PATH in your shell profile.');
  assert.equal(finishError(createTurn(), { code: 127 }, 'codex: 1: exec: codex: not found'),
    'Couldn’t find `codex`. Install it, or add its folder to PATH in your shell profile.');
});

test('tools start through the login shell with HOME set, except on Windows', () => {
  const [program, args] = shellCommand('codex', ['exec', '--', 'a "b" $c'], { platform: 'macos', home: '/Users/me' });
  assert.equal(program, '/usr/bin/env');
  assert.deepEqual(args.slice(0, 3), ['HOME=/Users/me', '/bin/zsh', '-lc']);
  assert.match(args[3], /\/opt\/homebrew\/bin/);
  // The tool and its arguments stay separate argv entries, never shell text.
  assert.deepEqual(args.slice(4), ['codex', 'exec', '--', 'a "b" $c']);
  assert.equal(shellCommand('claude', [], { platform: 'darwin', home: '/Users/me' })[1][1], '/bin/zsh');
  assert.equal(shellCommand('claude', [], { platform: 'linux', home: '/home/me' })[1][1], '/bin/sh');
  assert.deepEqual(shellCommand('claude', ['-p'], { platform: 'windows', home: 'C:\\Users\\me' }), ['claude', ['-p']]);
  assert.deepEqual(shellCommand('claude', ['-p'], { platform: 'win32', home: 'C:\\Users\\me' }), ['claude', ['-p']]);
});

test('context prompts carry recent history within a bound', () => {
  const history = [{ role: 'user', text: 'a'.repeat(50) }, { role: 'assistant', text: 'b'.repeat(50) }, { role: 'user', text: 'Name?' }];
  const prompt = contextPrompt(history, 'Continue', 120);
  assert.ok(prompt.includes('User: Name?'));
  assert.ok(prompt.includes('Assistant: ' + 'b'.repeat(50)));
  assert.ok(!prompt.includes('a'.repeat(50)));
  assert.equal(contextPrompt([], 'Hello'), 'Hello');
});

test('versions come from either tool\'s --version output', () => {
  assert.equal(parseVersion('2.1.296 (Claude Code)\n'), '2.1.296');
  assert.equal(parseVersion('codex-cli 0.162.1\n'), '0.162.1');
  assert.equal(parseVersion('command not found'), null);
});

const rpc = (value) => JSON.stringify({ jsonrpc: '2.0', ...value });

test('codex app-server: handshake, read-only thread, then the turn', () => {
  const session = codexSession({ prompt: 'Count to 3', cwd: '/data/workspace' });
  const [init] = session.start().map(JSON.parse);
  assert.equal(init.method, 'initialize');
  const afterInit = session.receive(rpc({ id: init.id, result: {} })).write.map(JSON.parse);
  assert.deepEqual(afterInit.map((m) => m.method), ['initialized', 'thread/start']);
  assert.deepEqual(afterInit[1].params, { sandbox: 'read-only', approvalPolicy: 'never', cwd: '/data/workspace' });
  const [turnStart] = session.receive(rpc({ id: afterInit[1].id, result: { thread: { id: 't1' } } })).write.map(JSON.parse);
  assert.equal(turnStart.method, 'turn/start');
  assert.deepEqual(turnStart.params, { threadId: 't1', input: [{ type: 'text', text: 'Count to 3', text_elements: [] }] });
  assert.equal(session.turn.sessionId, 't1');
  session.receive(rpc({ id: turnStart.id, result: { turn: { id: 'u1' } } }));
  assert.equal(JSON.parse(session.interrupt()[0]).method, 'turn/interrupt');
});

test('codex app-server: deltas stream the reply and turn/completed ends it', () => {
  const session = codexSession({ prompt: 'x' });
  session.start();
  for (const delta of ['1', '\n2', '\n3']) {
    assert.equal(session.receive(rpc({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta } })).changed, true);
  }
  assert.equal(session.turn.text, '1\n2\n3');
  session.receive(rpc({ method: 'item/reasoning/summaryTextDelta', params: { delta: 'Counting.' } }));
  assert.equal(session.turn.thinking, 'Counting.');
  session.receive(rpc({ method: 'item/started', params: { item: { type: 'commandExecution', command: 'ls' } } }));
  assert.equal(session.turn.activity, 'Running ls');
  session.receive(rpc({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));
  assert.equal(session.done, true);
  assert.equal(session.turn.error, null);
});

test('codex app-server: resumes by thread id, refuses server requests, reports failures', () => {
  const session = codexSession({ prompt: 'again', sessionId: 't9' });
  const [init] = session.start().map(JSON.parse);
  const [, resume] = session.receive(rpc({ id: init.id, result: {} })).write.map(JSON.parse);
  assert.equal(resume.method, 'thread/resume');
  assert.equal(resume.params.threadId, 't9');
  assert.equal(resume.params.sandbox, 'read-only');
  const [answer] = session.receive(rpc({ id: 77, method: 'item/commandExecution/requestApproval', params: {} })).write.map(JSON.parse);
  assert.equal(answer.id, 77);
  assert.ok(answer.error);
  session.receive(rpc({ id: resume.id, error: { message: 'no rollout found for thread id t9' } }));
  assert.equal(session.done, true);
  assert.match(session.turn.error, /no rollout found/);
  const interrupted = codexSession({ prompt: 'x' });
  interrupted.receive(rpc({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }));
  assert.equal(interrupted.turn.error, 'Stopped.');
  const retried = codexSession({ prompt: 'x' });
  retried.receive(rpc({ method: 'error', params: { error: { message: 'busy' }, willRetry: true } }));
  assert.equal(retried.turn.error, null);
});

test('codex app-server: a connected session starts with its thread request and its own ids', () => {
  const session = codexSession({ prompt: 'again', sessionId: 't2', connected: true, firstId: 500 });
  assert.equal(session.turn.phase, 'thinking');
  const [resume] = session.start().map(JSON.parse);
  assert.equal(resume.method, 'thread/resume');
  assert.equal(resume.id, 501);
  // A late reply to another turn's request is not this session's.
  assert.deepEqual(session.receive(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} })).write, []);
  const [turnStart] = session.receive(JSON.stringify({ jsonrpc: '2.0', id: 501, result: { thread: { id: 't2' } } })).write.map(JSON.parse);
  assert.equal(turnStart.method, 'turn/start');
  assert.equal(codexSession({ prompt: 'x' }).turn.phase, 'starting');
});

test('a turn moves through stages the activity bar can name', () => {
  const turn = createTurn();
  const at = (stage, events) => { for (const event of events) applyLine('claude', turn, JSON.stringify(event)); assert.equal(turn.stage, stage); };
  assert.equal(turn.stage, 'launching');
  at('sending', [{ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' }]);
  at('waiting', [{ type: 'system', subtype: 'status', status: 'requesting' }, { type: 'stream_event', event: { type: 'message_start' } }]);
  at('reasoning', [{ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'First, **list** the cases.\nThen compare them.' } } }]);
  at('writing', [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Three short words 和中文' } } }]);
  at('finishing', [{ type: 'stream_event', event: { type: 'message_stop' } }]);

  const describe = (stage, extra = {}) => describeActivity({ ...turn, stage, ...extra }, { label: 'Claude', now: 20000, ...extra.context });
  assert.deepEqual(describe('launching', { stageAt: 19000 }), { label: 'Starting Claude', detail: 'Launching the claude command' });
  assert.match(describe('launching', { stageAt: 10000 }).detail, /sign-in and settings/);
  assert.equal(describe('opening', { context: { resuming: true } }).label, 'Resuming the conversation');
  assert.equal(describe('waiting', { stageAt: 19000, eventAt: 19000 }).label, 'Waiting for claude-opus-5-5');
  assert.match(describe('waiting', { stageAt: 5000, eventAt: 5000 }).detail, /No output for 15 s/);
  assert.equal(describe('reasoning').detail, 'Then compare them.');
  assert.equal(describe('writing', { eventAt: 20000 }).detail, '6 words so far');
});

test('codex items name what the turn is doing', () => {
  const session = codexSession({ prompt: 'x', connected: true, firstId: 0 });
  assert.equal(session.turn.stage, 'opening');
  const [thread] = session.start().map(JSON.parse);
  session.receive(JSON.stringify({ jsonrpc: '2.0', id: thread.id, result: { thread: { id: 't' } } }));
  assert.equal(session.turn.stage, 'sending');
  const mcp = (status) => session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'mcpServer/startupStatus/updated', params: { name: 'codex_apps', status } }));
  mcp('starting');
  assert.deepEqual(describeActivity(session.turn, { label: 'Codex', now: 0 }), { label: 'Starting tools', detail: 'MCP server codex_apps' });
  mcp('ready');
  assert.equal(describeActivity(session.turn, { label: 'Codex', now: 0 }).label, 'Sending your message');
  session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'turn/started', params: {} }));
  assert.equal(session.turn.stage, 'waiting');
  session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'webSearch', query: 'rust threads' } } }));
  assert.deepEqual([session.turn.stage, session.turn.activity], ['tool', 'Searching the web for rust threads']);
  session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'webSearch' } } }));
  assert.deepEqual([session.turn.stage, session.turn.activity], ['waiting', '']);
  session.receive(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'm', delta: 'Hi' } }));
  assert.equal(session.turn.stage, 'writing');
});

test('a cut-off reply is continued from its tail', () => {
  const prompt = continuePrompt(`${'x'.repeat(3000)}The end of it`, 100);
  assert.match(prompt, /<partial_reply>\nx+The end of it\n<\/partial_reply>/);
  assert.ok(!prompt.includes('x'.repeat(101)));
  assert.match(prompt, /do not repeat/);
});
