"""Exercise the real installer in a disposable tree, without changing HOME/PATH."""
import hashlib
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = b'''#!/bin/sh
case "$1" in
  --version) echo 'gpui-shell 0.7.3' ;;
  check) test -f "$3/main.js" && ! test -f "$3/reject" ;;
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
        for file in ['main.js', 'mailbox.js', 'theme.js', 'gpui-shell.json']:
            (self.source / file).write_text('sample')
        (self.source / 'forma').mkdir()
        (self.source / 'forma/icon.svg').write_text('<svg/>')
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
        self.write_executable(self.bin / 'gpui-shell', RUNTIME.replace(b'test -f "$3/main.js" && ! test -f "$3/reject"', b'exit 1'))
        self.assertNotEqual(self.run_installer().returncode, 0)
        self.assertEqual((self.app / 'main.js').read_text(), 'previous working app')

    def test_linked_installation_is_preserved(self):
        self.app.parent.mkdir(parents=True)
        self.app.symlink_to(self.source)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Refusing to replace', result.stderr)
        self.assertTrue(self.app.is_symlink())

    def prepare_release(self, corrupt=False):
        (self.bin / 'gpui-shell').unlink()
        name = 'gpui-shell-x86_64-unknown-linux-gnu.tar.gz'
        archive = self.root / name
        with tarfile.open(archive, 'w:gz') as bundle:
            info = tarfile.TarInfo('gpui-shell-x86_64-unknown-linux-gnu/gpui-shell')
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

    def test_remote_app_archive_installs_without_git(self):
        archive = self.root / 'mail.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            bundle.add(self.source, arcname='gpui-shell-mail-example-main')
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
