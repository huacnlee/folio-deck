import { fixture as createFixture } from "./temp.js";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scan, treemap, parseStats, suggestions, topSuggestions } from "../lib/scan.js";
const exec = promisify(execFile);
const run = async (cmd, args) => {
  try {
    const r = await exec(cmd, args, { maxBuffer: 1024 * 1024 });
    return { ...r, code: 0 };
  } catch (e) {
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};
test("treemap preserves every area and never overlaps", () => {
  const nodes = [1, 3, 7, 11, 2, 19].map((allocated, i) => ({
    allocated,
    name: String(i),
  }));
  const rects = treemap(nodes, 733, 419);
  assert.equal(rects.length, 6);
  for (const r of rects) {
    assert.ok(
      Math.abs((r.w * r.h) / (733 * 419) - r.node.allocated / 43) < 1e-10,
    );
    assert.ok(
      r.x >= 0 && r.y >= 0 && r.x + r.w <= 733.0001 && r.y + r.h <= 419.0001,
    );
  }
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i],
        b = rects[j];
      assert.ok(
        a.x + a.w <= b.x + 1e-9 ||
          b.x + b.w <= a.x + 1e-9 ||
          a.y + a.h <= b.y + 1e-9 ||
          b.y + b.h <= a.y + 1e-9,
      );
    }
});
test("parses stat filenames with whitespace/newlines without ambiguity", () => {
  const result = parseStats(
    "some\nname\0" + "81a4\0" + "500\0" + "8\0" + "100\0" + "12\0" + "9\0" + "1\0",
  );
  assert.equal(result[0].path, "some\nname");
  assert.equal(result[0].allocated, 4096);
});
test("real scan preserves symlink boundaries, sparse bytes, hidden toggle and hardlinks", async () => {
  const fixture = await createFixture("disktree-");
  try {
    await fs.mkdir(fixture + "/target");
    await fs.writeFile(fixture + "/target/code\nfile", "abc");
    await fs.writeFile(fixture + "/.hidden", "secret");
    await fs.link(fixture + "/target/code\nfile", fixture + "/hardlink");
    await fs.symlink(fixture, fixture + "/cycle");
    const handle = await fs.open(fixture + "/sparse", "w");
    await handle.truncate(1048576);
    await handle.close();
    const deps = { fs, run };
    const result = await scan(deps, fixture);
    assert.equal(result.cancelled, false);
    assert.equal(result.errors.length, 0);
    assert.equal(result.root.files, 5);
    assert.equal(result.root.dirs, 1);
    assert.ok(result.root.size >= 1048576);
    assert.ok(result.root.allocated < result.root.size);
    assert.equal(
      result.root.children.find((n) => n.name === "cycle").link,
      true,
    );
    assert.equal(
      result.root.children.find((n) => n.name === "cycle").children.length,
      0,
    );
    assert.equal(suggestions(result.root)[0].name, "target");
    const visible = await scan(deps, fixture, { hidden: false });
    assert.equal(visible.root.files, 4);
    assert.equal(
      (await scan(deps, fixture, { cancelled: () => true })).cancelled,
      true,
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("collects outermost reclaimable folders during the scan", async () => {
  const fixture = await createFixture("disktree-reclaim-");
  try {
    await fs.mkdir(fixture + "/app/node_modules/dep/node_modules", { recursive: true });
    await fs.mkdir(fixture + "/crate/target/debug", { recursive: true });
    await fs.mkdir(fixture + "/small/dist", { recursive: true });
    await fs.writeFile(fixture + "/app/node_modules/dep/node_modules/blob", Buffer.alloc(2 * 1048576, 1));
    await fs.writeFile(fixture + "/crate/target/debug/bin", Buffer.alloc(3 * 1048576, 1));
    await fs.writeFile(fixture + "/small/dist/tiny", "x");
    const result = await scan({ fs, run }, fixture);
    const names = (nodes) => nodes.map((n) => n.path.slice(fixture.length)).sort();
    assert.deepEqual(names(result.reclaim), names(suggestions(result.root)));
    assert.deepEqual(names(result.reclaim), ["/app/node_modules", "/crate/target", "/small/dist"]);
    assert.deepEqual(topSuggestions(result.reclaim).map((n) => n.name), ["target", "node_modules"]);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("publishes correct partial totals and batches stat across small directories", async () => {
  const fixture = await createFixture("disktree-progress-");
  try {
    for (let index = 0; index < 40; index++) {
      const path = `${fixture}/folder-${index}`;
      await fs.mkdir(path);
      await fs.writeFile(path + "/one", "one");
      await fs.writeFile(path + "/two", "two");
    }
    let statCalls = 0;
    const snapshots = [];
    const deps = {
      fs,
      run: async (cmd, args) => {
        if (cmd === "stat") statCalls++;
        return run(cmd, args);
      },
    };
    const result = await scan(deps, fixture, {
      partial: (root, visited) =>
        snapshots.push({
          allocated: root.allocated,
          files: root.files,
          dirs: root.dirs,
          visited,
        }),
    });
    assert.ok(snapshots.length >= 2);
    assert.equal(snapshots[0].files, 0);
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      assert.equal(snapshot.files + snapshot.dirs, snapshot.visited);
      if (index)
        assert.ok(snapshot.allocated >= snapshots[index - 1].allocated);
    }
    assert.equal(result.root.files, 80);
    assert.equal(result.root.dirs, 40);
    assert.ok(statCalls <= 5, `used ${statCalls} stat subprocesses`);
    const du = await run("du", ["-s", "-B1", "--", fixture]);
    assert.equal(result.root.allocated, Number(du.stdout.split(/\s/)[0]));
    let cancel = false;
    const cancelled = await scan({ fs, run }, fixture, {
      partial: () => {
        cancel = true;
      },
      cancelled: () => cancel,
    });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.root.files + cancelled.root.dirs, cancelled.visited);
    assert.ok(cancelled.visited < result.visited);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
