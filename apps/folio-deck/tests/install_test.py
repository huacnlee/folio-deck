"""Exercise the real installer in a disposable tree, without changing HOME/PATH."""
import hashlib
import io
import json
import plistlib
import shutil
import struct
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = b'''#!/bin/sh
case "$1" in
  --version) echo 'gpui-shell 0.7.3' ;;
  check) test -f "$3/main.js" && ! test -f "$3/reject" || exit 1
    printf 'generated declarations\\n' > "$3/gpui-kit.d.ts" ;;
  run) printf '%s\\n' "$@" ;;
  *) exit 1 ;;
esac
'''


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='.installer-', dir=ROOT / 'tests')
        self.root = Path(self.scratch.name)
        self.bin = self.root / '.local/bin'
        self.bin.mkdir(parents=True)
        self.app = self.root / '.gpui-shell/apps/folio-mail'
        self.fake = self.root / 'mocks'
        self.fake.mkdir()
        self.source = self.root / 'source'
        self.source.mkdir()
        for file in ['main.js', 'mailbox.js', 'theme.js', 'gmail.js', 'gmail-view.js', 'avatar.js', 'oauth-callback.js', 'oauth-runtime.js', 'gpui-shell.json']:
            (self.source / file).write_text('sample')
        (self.source / 'gpui-shell.json').write_text((ROOT / 'gpui-shell.json').read_text())
        (self.source / 'forma').mkdir()
        (self.source / 'forma/icon.svg').write_text('<svg/>')
        (self.source / 'forma/assets').mkdir()
        shutil.copytree(ROOT / 'forma/assets/FolioDesk.iconset', self.source / 'forma/assets/FolioDesk.iconset')
        self.write_executable(self.fake / 'curl', '#!/bin/sh\nexit 1\n')
        self.write_executable(self.fake / 'uname', '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n')
        self.write_executable(self.fake / 'xdg-mime', '#!/bin/sh\nprintf "%s\\n" "$@" > "' + str(self.root / 'mime-call') + '"\n')
        self.write_executable(self.fake / 'update-desktop-database', '#!/bin/sh\nexit 0\n')
        self.script = self.root / 'install.sh'
        source = (ROOT / 'install.sh').read_text().replace('~/', str(self.root) + '/')
        for name in ['uname', 'xdg-mime', 'update-desktop-database', 'curl']:
            source = source.replace(name + ' ', '"' + str(self.fake / name) + '" ')
        self.script.write_text(source)
        self.write_executable(self.bin / 'gpui-shell', RUNTIME)

    def tearDown(self):
        self.scratch.cleanup()

    @staticmethod
    def write_executable(path, content):
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        path.chmod(0o755)

    def run_installer(self, *arguments):
        return subprocess.run(['sh', str(self.script), '--app-source', str(self.source), *arguments], capture_output=True, text=True)

    def test_install_reinstall_and_literal_uri_validation(self):
        for _ in range(2):
            result = self.run_installer()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.app / 'main.js').is_file())
        self.assertTrue((self.app / 'oauth-callback.js').is_file())
        executable = json.loads((self.app / 'gpui-shell.json').read_text())['capabilities']['fs']['execute'][0]
        self.assertTrue(Path(executable).is_absolute())
        self.assertIn(executable, (self.app / 'oauth-runtime.js').read_text())
        self.assertIn('x-scheme-handler/folio-mail', (self.root / 'mime-call').read_text())
        desktop = (self.root / '.local/share/applications/folio-mail.desktop').read_text()
        self.assertIn(' %u', desktop)
        self.assertIn('Terminal=false', desktop)
        launcher = self.bin / 'folio-mail'
        for uri in ['folio-mail://open', 'folio-mail://open/']:
            result = subprocess.run([str(launcher), uri], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(str(self.app), result.stdout)
        for uri in ['https://example.com', 'folio-mail://open;touch marker', 'folio-mail://other']:
            self.assertEqual(subprocess.run([str(launcher), uri], capture_output=True).returncode, 2)
        self.assertEqual(subprocess.run([str(launcher), 'folio-mail://open', 'extra'], capture_output=True).returncode, 2)
        self.assertEqual(list((self.root / '.gpui-shell').glob('.folio-install.*')), [])

    def test_invalid_app_keeps_existing_installation(self):
        self.assertEqual(self.run_installer().returncode, 0)
        (self.app / 'main.js').write_text('previous working app')
        self.write_executable(self.bin / 'gpui-shell', RUNTIME.replace(b'check) test -f', b'check) exit 1; test -f'))
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual((self.app / 'main.js').read_text(), 'previous working app')

    def test_linked_installation_is_preserved(self):
        self.app.parent.mkdir(parents=True)
        self.app.symlink_to(self.source)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Refusing to replace', result.stderr)
        self.assertTrue(self.app.is_symlink())

    def prepare_release(self, corrupt=False, target='x86_64-unknown-linux-gnu'):
        (self.bin / 'gpui-shell').unlink()
        name = f'gpui-shell-{target}.tar.gz'
        archive = self.root / name
        with tarfile.open(archive, 'w:gz') as bundle:
            info = tarfile.TarInfo(f'gpui-shell-{target}/gpui-shell')
            info.size = len(RUNTIME)
            info.mode = 0o755
            bundle.addfile(info, io.BytesIO(RUNTIME))
        digest = '0' * 64 if corrupt else hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.root / (name + '.sha256')).write_text(digest + '  ' + name + '\n')
        self.write_executable(self.fake / 'curl', f'''#!/bin/sh
url=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    https:*) url="$1"; shift ;;
    -o) output="$2"; shift 2 ;;
    --retry) shift 2 ;;
    *) shift ;;
  esac
done
case "$url" in
  *.sha256) cp "{self.root / (name + '.sha256')}" "$output" ;;
  *.tar.gz) cp "{archive}" "$output" ;;
  *) exit 1 ;;
esac
''')

    def configure_macos(self, arch='arm64'):
        self.write_executable(self.fake / 'uname', f'#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo {arch};; esac\n')
        self.write_executable(self.fake / 'osacompile', '''#!/usr/bin/env python3
import pathlib, plistlib, shutil, sys
bundle = pathlib.Path(sys.argv[2])
(bundle / 'Contents/MacOS').mkdir(parents=True)
(bundle / 'Contents/Resources/Scripts').mkdir(parents=True)
(bundle / 'Contents/MacOS/applet').write_text('mock native AppleScript executable')
(bundle / 'Contents/MacOS/applet').chmod(0o755)
with (bundle / 'Contents/Info.plist').open('wb') as handle:
    plistlib.dump({'CFBundleIdentifier': 'com.apple.ScriptEditor.id', 'CFBundleExecutable': 'applet', 'CFBundlePackageType': 'APPL', 'CFBundleIconFile': 'applet', 'CFBundleIconName': 'applet'}, handle)
(bundle / 'Contents/Resources/Assets.car').write_text('default AppleScript icon catalog')
shutil.copyfile(sys.argv[3], bundle / 'Contents/Resources/Scripts/main.scpt')
''')
        self.write_executable(self.fake / 'iconutil', '''#!/usr/bin/env python3
import pathlib, struct, sys
source = pathlib.Path(sys.argv[3])
output = pathlib.Path(sys.argv[5])
payload = b''
for image in sorted(source.glob('*.png')):
    png = image.read_bytes()
    payload += b'ic10' + struct.pack('>I', len(png) + 8) + png
output.write_bytes(b'icns' + struct.pack('>I', len(payload) + 8) + payload)
''')
        self.write_executable(self.fake / 'PlistBuddy', '''#!/usr/bin/env python3
import pathlib, plistlib, sys
command = sys.argv[2].split(' ', 3)
path = pathlib.Path(sys.argv[3])
with path.open('rb') as handle:
    data = plistlib.load(handle)
try:
    keys = command[1].strip(':').split(':')
    parent = data
    for key in keys[:-1]:
        parent = parent[int(key)] if isinstance(parent, list) else parent[key]
    key = int(keys[-1]) if isinstance(parent, list) else keys[-1]
    exists = key < len(parent) if isinstance(parent, list) else key in parent
    if command[0] == 'Print':
        print(parent[key])
        sys.exit(0)
    if command[0] == 'Delete':
        del parent[key]
    else:
        if command[0] == 'Set' and not exists: sys.exit(1)
        if command[0] == 'Add' and exists: sys.exit(1)
        if command[0] == 'Set':
            value = ' '.join(command[2:])
        else:
            kind = command[2]
            value = [] if kind == 'array' else {} if kind == 'dict' else command[3]
        if isinstance(parent, list) and key == len(parent): parent.append(value)
        else: parent[key] = value
    with path.open('wb') as handle:
        plistlib.dump(data, handle)
except (KeyError, IndexError):
    sys.exit(1)
''')
        self.write_executable(self.fake / 'codesign', f'''#!/usr/bin/env python3
import hashlib, json, pathlib, sys
root = pathlib.Path({str(self.root)!r})
with (root / 'sign-calls').open('a') as handle:
    handle.write(' '.join(sys.argv[1:]) + '\\n')
if (root / 'sign-fail').exists(): sys.exit(1)
bundle = pathlib.Path(sys.argv[-1])
seal = bundle / 'Contents/_CodeSignature/mock-seal.json'
files = {{str(p.relative_to(bundle)): hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.rglob('*') if p.is_file() and '_CodeSignature' not in p.parts}}
if '--verify' in sys.argv:
    sys.exit(0 if json.loads(seal.read_text()) == files else 1)
seal.parent.mkdir(exist_ok=True)
seal.write_text(json.dumps(files))
''')
        self.write_executable(self.fake / 'lsregister', f'#!/bin/sh\nprintf "%s\\n" "$@" > "{self.root / "registered-app"}"\n')
        self.write_executable(self.fake / 'open', '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        source = self.script.read_text()
        source = source.replace('for utility in osacompile codesign iconutil;', f'for utility in "{self.fake / "osacompile"}" "{self.fake / "codesign"}" "{self.fake / "iconutil"}";')
        for name in ['osacompile', 'codesign', 'iconutil']:
            source = source.replace('  ' + name + ' ', '  "' + str(self.fake / name) + '" ')
        source = source.replace('/usr/libexec/PlistBuddy', '"' + str(self.fake / 'PlistBuddy') + '"')
        source = source.replace('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', '"' + str(self.fake / 'lsregister') + '"')
        source = source.replace('/usr/bin/open', '"' + str(self.fake / 'open') + '"')
        self.script.write_text(source)
        return self.root / 'Applications/Folio Desk.app'

    def test_app_icon_has_all_standard_and_retina_sizes(self):
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
                png = (ROOT / 'forma/assets/FolioDesk.iconset' / name).read_bytes()
                self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
                self.assertEqual(struct.unpack('>II', png[16:24]), (size * scale, size * scale))

    def test_macos_bundle_contains_runtime_resources_and_existing_plist_keys(self):
        bundle = self.configure_macos()
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        with (bundle / 'Contents/Info.plist').open('rb') as handle:
            plist = plistlib.load(handle)
        self.assertEqual(plist['CFBundleIdentifier'], 'com.folio.desk')
        self.assertEqual(plist['CFBundleExecutable'], 'applet')
        self.assertEqual(plist['CFBundleIconFile'], 'FolioDesk.icns')
        self.assertNotIn('CFBundleIconName', plist)
        self.assertFalse((bundle / 'Contents/Resources/Assets.car').exists())
        self.assertEqual((bundle / 'Contents/Resources/FolioDesk.icns').read_bytes()[:4], b'icns')
        self.assertEqual(plist['CFBundleURLTypes'][0]['CFBundleURLSchemes'], ['folio-mail'])
        self.assertEqual((bundle / 'Contents/MacOS/gpui-shell').read_bytes(), RUNTIME)
        self.assertTrue((bundle / 'Contents/Resources/app/main.js').is_file())
        self.assertTrue((bundle / 'Contents/Resources/app/forma/icon.svg').is_file())
        script = (bundle / 'Contents/Resources/Scripts/main.scpt').read_text()
        self.assertIn('path to me', script)
        self.assertIn('Contents/MacOS/gpui-shell', script)
        self.assertIn('Contents/Resources/app', script)
        self.assertNotIn('.local/bin', script)
        self.assertIn('--verify', (self.root / 'sign-calls').read_text())
        self.assertIn(str(bundle), (self.root / 'registered-app').read_text())
        # Finder's app does not depend on the separately installed shell or app.
        (self.bin / 'gpui-shell').unlink()
        self.assertFalse(self.app.exists())
        result = subprocess.run([str(self.bin / 'folio-mail'), 'folio-mail://open'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), str(bundle))
        result = subprocess.run([str(bundle / 'Contents/MacOS/gpui-shell'), 'check', '-d', str(bundle / 'Contents/Resources/app')])
        self.assertEqual(result.returncode, 0)

    def test_macos_reinstall_upgrades_old_launcher_and_failed_signing_keeps_app(self):
        bundle = self.configure_macos('x86_64')
        self.assertEqual(self.run_installer().returncode, 0)
        plist_path = bundle / 'Contents/Info.plist'
        with plist_path.open('rb') as handle: plist = plistlib.load(handle)
        plist['CFBundleIdentifier'] = 'com.folio.mail.launcher'
        with plist_path.open('wb') as handle: plistlib.dump(plist, handle)
        self.assertEqual(self.run_installer().returncode, 0)
        (bundle / 'marker').write_text('previous app')
        (self.root / 'sign-fail').touch()
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual((bundle / 'marker').read_text(), 'previous app')

    def test_macos_preserves_unrelated_application(self):
        bundle = self.configure_macos()
        (bundle / 'Contents').mkdir(parents=True)
        with (bundle / 'Contents/Info.plist').open('wb') as handle:
            plistlib.dump({'CFBundleIdentifier': 'com.example.unrelated'}, handle)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unrelated Folio Desk.app', result.stderr)
        with (bundle / 'Contents/Info.plist').open('rb') as handle:
            self.assertEqual(plistlib.load(handle)['CFBundleIdentifier'], 'com.example.unrelated')

    def test_macos_architectures_download_the_correct_runtime(self):
        for arch, target in [('arm64', 'aarch64-apple-darwin'), ('x86_64', 'x86_64-apple-darwin')]:
            with self.subTest(arch=arch):
                bundle = self.configure_macos(arch)
                self.prepare_release(target=target)
                result = self.run_installer()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual((bundle / 'Contents/MacOS/gpui-shell').read_bytes(), RUNTIME)

    def test_remote_app_archive_installs_without_git(self):
        archive = self.root / 'mail.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            bundle.add(self.source, arcname='gpui-shell-benchs-main/apps/folio-deck')
        self.write_executable(self.fake / 'curl', f'''#!/bin/sh
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --retry) shift 2 ;;
    *) shift ;;
  esac
done
cp "{archive}" "$output"
''')
        result = subprocess.run(['sh', str(self.script)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.app / 'mailbox.js').is_file())

    def test_unsupported_architecture_fails_before_installing(self):
        self.write_executable(self.fake / 'uname', '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo aarch64;; esac\n')
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('x86_64 only', result.stderr)
        self.assertFalse(self.app.exists())

    def test_runtime_download_is_verified_before_install(self):
        self.prepare_release()
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.bin / 'gpui-shell').read_bytes(), RUNTIME)

    def test_bad_checksum_installs_neither_runtime_nor_app(self):
        self.prepare_release(corrupt=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.bin / 'gpui-shell').exists())
        self.assertFalse(self.app.exists())


if __name__ == '__main__':
    unittest.main()
