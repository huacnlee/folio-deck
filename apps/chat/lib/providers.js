// Local AI command-line tools as chat back ends. Each turn runs the user's
// own `claude` or `codex` with their existing sign-in; this module builds the
// arguments and folds the JSONL each tool prints into one turn state.

export const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    // Aliases the Claude CLI resolves itself; empty means the user's default.
    models: [
      { id: '', label: 'Default' },
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    // Codex reads its model from ~/.codex/config.toml.
    models: [{ id: '', label: 'Default' }],
  },
};

export const providerIds = Object.keys(PROVIDERS);

/**
 * Command-line arguments for one turn. Tools are off for Claude and Codex
 * runs read-only on every turn, resumed or new, so a chat never edits files. The prompt follows `--` so a
 * message that starts with `-` is never read as an option.
 * @param {string} provider
 * @param {{ prompt: string, sessionId?: string | null, model?: string }} turn
 */
export function buildArgs(provider, { prompt, sessionId = null, model = '' }) {
  if (provider === 'claude') {
    return [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '',
      ...(model ? ['--model', model] : []),
      ...(sessionId ? ['--resume', sessionId] : []),
      '--', prompt,
    ];
  }
  if (provider === 'codex') {
    // `exec resume` takes no `--sandbox` and otherwise falls back to the user's
    // config, which may grant full access; the config override pins read-only
    // for new and resumed turns alike.
    const options = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', ...(model ? ['-m', model] : [])];
    return sessionId
      ? ['exec', 'resume', ...options, '--', sessionId, prompt]
      : ['exec', ...options, '--', prompt];
  }
  throw new Error(`Unknown provider: ${provider}`);
}

/** A turn in progress: what the transcript shows while output arrives. */
export function createTurn() {
  return {
    text: '',
    thinking: '',
    activity: '',
    // 'starting' while the tool launches, then 'thinking' until text arrives.
    phase: 'starting',
    sessionId: null,
    model: '',
    error: null,
    done: false,
    cost: null,
    usage: null,
    items: {},
  };
}

/**
 * Applies one line of a tool's JSONL output to `turn` and returns whether
 * anything visible changed. Lines that are not JSON are ignored.
 * @param {string} provider
 * @param {ReturnType<typeof createTurn>} turn
 * @param {string} line
 */
export function applyLine(provider, turn, line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return false;
  let event;
  try { event = JSON.parse(trimmed); } catch { return false; }
  return provider === 'codex' ? applyCodex(turn, event) : applyClaude(turn, event);
}

function applyClaude(turn, event) {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        turn.sessionId = event.session_id ?? turn.sessionId;
        turn.model = event.model ?? turn.model;
        turn.phase = 'thinking';
        return true;
      }
      return false;
    case 'stream_event': {
      const delta = event.event?.type === 'content_block_delta' ? event.event.delta : null;
      if (delta?.type === 'text_delta') { turn.text += delta.text ?? ''; return true; }
      if (delta?.type === 'thinking_delta') { turn.thinking += delta.thinking ?? ''; return true; }
      return false;
    }
    case 'assistant': {
      // The complete message supersedes the deltas that built it.
      const content = event.message?.content ?? [];
      const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('');
      const thinking = content.filter((part) => part.type === 'thinking').map((part) => part.thinking).join('');
      if (text) turn.text = text;
      if (thinking) turn.thinking = thinking;
      if (event.message?.model) turn.model = event.message.model;
      return Boolean(text || thinking);
    }
    case 'result':
      turn.done = true;
      turn.sessionId = event.session_id ?? turn.sessionId;
      turn.cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
      turn.usage = event.usage ?? null;
      if (event.is_error || (Array.isArray(event.errors) && event.errors.length && !turn.text)) {
        const errors = Array.isArray(event.errors) ? event.errors.filter(Boolean).join('\n') : '';
        turn.error = String(errors || event.result || event.subtype || 'Claude reported an error.');
      }
      else if (!turn.text && typeof event.result === 'string') turn.text = event.result;
      return true;
    default:
      return false;
  }
}

