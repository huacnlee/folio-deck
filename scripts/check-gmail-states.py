#!/usr/bin/env python3
"""Materialize the production Gmail view without contacting a real account."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
message = {'id': 'abc', 'threadId': 'def', 'sender': 'Clara Ellis', 'from': 'Clara <clara@example.test>', 'to': 'me@example.test', 'replyTo': 'clara@example.test', 'subject': 'A small edition, made with care', 'messageId': '<original@example.test>', 'references': '', 'date': 1700000000000, 'snippet': 'Your sample pack is ready.', 'body': 'Hello,\n\nYour sample pack is ready.\n\nWarmly,\nClara', 'labels': ['INBOX', 'UNREAD'], 'unread': True, 'starred': False, 'attachments': [{'name': 'Project outline.pdf', 'size': 2048}]}
connected = "this.client.session = {email:'me@example.test'}; this.setupOpen = false;"
states = {
    'setup': '',
    'callback': "this.pendingAuth = beginAuthorization({installed:{client_id:'123456-test.apps.googleusercontent.com',client_secret:'synthetic'}}).pending;",
    'connecting': "this.pendingAuth = {state:'test'}; this.connecting = true;",
    'inbox': connected + 'this.messages = [sample];',
    'loading': connected + 'this.loading = true;',
    'reader': connected + "this.messages = [sample]; this.message = sample; this.selectedId = sample.id;",
    'reading': connected + "this.messages = [sample]; this.reading = true;",
    'compose': connected + "this.draft = {to:'clara@example.test',subject:'Hello',body:'Hello Clara'};",
    'sending': connected + "this.draft = {to:'clara@example.test',subject:'Hello',body:'Hello Clara'}; this.sending = true;",
    'uncertain-send': connected + "this.draft = {to:'clara@example.test',subject:'Hello',body:'Hello Clara',uncertain:true}; this.error = 'Check Sent before another attempt';",
    'pagination': connected + "this.messages = [sample]; this.nextPageToken = 'page-two';",
    'error': connected + "this.error = 'Could not reach Google. Retry after reconnecting.'; this.undoAction = {id:'abc',operation:'archive'};",
}
with tempfile.TemporaryDirectory(prefix='.native-gmail-', dir=root / 'tests') as directory:
    app = Path(directory)
    shutil.copytree(root / 'forma', app / 'forma')
    shutil.copyfile(root / 'gmail-view.js', app / 'view.js')
    for file in ['gmail.js', 'oauth-callback.js', 'oauth-runtime.js']:
        shutil.copyfile(root / file, app / file)
    manifest = json.loads((root / 'gpui-shell.json').read_text())
    manifest.update(id='com.folio.gmail-check', entry='main.js')
    manifest['capabilities'] = {'storage': True}
    (app / 'gpui-shell.json').write_text(json.dumps(manifest))
    for name, setup in states.items():
        (app / 'main.js').write_text(f"""
import GmailView from './view.js';
import {{ beginAuthorization }} from './gmail.js';
const sample = {json.dumps(message)};
export default class CheckState extends GmailView {{
  init(props, cx) {{
    super.init(props, cx);
    {setup}
  }}
}}
""")
        subprocess.run(['gpui-shell', 'check', '-d', str(app)], check=True)
        print('Checked Gmail ' + name, flush=True)
