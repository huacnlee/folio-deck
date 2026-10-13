#!/usr/bin/env python3
"""Verify native gpui-shell process execution, HTTP grants and automatic callback."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='.native-oauth-', dir=root / 'tests') as directory:
    app = Path(directory)
    for file in ['gmail.js', 'oauth-callback.js', 'oauth-runtime.js']:
        shutil.copyfile(root / file, app / file)
    manifest = json.loads((root / 'gpui-shell.json').read_text())
    manifest.update(id='com.folio.oauth-check', entry='main.js')
    manifest['capabilities']['storage'] = False
    (app / 'gpui-shell.json').write_text(json.dumps(manifest))
    (app / 'main.js').write_text('''
import {View, div} from 'gpui-kit';
import {CallbackListener} from './oauth-callback.js';
import {beginAuthorization} from './gmail.js';
export default class OAuthCheck extends View {
  init(props, cx) {
    cx.spawn(async cx => {
      const pending = beginAuthorization({clientId:'123456-test.apps.googleusercontent.com',clientSecret:'synthetic'}).pending;
      const listener = new CallbackListener(pending);
      try {
        await listener.start();
        console.log('oauth-ready ' + pending.state);
        for (let i=0;i<50;i++) {
          const callback = await listener.poll();
          if (callback) { console.log('oauth-verified'); return; }
          await cx.sleep(100);
        }
        console.log('oauth-failed timeout');
      } catch (error) { console.log('oauth-failed ' + error.message); }
      finally { await listener.stop(); cx.exit(0); }
    });
  }
  render(cx) { return div().child('OAuth transport verification'); }
}
''')
    process = subprocess.Popen(['gpui-shell', 'run', '-d', str(app)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    success = False
    try:
        for line in process.stdout:
            if 'oauth-ready ' in line:
                state = line.split('oauth-ready ', 1)[1].strip()
                with urllib.request.urlopen(f'http://127.0.0.1:9481/oauth2callback?state={state}&code=synthetic-code', timeout=3) as response:
                    assert response.status == 200
            elif 'oauth-verified' in line:
                success = True
                print('Native automatic OAuth callback verified (no token exchange).', flush=True)
                break
            elif 'oauth-failed ' in line:
                raise RuntimeError(line.strip())
        assert success, 'Native OAuth callback did not complete'
    finally:
        process.terminate()
        process.wait(timeout=5)