function applyCodex(turn, event) {
  switch (event.type) {
    case 'thread.started':
      turn.sessionId = event.thread_id ?? turn.sessionId;
      return false;
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item ?? {};
      if (item.type === 'agent_message') {
        turn.items[item.id] = item.text ?? '';
        turn.text = Object.values(turn.items).filter(Boolean).join('\n\n');
        turn.activity = '';
        return true;
      }
      if (item.type === 'reasoning') {
        if (item.text) turn.thinking = item.text;
        return Boolean(item.text);
      }
      if (item.type === 'command_execution') {
        turn.activity = event.type === 'item.completed' ? '' : `Running ${item.command ?? 'a command'}`;
        return true;
      }
      return false;
    }
    case 'turn.completed':
      turn.done = true;
      turn.usage = event.usage ?? null;
      return true;
    case 'turn.failed':
      turn.done = true;
      turn.error = String(event.error?.message ?? 'Codex reported an error.');
      return true;
    case 'error':
      turn.error = String(event.message ?? 'Codex reported an error.');
      return true;
    default:
      return false;
  }
}

/**
 * The error to show when a run ends: what the tool said, or why it stopped.
 * @param {ReturnType<typeof createTurn>} turn
 * @param {{ code: number | null, error?: string }} exit
 * @param {string} stderr
 */
export function finishError(turn, exit, stderr) {
  if (turn.error) return turn.error;
  if (exit.error) {
    if (/timed out/.test(exit.error)) return 'The reply took longer than gpui-shell allows a command to run (30 seconds). Try a shorter question, or retry.';
    if (/not found on the host PATH|PATH environment variable is not set/.test(exit.error)) {
      const command = /`([^`]+)`/.exec(exit.error)?.[1] ?? 'the command';
      return `Couldn’t find \`${command}\`. Install it and start gpui-shell from a shell that has it on PATH.`;
    }
    return exit.error;
  }
  if (exit.code !== 0 && exit.code !== null) {
    const detail = stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('Reading additional input')).pop();
    return detail || `The command exited with code ${exit.code}.`;
  }
  if (!turn.text) return 'The reply was empty.';
  return null;
}

/**
 * A prompt carrying earlier messages, for a conversation that has no session
 * with this provider yet (it was started with the other one, or its session
 * could not be resumed). Older messages are dropped first to stay bounded.
 * @param {{ role: string, text: string }[]} history
 * @param {string} prompt
 * @param {number} [limit]
 */
export function contextPrompt(history, prompt, limit = 24000) {
  const lines = [];
  let size = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (!message.text) continue;
    const entry = `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`;
    if (size + entry.length > limit) break;
    lines.unshift(entry);
    size += entry.length;
  }
  if (!lines.length) return prompt;
  return `Here is our conversation so far:\n\n${lines.join('\n\n')}\n\nContinue the conversation. Reply to this new message:\n\n${prompt}`;
}

/**
 * The version a tool prints for `--version`: "2.1.296 (Claude Code)" and
 * "codex-cli 0.162.1" both give their number; anything else gives null.
 * @param {string} stdout
 */
export function parseVersion(stdout) {
  return /\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\b/.exec(String(stdout))?.[1] ?? null;
}

/**
 * Codex over `codex app-server`, its JSON-RPC protocol on stdin and stdout.
 * Unlike `codex exec --json`, which prints a reply only once it is complete,
 * the app server streams `item/agentMessage/delta` as the reply is written.
 *
 * The session is a pure state machine: `start()` gives the first lines to
 * write, and `receive(line)` folds one line from the server into `turn` and
 * gives the lines to write in answer. The caller owns the process.
 *
 * `connected` reuses an app server that has already been initialized, so a
 * turn begins with its thread request; `firstId` keeps this turn's request
 * ids clear of earlier turns on the same server.
 *
 * @param {{ prompt: string, sessionId?: string | null, model?: string, cwd?: string | null, connected?: boolean, firstId?: number }} options
 */
