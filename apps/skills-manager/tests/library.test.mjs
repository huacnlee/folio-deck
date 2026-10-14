// Native filesystem operations against disposable folders.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  scanRoot, setEnabled, trashSkill, listTrash, restoreSkill, deleteForever,
  createSkill, importSkill, readSkill, fetchCatalog, installRemote,
} from "../lib/library.js";

let dir;
let clock = 1_000;
let counter = 0;
const deps = (extra = {}) => ({
  fs: nodeFs,
  store: join(dir, "store"),
  writeStore: async (relative, contents) => {
    const path = join(dir, "store", relative);
    await nodeFs.mkdir(dirname(path), { recursive: true });
    await nodeFs.writeFile(path, contents);
  },
  fetch: async () => { throw new Error("offline"); },
  now: () => ++clock,
  random: () => `r${++counter}`,
  ...extra,
});
const exists = (p) => nodeFs.lstat(p).then(() => true, () => false);

before(async () => {
  dir = await nodeFs.realpath(await nodeFs.mkdtemp(join(tmpdir(), "skills-manager-")));
  await nodeFs.mkdir(join(dir, "store"));
  await nodeFs.mkdir(join(dir, "claude/plain/assets"), { recursive: true });
  await nodeFs.writeFile(join(dir, "claude/plain/SKILL.md"), "---\nname: plain\ndescription: A plain skill\n---\nBody\n");
  await nodeFs.writeFile(join(dir, "claude/plain/assets/bin.dat"), Buffer.from([0, 1, 2, 255]));
  await nodeFs.mkdir(join(dir, "claude/not-a-skill"));
  await nodeFs.mkdir(join(dir, "claude/.hidden"));
  await nodeFs.writeFile(join(dir, "claude/README.md"), "x");
  await nodeFs.mkdir(join(dir, "agents/shared"), { recursive: true });
  await nodeFs.writeFile(join(dir, "agents/shared/SKILL.md"), "---\nname: shared\ndescription: Linked in\n---\n");
  await nodeFs.symlink("../agents/shared", join(dir, "claude/shared"));
  await nodeFs.symlink("../nowhere/gone", join(dir, "claude/broken"));
  await nodeFs.mkdir(join(dir, "imports/pick"), { recursive: true });
  await nodeFs.writeFile(join(dir, "imports/pick/SKILL.md"), "---\nname: pick\ndescription: Imported\n---\n");
  await nodeFs.symlink("pick", join(dir, "imports/pick-link"));
});
after(() => nodeFs.rm(dir, { recursive: true, force: true }));

const claude = () => ({ id: "claude", label: "Claude", path: join(dir, "claude") });
const byName = async (name, d = deps()) => (await scanRoot(d, claude())).find((s) => s.name === name);

test("scan lists folders and links with SKILL.md, with times", async () => {
  const skills = await scanRoot(deps(), claude());
  assert.deepEqual(skills.map((s) => s.dirName).sort(), ["broken", "plain", "shared"]);
  const shared = skills.find((s) => s.name === "shared");
  assert.equal(shared.linked, true);
  assert.equal(shared.dir, join(dir, "agents/shared"));
  assert.equal(shared.target, "../agents/shared");
  assert.equal(shared.description, "Linked in");
  assert.match(skills.find((s) => s.dirName === "broken").error, /Broken link/);
  assert.ok(skills.filter((s) => !s.error).every((s) => s.mtime > 0));
  assert.deepEqual(await scanRoot(deps(), { id: "x", label: "X", path: join(dir, "missing") }), []);
});

test("disable and enable rename SKILL.md reversibly", async () => {
  await setEnabled(deps(), await byName("plain"), false);
  assert.ok(await exists(join(dir, "claude/plain/SKILL.md.disabled")));
  assert.ok(!(await exists(join(dir, "claude/plain/SKILL.md"))));
  const plain = await byName("plain");
  assert.equal(plain.enabled, false);
  assert.match(await readSkill(deps(), plain), /A plain skill/);
  await setEnabled(deps(), plain, true);
  assert.ok(await exists(join(dir, "claude/plain/SKILL.md")));
});

test("uninstall moves a folder to trash intact, and restore puts it back", async () => {
  const d = deps();
  const entry = await trashSkill(d, await byName("plain"));
  assert.ok(!(await exists(join(dir, "claude/plain"))));
  assert.deepEqual((await listTrash(d)).map((e) => e.id), [entry.id]);
  await restoreSkill(d, entry);
  assert.deepEqual([...(await nodeFs.readFile(join(dir, "claude/plain/assets/bin.dat")))], [0, 1, 2, 255]);
  assert.deepEqual(await listTrash(d), []);
});

