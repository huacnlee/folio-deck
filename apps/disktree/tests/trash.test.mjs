import { fixture as createFixture } from "./temp.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { trash, restore, readTrash, writable } from "../lib/files.js";
const exec = promisify(execFile);
const run = async (cmd, args) => {
  try {
    return { ...(await exec(cmd, args)), code: 0 };
  } catch (e) {
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};
test("private trash preserves links, persists restore records and refuses overwrite", async () => {
  const root = await createFixture("disktree-trash-");
  try {
    const home = root + "/home",
      store = root + "/data";
    await fs.mkdir(home);
    await fs.mkdir(store);
    await fs.writeFile(home + "/target", "valuable");
    await fs.symlink(home + "/target", home + "/link");
    const deps = { fs, home, store, run, random: randomUUID, now: Date.now };
    await assert.rejects(writable(deps, home));
    await assert.rejects(writable(deps, "/"));
    const result = await trash(deps, [home + "/link"]);
    assert.equal(result.failures.length, 0);
    assert.equal(await fs.readFile(home + "/target", "utf8"), "valuable");
    const entries = await readTrash(deps);
    assert.equal(entries.length, 1);
    await fs.writeFile(home + "/link", "new");
    await assert.rejects(restore(deps, entries[0]), /already exists/);
    assert.equal(await fs.readFile(home + "/link", "utf8"), "new");
    await fs.unlink(home + "/link");
    await restore(deps, entries[0]);
    assert.equal(await fs.readlink(home + "/link"), home + "/target");
    assert.equal((await readTrash(deps)).length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