export function codexSession({ prompt, sessionId = null, model = '', cwd = null, connected = false, firstId = 0 }) {
  const turn = createTurn();
  turn.phase = connected ? 'thinking' : 'starting';
  let nextId = firstId, threadId = null, turnId = null;
  /** @type {Map<number, string>} */
  const pending = new Map();
  const request = (method, params) => {
    const id = ++nextId;
    pending.set(id, method);
    return JSON.stringify({ jsonrpc: '2.0', id, method, params });
  };
  // Every turn is read-only and never asks for approval, new or resumed.
  const threadParams = { sandbox: 'read-only', approvalPolicy: 'never', ...(cwd ? { cwd } : {}), ...(model ? { model } : {}) };
  const failed = (message) => { turn.error = String(message || 'Codex reported an error.'); turn.done = true; };
  const threadRequest = () => sessionId ? request('thread/resume', { threadId: sessionId, ...threadParams }) : request('thread/start', threadParams);
  const textOf = () => Object.values(turn.items).filter(Boolean).join('\n\n');

  return {
    turn,
    get threadId() { return threadId; },
    get done() { return turn.done; },
    start() {
      if (connected) return [threadRequest()];
      return [request('initialize', { clientInfo: { name: 'gpui-shell-chat', version: '0.1.0' }, capabilities: null })];
    },
    /** A request that stops the running turn, when there is one. */
    interrupt() {
      return threadId && turnId && !turn.done ? [request('turn/interrupt', { threadId, turnId })] : [];
    },
    /** @param {string} line @returns {{ write: string[], changed: boolean }} */
    receive(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return { write: [], changed: false };
      let message;
      try { message = JSON.parse(trimmed); } catch { return { write: [], changed: false }; }
      // A request from the server, such as an approval: refuse it so the turn
      // never waits on a question this client cannot ask.
      if (message.method && message.id !== undefined) {
        return { write: [JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported by this client' } })], changed: false };
      }
      if (message.id !== undefined) {
        const method = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          if (method === 'turn/interrupt') return { write: [], changed: false };
          failed(message.error.message);
          return { write: [], changed: true };
        }
        if (method === 'initialize') {
          return {
            write: [JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }), threadRequest()],
            changed: false,
          };
        }
        if (method === 'thread/start' || method === 'thread/resume') {
          threadId = message.result?.thread?.id ?? sessionId;
          turn.sessionId = threadId;
          turn.phase = 'thinking';
          return { write: [request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] })], changed: false };
        }
        if (method === 'turn/start') turnId = message.result?.turn?.id ?? turnId;
        return { write: [], changed: false };
      }
      const params = message.params ?? {};
      switch (message.method) {
        case 'item/agentMessage/delta':
          turn.items[params.itemId] = (turn.items[params.itemId] ?? '') + (params.delta ?? '');
          turn.text = textOf();
          turn.activity = '';
          return { write: [], changed: true };
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/textDelta':
          turn.thinking += params.delta ?? '';
          return { write: [], changed: true };
        case 'item/started':
          if (params.item?.type === 'commandExecution') {
            turn.activity = `Running ${params.item.command ?? 'a command'}`;
            return { write: [], changed: true };
          }
          return { write: [], changed: false };
        case 'item/completed':
          if (params.item?.type === 'agentMessage') {
            turn.items[params.item.id] = params.item.text ?? turn.items[params.item.id] ?? '';
            turn.text = textOf();
            return { write: [], changed: true };
          }
          if (params.item?.type === 'commandExecution') { turn.activity = ''; return { write: [], changed: true }; }
          return { write: [], changed: false };
        case 'thread/tokenUsage/updated':
          turn.usage = params.tokenUsage ?? params.usage ?? turn.usage;
          return { write: [], changed: false };
        case 'error':
          if (!params.willRetry) failed(params.error?.message ?? params.message);
          return { write: [], changed: true };
        case 'turn/completed': {
          const status = params.turn?.status;
          if (status === 'failed') failed(params.turn?.error?.message);
          else if (status === 'interrupted') { turn.done = true; turn.error = turn.error ?? 'Stopped.'; }
          else turn.done = true;
          return { write: [], changed: true };
        }
        default:
          return { write: [], changed: false };
      }
    },
  };
}