test("uninstalling a link moves only the link", async () => {
  const d = deps();
  const entry = await trashSkill(d, await byName("shared"));
  assert.ok(await exists(join(dir, "agents/shared/SKILL.md")), "the link target survives");
  assert.ok(!(await exists(join(dir, "claude/shared"))));
  await restoreSkill(d, entry);
  assert.equal(await nodeFs.readlink(join(dir, "claude/shared")), "../agents/shared");
});

test("delete forever only ever deletes inside the store", async () => {
  const d = deps();
  await createSkill(d, claude(), { name: "temp", description: "Short-lived", body: "" });
  const entry = await trashSkill(d, await byName("temp"));
  await deleteForever(d, entry);
  assert.deepEqual(await listTrash(d), []);
  await assert.rejects(deleteForever(d, { ...entry, id: "../../claude" }), /outside/);
  assert.ok(await exists(join(dir, "claude/plain/SKILL.md")));
});

test("create validates and writes SKILL.md", async () => {
  const d = deps();
  await assert.rejects(createSkill(d, claude(), { name: "Bad Name", description: "x", body: "" }), /lowercase/);
  await assert.rejects(createSkill(d, claude(), { name: "plain", description: "x", body: "" }), /already exists/);
  await createSkill(d, claude(), { name: "notes", description: "Use: when taking notes", body: "# Notes" });
  assert.equal((await byName("notes")).description, "Use: when taking notes");
  assert.deepEqual(await nodeFs.readdir(join(dir, "store/staging")), [], "staging is emptied by the move");
});

test("import copies a folder that has SKILL.md", async () => {
  const d = deps();
  await assert.rejects(importSkill(d, join(dir, "claude/not-a-skill"), claude()), /no SKILL.md/);
  await assert.rejects(importSkill(d, "relative/path", claude()), /absolute/);
  await assert.rejects(importSkill(d, join(dir, "nope"), claude()), /does not exist/);
  await importSkill(d, join(dir, "imports/pick") + "/", claude());
  assert.ok(await exists(join(dir, "claude/pick/SKILL.md")));
  await assert.rejects(importSkill(d, join(dir, "imports/pick"), claude()), /already exists/);
  await importSkill(d, join(dir, "imports/pick-link"), claude());
  assert.ok((await nodeFs.lstat(join(dir, "claude/pick-link"))).isDirectory(), "a linked source is copied as a folder");
});

test("catalog and install against a fake GitHub", async () => {
  const blob = Buffer.from([9, 8, 7]).toString("base64");
  const responses = {
    "https://api.github.com/repos/o/r": { stargazers_count: 7, pushed_at: "2026-10-01T00:00:00Z" },
    "https://api.github.com/repos/o/r/git/trees/main?recursive=1": {
      tree: [
        { path: "skills/demo/SKILL.md", type: "blob", sha: "a", size: 30 },
        { path: "skills/demo/data/font.ttf", type: "blob", sha: "b", size: 3 },
      ],
    },
    "https://raw.githubusercontent.com/o/r/main/skills/demo/SKILL.md": "---\nname: demo\ndescription: From GitHub\n---\n",
    "https://raw.githubusercontent.com/o/r/main/skills/demo/data/font.ttf": "must not be fetched as text",
    "https://api.github.com/repos/o/r/git/blobs/b": { content: blob },
  };
  const fetch = async (url) => {
    if (!(url in responses)) return { ok: false, status: 404, json: async () => ({ message: "Not Found" }), text: async () => "" };
    const value = responses[url];
    return { ok: true, status: 200, json: async () => value, text: async () => value };
  };
  const sources = [{ repo: "o/r", branch: "main", prefix: "skills/", author: "O" }, { repo: "o/missing", branch: "main", prefix: "skills/", author: "M" }];
  const d = deps({ fetch });
  const catalog = await fetchCatalog(d, sources);
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].description, "From GitHub");
  assert.equal(catalog.skills[0].stars, 7);
  assert.deepEqual(catalog.errors.map((e) => e.repo), ["o/missing"]);
  assert.match(catalog.errors[0].message, /404/);

  const dest = await installRemote(d, catalog.skills[0], claude(), sources);
  assert.match(await nodeFs.readFile(join(dest, "SKILL.md"), "utf8"), /From GitHub/);
  assert.deepEqual([...(await nodeFs.readFile(join(dest, "data/font.ttf")))], [9, 8, 7]);
  await assert.rejects(installRemote(d, catalog.skills[0], claude(), sources), /already installed/);

  // A failed download leaves nothing behind, in the agent folder or staging.
  delete responses["https://api.github.com/repos/o/r/git/blobs/b"];
  const other = { ...catalog.skills[0], dirName: "demo-two" };
  await assert.rejects(installRemote(d, other, claude(), sources), /404/);
  assert.ok(!(await exists(join(dir, "claude/demo-two"))));
  assert.deepEqual(await nodeFs.readdir(join(dir, "store/staging")), []);
});


