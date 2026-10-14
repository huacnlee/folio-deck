#!/usr/bin/env python3
"""Package tracked app sources for a release, without the gpui-shell runtime."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {'tests', 'scripts', 'dist', 'target', 'node_modules', '__pycache__', '.git', 'cache'}
EXCLUDED_FILES = {'gpui-kit.d.ts', 'jsconfig.json', 'install.sh', 'screenshot.png', 'gpui-shell', 'gpui-shell.exe'}


def package_apps(tag, output):
    version = tag.removeprefix('v')
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', version):
        raise ValueError('Release tags must be semantic versions, such as v0.2.0 or v0.2.0-beta.1')
    tracked = subprocess.check_output(['git', 'ls-files', '-z', 'apps'], cwd=ROOT).decode().split('\0')
    manifests = sorted(path for path in tracked if re.fullmatch(r'apps/[^/]+/gpui-shell\.json', path))
    if not manifests:
        raise ValueError('No applications found')
    output.mkdir(parents=True, exist_ok=True)
    archives = []
    for manifest_path in manifests:
        app = Path(manifest_path).parent
        name = app.name
        manifest = json.loads((ROOT / manifest_path).read_text())
        manifest['version'] = version
        archive = output / f'{name}-{tag}.tar.gz'
        files = []
        for path in tracked:
            if not path.startswith(f'{app}/'):
                continue
            relative = Path(path).relative_to(app)
            if set(relative.parts[:-1]) & EXCLUDED_DIRS or relative.name in EXCLUDED_FILES:
                continue
            files.append((ROOT / path, relative))
        if not any(str(relative) == manifest['entry'] for _, relative in files):
            raise ValueError(f'{name}: entry module is missing from package')
        with tarfile.open(archive, 'w:gz') as bundle:
            for source, relative in files:
                if source.is_symlink():
                    raise ValueError(f'{name}: package source must not be a symbolic link: {relative}')
                data = (json.dumps(manifest, indent=2) + '\n').encode() if relative.name == 'gpui-shell.json' else source.read_bytes()
                info = tarfile.TarInfo(f'{name}/{relative.as_posix()}')
                info.size = len(data)
                info.mode = 0o644
                bundle.addfile(info, io.BytesIO(data))
            if not any(str(relative) == 'LICENSE' for _, relative in files):
                data = (ROOT / 'LICENSE').read_bytes()
                info = tarfile.TarInfo(f'{name}/LICENSE')
                info.size = len(data)
                info.mode = 0o644
                bundle.addfile(info, io.BytesIO(data))
        archives.append(archive)
        print(f'{name}: {archive.name} ({len(files)} app files)')
    checksums = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in archives)
    (output / 'SHA256SUMS').write_text(checksums)
    return archives


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    package_apps(args.tag, args.out)
