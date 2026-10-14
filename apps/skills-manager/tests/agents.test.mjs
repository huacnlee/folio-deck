import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AGENT_DIRECTORIES, rootsForHome } from '../lib/agents.js';

test('every selectable agent destination has a matching read/write grant', async () => {
  const manifest = JSON.parse(await readFile(new URL('../gpui-shell.json', import.meta.url), 'utf8'));
  const roots = rootsForHome('/test-home');
  assert.equal(new Set(roots.map((root) => root.id)).size, roots.length);
  assert.equal(new Set(roots.map((root) => root.path)).size, roots.length, 'shared directories are scanned once');
  for (const agent of AGENT_DIRECTORIES) {
    const grant = '${homeDir}/' + agent.directory;
    assert.ok(manifest.capabilities.fs.read.includes(grant), `${agent.label} is readable`);
    assert.ok(manifest.capabilities.fs.write.includes(grant), `${agent.label} is writable`);
  }
  assert.ok(!manifest.capabilities.fs.write.includes('/usr/share/omarchy/default/agents/skills'));
});