test("catalog publishes cards before descriptions and reuses unchanged files", async () => {
  const source = { repo: "o/fast", branch: "main", prefix: "skills/", author: "O" };
  let release;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const description = new Promise((resolve) => { release = resolve; });
  let rawCalls = 0;
  const fetch = async (url) => {
    if (url.includes('raw.githubusercontent.com')) {
      rawCalls++;
      started();
      await description;
      return { ok: true, text: async () => '---\nname: Quick\ndescription: Cached description\n---\n' };
    }
    return { ok: true, json: async () => url.includes('/git/trees/')
      ? { tree: [{ path: 'skills/quick/SKILL.md', type: 'blob', sha: 'unchanged', size: 50 }] }
      : { stargazers_count: 1 } };
  };
  const snapshots = [];
  const first = fetchCatalog(deps({ fetch }), [source], undefined, (value) => snapshots.push(value));
  await waiting;
  assert.equal(snapshots[0].skills[0].dirName, 'quick');
  assert.equal(snapshots[0].skills[0].description, '');
  release();
  const catalog = await first;
  assert.equal(catalog.skills[0].description, 'Cached description');
  const refreshed = await fetchCatalog(deps({ fetch }), [source], undefined, undefined, catalog.skills);
  assert.equal(rawCalls, 1, 'unchanged descriptions require no raw download');
  assert.equal(refreshed.skills[0].description, 'Cached description');
});

test("repository requests run concurrently and a failed source keeps cached cards", async () => {
  const sources = ['one', 'two'].map((repo) => ({ repo: `o/${repo}`, branch: 'main', prefix: 'skills/', author: repo }));
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cached = [{ id: 'o/two:previous', repo: 'o/two', name: 'previous', dirName: 'previous', description: 'Saved', files: [{ path: 'SKILL.md', sha: 'old' }] }];
  const fetch = async (url) => {
    calls.push(url);
    await gate;
    if (url.includes('o/two')) throw new Error('offline');
    return { ok: true, json: async () => ({ tree: [] }) };
  };
  const pending = fetchCatalog(deps({ fetch }), sources, undefined, undefined, cached);
  assert.equal(calls.length, 4, 'both metadata and trees start for both sources');
  release();
  const result = await pending;
  assert.equal(result.skills[0].id, 'o/two:previous');
  assert.deepEqual(result.errors.map((entry) => entry.repo), ['o/two']);
});

test("an inaccessible linked entry does not prevent other skills from loading", async () => {
  const fs = { ...nodeFs, lstat: async (path) => {
    if (path.endsWith('/shared')) throw new Error('outside every granted read root');
    return nodeFs.lstat(path);
  } };
  const skills = await scanRoot(deps({ fs }), claude());
  assert.ok(skills.some((skill) => skill.name === 'plain' && !skill.error));
  assert.match(skills.find((skill) => skill.name === 'shared').error, /granted read root/);
});

test("nested import links fail without leaving a partial skill", async () => {
  await nodeFs.mkdir(join(dir, 'imports/with-link'));
  await nodeFs.writeFile(join(dir, 'imports/with-link/SKILL.md'), '---\nname: with-link\n---\n');
  await nodeFs.symlink('../pick/SKILL.md', join(dir, 'imports/with-link/linked.md'));
  await assert.rejects(importSkill(deps(), join(dir, 'imports/with-link'), claude()), /nested symbolic link/);
  assert.ok(!(await exists(join(dir, 'claude/with-link'))));
  assert.deepEqual(await nodeFs.readdir(join(dir, 'store/staging')), []);
});
