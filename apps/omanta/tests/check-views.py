#!/usr/bin/env python3
"""Materialize later UI states against isolated fixtures, without launching dev."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

APP = Path(__file__).resolve().parents[1]
cache = Path.home() / '.cache/gpui-shell-benchs-test-tmp'
cache.mkdir(parents=True, exist_ok=True)
source = (APP / 'main.js').read_text()
# Startup I/O is deliberately disabled: these checks exercise UI descriptions,
# never real folders, the user's saved preferences, or an external opener.
source = source.replace('this.scan(tab, cx);', '')
source = source.replace('    cx.spawn(async (cx) => {\n      for (;;) {', '    if (false) cx.spawn(async (cx) => {\n      for (;;) {', 1)
source = source.replace("const PREFS = 'omanta.preferences.v1';", "const PREFS = 'omanta.check.fixture.v1';")
source = source.replace('const prefs = load();', 'const prefs = {};')
source = source.replace('  persist() { store(', '  persist() { return; store(', 1)
common = '''
    this.active().loading = false;
    this.active().entries = [
      { name: 'Documents', path: home + '/Documents', directory: true, type: 'Folder', size: 0, modified: 10000 },
      { name: 'notes.md', path: home + '/notes.md', directory: false, type: 'Document', size: 1024, modified: 10000 }
    ];
    this.active().selected = new Set([home + '/notes.md']);
'''
states = {
    'list-actions': "this.clipboard = { paths: [home + '/notes.md'], cut: false }; this.message = { text: 'Ready to paste.' };",
    'grid-split': "this.viewMode = 'grid'; const extra = this.addTab(home + '/Documents', cx, false); extra.loading = false; extra.entries = this.active().entries; this.splitId = extra.id;",
    'folder-error': "this.active().error = 'Permission denied'; this.active().entries = [];",
    'new-folder': "this.dialog = { kind: 'new', paths: [], directory: home, error: null }; this.form.set_value('New folder');",
    'trash-confirm': "this.dialog = { kind: 'trash', paths: [home + '/notes.md'], directory: home, error: null };",
    'trash-restore': "this.active().path = '@trash'; this.active().entries[1].id = 'test-record'; this.active().entries[1].originalPath = home + '/notes.md';",
    'text-preview': "this.previewEntry = this.active().entries[1]; this.previewData = { kind: 'text', text: '# Fixture preview', truncated: true };",
}
with tempfile.TemporaryDirectory(prefix='omanta-views-', dir=cache) as scratch:
    for name, state in states.items():
        target = Path(scratch) / name
        shutil.copytree(APP, target, ignore=shutil.ignore_patterns('cache', 'tests', 'gpui-kit.d.ts', 'jsconfig.json'))
        patched = source.replace('    this.activate(this.tabs[0].id, cx);', '    this.activate(this.tabs[0].id, cx);' + common + '\n    ' + state, 1)
        patched = patched.replace('const home = homedir();', 'const home = ' + json.dumps(str(target / 'fixture-home')) + ';')
        (target / 'main.js').write_text(patched)
        manifest = json.loads((target / 'gpui-shell.json').read_text())
        manifest['id'] = 'com.huacnlee.omanta.check-' + name
        manifest['capabilities'] = {'fs': {'read': ['${pluginDir}'], 'write': ['${dataDir}']}}
        (target / 'gpui-shell.json').write_text(json.dumps(manifest))
        subprocess.run(['gpui-shell', 'check', '-d', str(target)], check=True)
        print('materialized:', name)
