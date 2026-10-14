#!/usr/bin/env python3
"""Materialize later UI states against fixtures with `gpui-shell check`.

Each state runs in a scratch copy whose start-up I/O is disabled: no saved
chats are read, nothing is written, and neither `claude` nor `codex` runs.
"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

APP = Path(__file__).resolve().parents[1]
cache = Path.home() / '.cache/gpui-shell-benchs-test-tmp'
cache.mkdir(parents=True, exist_ok=True)
source = (APP / 'main.js').read_text()
source = source.replace('    this.load(cx);\n', '    this.loaded = true;\n', 1)
source = source.replace("  save(cx) {\n", "  save(cx) { return;\n", 1)
source = source.replace("const PREFS = 'chat.preferences.v1';", "const PREFS = 'chat.check.fixture.v1';")
source = source.replace('const prefs = loadPrefs();', 'const prefs = {};')
common = '''
    const conversation = { id: 'c1', title: 'Process or thread?', provider: 'claude', model: 'sonnet', sessions: { claude: 's1' }, createdAt: 1, updatedAt: Date.now(),
      messages: [
        { id: 'u1', role: 'user', text: 'What is the difference between a process and a thread?', at: 1 },
        { id: 'a1', role: 'assistant', provider: 'claude', model: 'claude-sonnet', text: '## Short answer\\n\\nA **process** owns memory; a *thread* shares it.\\n\\n```c\\nfork();\\n```', durationMs: 4200, cost: 0.0123, at: 2 },
        { id: 'u2', role: 'user', text: 'And in Rust?', at: 3 },
      ] };
    this.conversations = [conversation, { id: 'c2', title: '', provider: 'codex', model: '', sessions: {}, createdAt: 1, updatedAt: 1, messages: [{ id: 'u9', role: 'user', text: 'Old question from last month', at: 1 }] }];
    this.currentId = 'c1';
    this.resetScroller(conversation.messages.length);
'''
states = {
    'welcome': "this.currentId = null;",
    'transcript': "conversation.messages.push({ id: 'a2', role: 'assistant', provider: 'claude', text: 'Use `std::thread::spawn`.', durationMs: 900, at: 4 }); this.resetScroller(4);",
    'streaming': "const assistant = { id: 'a2', role: 'assistant', provider: 'claude', text: 'Threads in Rust', at: 4 }; conversation.messages.push(assistant); this.running = { conversation, assistant, provider: 'claude', turn: { text: 'Threads in Rust', thinking: '', activity: '' }, stderr: [], startedAt: Date.now() - 3000, cancel: () => {}, cancelled: false }; this.resetScroller(4);",
    'thinking': "const assistant = { id: 'a2', role: 'assistant', provider: 'codex', text: '', at: 4 }; conversation.messages.push(assistant); this.running = { conversation, assistant, provider: 'codex', turn: { text: '', thinking: 'Considering ownership rules.', activity: 'Running ls' }, stderr: [], startedAt: Date.now(), cancel: null, cancelled: false }; this.resetScroller(4);",
    'error': "conversation.messages.push({ id: 'a2', role: 'assistant', provider: 'claude', text: '', error: 'The reply took longer than gpui-shell allows a command to run (30 seconds).', durationMs: 30000, at: 4 }); this.resetScroller(4);",
    'search': "this.search.set_value('rust');",
    'rename': "this.askRename('c1', cx);",
    'delete': "this.askDelete('c1', cx);",
    'row-menu': "this.menu = { id: 'c1', x: 120, y: 160 };",
    'model-menu': "this.menu = { kind: 'model' };",
    'banner-undo': "this.deleted = { conversation: this.conversations[1], index: 1 }; this.message = { text: 'Deleted “Old question”.', undo: true };",
    'no-sidebar': "this.sidebar = false;",
}
with tempfile.TemporaryDirectory(prefix='chat-views-', dir=cache) as scratch:
    for name, state in states.items():
        target = Path(scratch) / name
        shutil.copytree(APP, target, ignore=shutil.ignore_patterns('tests', 'gpui-kit.d.ts', 'jsconfig.json'))
        patched = source.replace('    this.loaded = true;\n', '    this.loaded = true;\n' + common + '\n    ' + state + '\n', 1)
        (target / 'main.js').write_text(patched)
        manifest = json.loads((target / 'gpui-shell.json').read_text())
        manifest['id'] = 'com.huacnlee.chat.check-' + name
        manifest['capabilities'] = {'fs': {'read': ['${pluginDir}'], 'write': ['${dataDir}']}}
        (target / 'gpui-shell.json').write_text(json.dumps(manifest))
        subprocess.run(['gpui-shell', 'check', '-d', str(target)], check=True)
        print('materialized:', name)
