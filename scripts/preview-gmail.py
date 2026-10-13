#!/usr/bin/env python3
"""Capture the native Gmail layout with synthetic data on the current desktop."""
import ast
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[1]
module = ast.parse((root / 'scripts/check-gmail-states.py').read_text())
message = next(ast.literal_eval(n.value) for n in module.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'message' for t in n.targets))
with tempfile.TemporaryDirectory(prefix='.native-visual-', dir=root / 'tests') as directory:
    app = Path(directory)
    for name in ['gmail-view.js', 'gmail.js', 'oauth-callback.js', 'oauth-runtime.js', 'theme.js']:
        shutil.copyfile(root / name, app / name)
    shutil.copytree(root / 'forma', app / 'forma')
    manifest = json.loads((root / 'gpui-shell.json').read_text())
    manifest.update(id='com.folio.visual-check')
    manifest['capabilities'] = {'storage': True}
    (app / 'gpui-shell.json').write_text(json.dumps(manifest))
    (app / 'main.js').write_text('''
import GmailView from './gmail-view.js';
import {v_flex,set_theme} from 'gpui-base';
import {div} from 'gpui-kit';
import {TitleBar} from 'gpui-component';
import {studioColors} from './theme.js';
const sample = ''' + json.dumps(message) + ''';
export default class Preview extends GmailView {
 init(props,cx) {
  super.init(props,cx); set_theme({appearance:'light',tokens:{colors:studioColors,spacing:{xxs:2,xs:4,sm:8,md:12,lg:16,xl:24,xxl:32},radius:{none:0,sm:4,md:6,lg:8,xl:12,full:9999},typography:{sans:'Helvetica Neue',md:{size:13},sm:{size:12}}}});
  this.client.session={email:'me@example.test'}; this.setupOpen=false;
  this.messages=[sample,{...sample,id:'two',sender:'Jules Morgan',from:'Jules <jules@example.test>',unread:false}];
  this.message=sample; this.selectedId=sample.id;
 }
 render(cx) {
  return v_flex().size_full().font_family('Helvetica Neue').text_size(13).bg(cx.theme().colors.background).text_color(cx.theme().colors.foreground)
   .child(new TitleBar().h(30).bg(cx.theme().colors.secondary).child(div().text_size(10).text_color(cx.theme().colors.muted_foreground).child('FOLIO  /  CORRESPONDENCE')))
   .child(super.render(cx));
 }
}
''')
    subprocess.run(['gpui-shell','check','-d',str(app)],check=True)
    process = subprocess.Popen(['gpui-shell', 'run', '-d', str(app)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        clients = json.loads(subprocess.check_output(['hyprctl', 'clients', '-j']))
        client = next(c for c in clients if c['pid'] == process.pid)
        selector = json.dumps('address:' + client['address'])
        for dispatcher in [f'hl.dsp.window.float({{action="on",window={selector}}})', f'hl.dsp.window.resize({{x=1198,y=827,window={selector}}})', f'hl.dsp.window.center({{window={selector}}})', f'hl.dsp.window.set_prop({{prop="opacity",value="1",window={selector}}})', f'hl.dsp.window.set_prop({{prop="opacity_inactive",value="1",window={selector}}})']:
            subprocess.run(['hyprctl','dispatch',dispatcher],stdout=subprocess.DEVNULL,check=True)
        time.sleep(1)
        clients = json.loads(subprocess.check_output(['hyprctl','clients','-j']))
        client = next(c for c in clients if c['pid'] == process.pid)
        x, y = client['at']
        w, h = client['size']
        subprocess.run(['grim', '-g', f'{x},{y} {w}x{h}', str(root / 'tests/gmail-design-preview.png')], check=True)
        print('Captured tests/gmail-design-preview.png with synthetic messages.')
    finally:
        process.terminate()
        process.wait(timeout=5)
