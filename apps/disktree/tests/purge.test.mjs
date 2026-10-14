import { fixture as createFixture } from "./temp.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { trash, readTrash, estimateTrash, purgeTrash } from "../lib/files.js";
const exec = promisify(execFile);
const run = async (cmd, args) => {
  try {
    return { ...(await exec(cmd, args)), code: 0 };
  } catch (e) {
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};
test("permanent purge releases owned allocated blocks and leaves nested link targets untouched", async () => {
  const root = await createFixture("disktree-purge-");
  try {
    const home = root + "/home",
      store = root + "/data";
    await fs.mkdir(home);
    await fs.mkdir(store);
    await fs.writeFile(home + "/outside", Buffer.alloc(1048576, 12));
    await fs.mkdir(home + "/owned");
    await fs.writeFile(home + "/owned/data", Buffer.alloc(1048576, 7));
    await fs.symlink(home + "/outside", home + "/owned/link");
    const deps = { fs, home, store, run, random: randomUUID, now: Date.now };
    const staged = await trash(deps, [home + "/owned"]);
    assert.equal(staged.failures.length, 0);
    const entries = await readTrash(deps);
    const allocated = await estimateTrash(deps, entries);
    assert.ok(allocated >= 1048576);
    const result = await purgeTrash(deps, entries);
    assert.equal(result.removed.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal((await readTrash(deps)).length, 0);
    await assert.rejects(fs.stat(store + "/trash/" + entries[0].id), {
      code: "ENOENT",
    });
    assert.equal((await fs.stat(home + "/outside")).size, 1048576);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("purge rejects traversal, corrupt metadata and symbolic link records before deleting anything", async () => {
  const root = await createFixture("disktree-purge-guards-");
  try {
    const home = root + "/home",
      store = root + "/data";
    await fs.mkdir(home);
    await fs.mkdir(store);
    await fs.mkdir(home + "/owned");
    await fs.writeFile(home + "/owned/keep", "safe");
    const deps = { fs, home, store, run, random: randomUUID, now: Date.now };
    await trash(deps, [home + "/owned"]);
    const entries = await readTrash(deps),
      entry = entries[0],
      record = store + "/trash/" + entry.id,
      meta = record + "/entry.json";
    const saved = await fs.readFile(meta, "utf8");
    for (const id of ["../", "..", "../../home", "x/y", "not-a-uuid", ""])
      await assert.rejects(purgeTrash(deps, [{ id }]));
    assert.equal(await fs.readFile(record + "/item/keep", "utf8"), "safe");
    await fs.writeFile(
      meta,
      JSON.stringify({ ...JSON.parse(saved), id: randomUUID() }),
    );
    await assert.rejects(purgeTrash(deps, entries), /record/);
    assert.equal(await fs.readFile(record + "/item/keep", "utf8"), "safe");
    await fs.writeFile(meta, "{invalid");
    await assert.rejects(purgeTrash(deps, entries));
    assert.equal(await fs.readFile(record + "/item/keep", "utf8"), "safe");
    await fs.writeFile(meta, saved);
    const linked = randomUUID();
    await fs.symlink(record, store + "/trash/" + linked);
    await assert.rejects(purgeTrash(deps, [{ id: linked }]), /symbolic link/);
    assert.equal(await fs.readFile(record + "/item/keep", "utf8"), "safe");
    await fs.unlink(meta);
    await fs.writeFile(home + "/metadata", saved);
    await fs.symlink(home + "/metadata", meta);
    await assert.rejects(purgeTrash(deps, entries), /metadata/);
    assert.equal(await fs.readFile(record + "/item/keep", "utf8"), "safe");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
