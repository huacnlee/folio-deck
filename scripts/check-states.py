#!/usr/bin/env python3
"""Materialize every exceptional native UI state, using the installed host."""
import json
from pathlib import Path
import subprocess
import shutil
import tempfile

root = Path(__file__).resolve().parents[1]
states = {
    'editing': "this.editingId = 'maya';",
    'assistant': "this.assistantId = 'maya';",
    'rewriting': "this.assistantId = 'maya'; this.generatingId = 'maya';",
    'attachment': "this.mailbox.attached.add('maya'); this.previewId = 'maya';",
    'sending': "this.mailbox.beginSend('maya');",
    'offline': "this.online = false; this.mailbox.failed.add('maya');",
    'sent': "this.mailbox.sent.add('maya'); this.mailbox.folder = 'Sent';",
    'no-results': "this.mailbox.query = 'no match'; this.mailbox.reconcile();",
    'dismissed': "contacts.forEach(c => this.mailbox.dismiss(c.id)); this.undoId = 'maya';",
}
with tempfile.TemporaryDirectory(prefix='.native-', dir=root / 'tests') as directory:
    app = Path(directory)
    shutil.copytree(root / 'forma', app / 'forma')
    shutil.copyfile(root / 'main.js', app / 'view.js')
    for file in ['theme.js', 'mailbox.js', 'gmail.js', 'gmail-view.js', 'oauth-callback.js', 'oauth-runtime.js']:
        shutil.copyfile(root / file, app / file)
    manifest = json.loads((root / 'gpui-shell.json').read_text())
    manifest.update(id='com.folio.native-check', entry='main.js')
    (app / 'gpui-shell.json').write_text(json.dumps(manifest))
    for name, setup in states.items():
        (app / 'main.js').write_text(f"""
import StudioDemo from './view.js';
import {{ Mailbox, contacts }} from './mailbox.js';
export default class CheckState extends StudioDemo {{
  init(props, cx) {{
    super.init(props, cx);
    this.mode = 'demo';
    this.mailbox = new Mailbox();
    {setup}
  }}
}}
""")
        subprocess.run(['gpui-shell', 'check', '-d', str(app)], check=True)
        print('Checked ' + name, flush=True)
