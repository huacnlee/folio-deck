import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join as nodeJoin } from 'node:path';
import { normalize, inside, resolvePath, readDirectory, visibleEntries, naturalCompare, formatSize, validName, newFolder, rename, transfer, trash, readTrash, restore, preview, writable } from '../lib/files.js';
let root, deps;
const run = (name, args) => new Promise((resolve) => execFile(name, args, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr })));
before(async () => {
  const temp = nodeJoin(homedir(), '.cache/gpui-shell-benchs-test-tmp');
  await fs.mkdir(temp, { recursive: true });
  root = await fs.mkdtemp(nodeJoin(temp, 'finder-'));
  const home = nodeJoin(root, 'home'), store = nodeJoin(root, 'store');
  await fs.mkdir(home); await fs.mkdir(store);
  deps = { fs, home, store, run, random: randomUUID, now: () => 10000 };
});
after(() => fs.rm(root, { recursive: true, force: true }));
const folder = async (name) => { const path = nodeJoin(deps.home, name); await fs.mkdir(path); return path; };
test('paths normalize home/relative navigation, and reject invalid names', () => {
  assert.equal(normalize('/a/./b/../c'), '/a/c');
  assert.equal(resolvePath('~/Downloads', '/', '/home/me'), '/home/me/Downloads');
  assert.equal(resolvePath('../other', '/home/me/docs', '/home/me'), '/home/me/other');
  assert.equal(inside('/home/other', '/home/me'), false);
  assert.equal(inside('/home/me', '/'), true);
  for (const name of ['', '..', '.', 'a/b', 'a\0b']) assert.throws(() => validName(name));
  assert.equal(validName('a\n猫.txt'), 'a\n猫.txt');
  assert.equal(formatSize(1536), '1.5 KB');
});
test('real directory metadata, hidden files, natural sort and name search', async () => {
  const dir = await folder('browse');
  await fs.mkdir(nodeJoin(dir, 'z-folder'));
  for (const name of ['file10.txt', 'file2.txt', '.secret', '猫\nnotes.md']) await fs.writeFile(nodeJoin(dir, name), 'abc');
  const entries = await readDirectory(fs, dir);
  assert.equal(entries.length, 5);
  assert.ok(entries.every((entry) => entry.modified > 0));
  const visible = visibleEntries(entries);
  assert.equal(visible[0].name, 'z-folder');
  assert.ok(visible.findIndex((entry) => entry.name === 'file2.txt') < visible.findIndex((entry) => entry.name === 'file10.txt'));
  assert.equal(visibleEntries(entries, { hidden: true }).length, 5);
  assert.equal(visibleEntries(entries, { query: '猫 notes' })[0].name, '猫\nnotes.md');
});
test('create and rename affect real files without overwriting collisions', async () => {
  const dir = await folder('names');
  const created = await newFolder(deps, dir, 'New folder');
  assert.ok((await fs.stat(created)).isDirectory());
  await assert.rejects(newFolder(deps, dir, 'New folder'));
  const changed = await rename(deps, created, 'Renamed');
  assert.ok((await fs.stat(changed)).isDirectory());
  await fs.writeFile(nodeJoin(dir, 'existing'), 'keep');
  await assert.rejects(rename(deps, changed, 'existing'), /already exists/);
  assert.equal(await fs.readFile(nodeJoin(dir, 'existing'), 'utf8'), 'keep');
});
test('copy preserves arbitrary filenames, binary bytes and nested symlinks', async () => {
  const dir = await folder('copy-source'), dest = await folder('copy-destination');
  await fs.mkdir(nodeJoin(dir, 'bundle'));
  await fs.writeFile(nodeJoin(dir, 'bundle/猫\nfile.dat'), new Uint8Array([0, 255, 1, 128]));
  await fs.symlink('猫\nfile.dat', nodeJoin(dir, 'bundle/link'));
  const result = await transfer(deps, [nodeJoin(dir, 'bundle')], dest, false);
  assert.equal(result.finished.length, 1); assert.deepEqual(result.failures, []);
  assert.deepEqual(await fs.readFile(nodeJoin(dest, 'bundle/猫\nfile.dat')), Buffer.from([0, 255, 1, 128]));
  assert.equal(await fs.readlink(nodeJoin(dest, 'bundle/link')), '猫\nfile.dat');
  assert.equal(await fs.readlink(nodeJoin(dir, 'bundle/link')), '猫\nfile.dat');
  assert.deepEqual(await fs.readdir(dest), ['bundle']);
});
test('partial move reports conflicts and preserves both existing files and failed sources', async () => {
  const dir = await folder('move-source'), dest = await folder('move-destination');
  await fs.writeFile(nodeJoin(dir, 'one'), 'new'); await fs.writeFile(nodeJoin(dir, 'two'), 'two');
  await fs.writeFile(nodeJoin(dest, 'one'), 'old');
  const result = await transfer(deps, [nodeJoin(dir, 'one'), nodeJoin(dir, 'two')], dest, true);
  assert.equal(result.finished.length, 1); assert.equal(result.failures.length, 1);
  assert.equal(await fs.readFile(nodeJoin(dest, 'one'), 'utf8'), 'old');
  assert.equal(await fs.readFile(nodeJoin(dir, 'one'), 'utf8'), 'new');
  assert.equal(await fs.readFile(nodeJoin(dest, 'two'), 'utf8'), 'two');
});
test('self-copy and a destination link into the source are refused', async () => {
  const dir = await folder('self-copy'); await fs.mkdir(nodeJoin(dir, 'child'));
  await fs.symlink(nodeJoin(dir, 'child'), nodeJoin(deps.home, 'alias'));
  for (const dest of [nodeJoin(dir, 'child'), nodeJoin(deps.home, 'alias')]) {
    const result = await transfer(deps, [dir], dest, false);
    assert.equal(result.finished.length, 0); assert.match(result.failures[0].message, /inside itself/);
  }
  assert.deepEqual(await fs.readdir(nodeJoin(dir, 'child')), []);
});
test('parents pointing outside the writable home and protected locations are refused', async () => {
  const outside = nodeJoin(root, 'outside'); await fs.mkdir(outside);
  const link = nodeJoin(deps.home, 'outside-link'); await fs.symlink(outside, link);
  await assert.rejects(newFolder(deps, link, 'forbidden'), /outside your home/);
  await assert.rejects(writable(deps, deps.home), /cannot be changed/);
  await assert.rejects(writable(deps, deps.store), /cannot be changed/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('trash records survive reopen, restore refuses conflicts and preserves link targets', async () => {
  const dir = await folder('trash-source'); const path = nodeJoin(dir, 'notes.txt');
  await fs.writeFile(path, 'original');
  const result = await trash(deps, [path]);
  assert.equal(result.entries.length, 1); assert.equal(result.failures.length, 0);
  let entry = (await readTrash(deps)).find((entry) => entry.originalPath === path);
  assert.ok(entry); assert.equal(await fs.readFile(entry.path, 'utf8'), 'original');
  await fs.writeFile(path, 'replacement');
  await assert.rejects(restore(deps, entry), /already exists/);
  assert.equal(await fs.readFile(path, 'utf8'), 'replacement');
  await fs.unlink(path); await restore(deps, entry);
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
  assert.equal((await readTrash(deps)).length, 0);
  const linked = nodeJoin(dir, 'link'); await fs.symlink('notes.txt', linked);
  await trash(deps, [linked]); entry = (await readTrash(deps))[0];
  assert.ok(entry, 'a link dangling in the trash is still restorable');
  await restore(deps, entry);
  assert.equal(await fs.readlink(linked), 'notes.txt');
  assert.equal(await fs.readFile(path, 'utf8'), 'original');
});
test('text previews are bounded and binary/large files remain external opens', async () => {
  const dir = await folder('preview'); const path = nodeJoin(dir, 'notes.md');
  await fs.writeFile(path, 'x'.repeat(13000));
  const result = await preview(fs, { path, name: 'notes.md', size: 13000, type: 'Document' });
  assert.equal(result.text.length, 12000); assert.equal(result.truncated, true);
  assert.equal(result.kind, 'markdown');
  await fs.writeFile(nodeJoin(dir, 'notes.txt'), 'plain');
  assert.equal((await preview(fs, { path: nodeJoin(dir, 'notes.txt'), name: 'notes.txt', size: 5 })).kind, 'text');
  assert.equal((await preview(fs, { path, name: 'large.txt', size: 3 * 1024 * 1024 })).kind, 'info');
  await fs.writeFile(nodeJoin(dir, 'binary.dat'), Uint8Array.from([0x89, 0x50, 0, 0, 0xff]));
  assert.equal((await preview(fs, { path: nodeJoin(dir, 'binary.dat'), name: 'binary.dat', size: 5 })).kind, 'info');
  await fs.writeFile(nodeJoin(dir, 'LICENSE-APACHE'), 'Apache License');
  assert.equal((await preview(fs, { path: nodeJoin(dir, 'LICENSE-APACHE'), name: 'LICENSE-APACHE', size: 14 })).text, 'Apache License');
});

test('natural sorting does not depend on host Intl and handles long numeric suffixes', () => {
  assert.deepEqual(['part10', 'part2', 'part02', 'part1'].sort(naturalCompare), ['part1', 'part2', 'part02', 'part10']);
  assert.ok(naturalCompare('part999999999999999999999', 'part1000000000000000000000') < 0);
});
