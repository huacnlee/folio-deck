import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT, parsePalette, systemPalette } from '../lib/theme.js';
test('ANSI theme maps semantic colors and preserves square-theme fallback values',()=>{
  const palette = parsePalette('background = "#111111"\nforeground = "#eeeeee"\ncolor4 = "#2255aa"\ncolor0 = "#222222"\ncolor8 = "#555555"');
  assert.equal(palette.background,'#111111');assert.equal(palette.accent,'#2255aa');assert.equal(palette.surface,'#222222');assert.equal(palette.border,'#555555');
});
test('semantic theme overrides ANSI colors and malformed palettes reject',()=>{
  assert.equal(parsePalette('background = "#111111"\nforeground = "#eeeeee"\naccent = "#abcdef"\ncolor4 = "#2255aa"').accent,'#abcdef');
  assert.throws(()=>parsePalette('foreground = "not-color"'));
  assert.throws(()=>parsePalette('foreground = "#eeeeee"'));
});
test('invalid current theme falls back without loading stale legacy theme',async()=>{
  const paths=[];
  const palette=await systemPalette({stat:async()=>({}),readFile:async path=>{paths.push(path);return 'invalid';}},'/home/test');
  assert.equal(palette,DEFAULT);assert.deepEqual(paths,['/home/test/.local/state/omarchy/current/theme/colors.toml']);
});
test('absent current theme reads legacy location',async()=>{
  const paths=[];
  const palette=await systemPalette({stat:async()=>{throw Error('absent')},readFile:async path=>{paths.push(path);return 'background = "#111111"\nforeground = "#eeeeee"';}},'/home/test');
  assert.equal(palette.background,'#111111');assert.deepEqual(paths,['/home/test/.config/omarchy/current/theme/colors.toml']);
});

test('semantic surfaces and status roles follow the actual palette; light themes do not inherit dark surfaces', () => {
  const palette = parsePalette('background = "#131313"\nforeground = "#DEDEDE"\nlighter_background = "#1B1B1B"\nbright_foreground = "#F2F9FF"\nred = "#FF5257"');
  assert.equal(palette.surface, '#1B1B1B'); assert.equal(palette.bright, '#F2F9FF'); assert.equal(palette.danger, '#FF5257');
  const light = parsePalette('background = "#ffffff"\nforeground = "#222222"');
  assert.ok(parseInt(light.surface.slice(1, 3), 16) > 220);
  assert.ok(parseInt(light.selection.slice(1, 3), 16) > 200);
});
