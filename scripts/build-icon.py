#!/usr/bin/env python3
"""Rasterize Folio's vector logo into Apple's standard and Retina icon sizes.

Requires rsvg-convert only when regenerating committed assets. The macOS
installer uses its built-in iconutil to package these PNGs as an .icns file.
"""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
source = root / 'forma/assets/app-icon.svg'
output = root / 'forma/assets/FolioDesk.iconset'
output.mkdir(exist_ok=True)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
        subprocess.run([
            'rsvg-convert', '-w', str(size * scale), '-h', str(size * scale),
            '-o', str(output / name), str(source),
        ], check=True)
