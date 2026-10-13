#!/usr/bin/env node
// Installs Skills into ~/.gpui-shell/apps/skills-manager with access to this
// machine's agent skill folders.
//
// gpui-shell 0.7.3 limits `fs` to the app's own folder and data folder (fs
// roots elsewhere in a manifest are replaced at launch), so Skills reaches agent
// folders through allowlisted commands instead. Which folders exist, and where
// gpui-shell keeps app data, differ per machine: this script copies the app and
// writes the installed copy's manifest and roots.js for this one.
//
//   node scripts/install.mjs [--dest <dir>] [--import-dir <dir>]... [--dry-run]

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const args = process.argv.slice(2);
let dest = join(home, ".gpui-shell/apps/skills-manager");
const importDirs = [];
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dest") dest = resolve(args[++i]);
  else if (args[i] === "--import-dir") importDirs.push(resolve(args[++i]));
  else if (args[i] === "--dry-run") dryRun = true;
  else {
    console.error(`unknown argument ${args[i]}`);
    process.exit(2);
  }
}

const isDir = (path) => stat(path).then((s) => s.isDirectory(), () => false);

const candidates = [
  { id: "claude", label: "Claude", path: join(home, ".claude/skills") },
  { id: "codex", label: "Codex", path: join(home, ".codex/skills") },
  { id: "agents", label: "Agents", path: join(home, ".agents/skills") },
];
const roots = [];
for (const root of candidates) if (await isDir(root.path)) roots.push(root);
if (importDirs.length === 0 && (await isDir(join(home, "Downloads")))) importDirs.push(join(home, "Downloads"));

const manifest = JSON.parse(await readFile(join(app, "gpui-shell.json"), "utf8"));
manifest.capabilities.fs = {
  read: ["${dataDir}"],
  write: ["${dataDir}"],
  // ls/stat/cat read agent folders; mkdir/mv/cp move skills in and out (the
  // trash is a move, never a delete); rm only ever runs inside the app's data
  // folder (lib/library.js refuses any other path); find locates that folder.
  execute: ["ls", "stat", "cat", "mkdir", "mv", "cp", "rm", "find"],
};
const dataHome = process.env.XDG_DATA_HOME
  || (process.platform === "darwin" ? join(home, "Library/Application Support") : join(home, ".local/share"));

const rootsModule = `// Written by scripts/install.mjs for this machine.
export const agentRoots = ${JSON.stringify(roots, null, 2)};
export const importRoots = ${JSON.stringify(importDirs, null, 2)};
export const home = ${JSON.stringify(home)};
export const dataHome = ${JSON.stringify(dataHome)};
`;

console.log(`Installing Skills to ${dest}`);
for (const root of candidates) console.log(`  ${roots.includes(root) ? "grant" : "skip "} ${root.path}`);
for (const dir of importDirs) console.log(`  read  ${dir} (import source)`);
if (dryRun) process.exit(0);

if (await isDir(dest)) {
  const existing = await readFile(join(dest, "gpui-shell.json"), "utf8").then(JSON.parse, () => null);
  if (existing?.id !== manifest.id) {
    console.error(`${dest} exists and is not a Skills install; refusing to replace it.`);
    process.exit(1);
  }
  await rm(dest, { recursive: true });
}
await mkdir(dest, { recursive: true });
for (const entry of ["main.js", "theme.js", "ui.js", "lib", "skills-manager", "jsconfig.json"]) {
  await cp(join(app, entry), join(dest, entry), { recursive: true });
}
await writeFile(join(dest, "gpui-shell.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(dest, "roots.js"), rootsModule);
console.log("Done. Run it with: gpui-shell run skills-manager");
