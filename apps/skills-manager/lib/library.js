// @ts-check
// Everything that reads or changes skills on disk or fetches them from GitHub.
//
// gpui-shell 0.7.3 grants `fs` access only inside the application's own
// directory and its data directory (manifest fs roots elsewhere are replaced at
// launch), so agent folders are reached through a short allowlist of system
// commands — `ls`, `stat`, `cat`, `mkdir`, `mv`, `cp`, `ln`, `rm`, `find` —
// and file contents are written with `fs` into the data directory first, then
// moved into place. The commands, the data directory writer and fetch are
// passed in, so `node --test` runs this same code against a temporary folder.

import { Buffer } from "buffer";
import { parseFrontmatter, serializeSkill, validateSkillName } from "./frontmatter.js";
import { skillsInTree, isTextFile } from "./catalog.js";
import { statArgs, parseStat, resolveLink, normalize, isInside } from "./stat.js";

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} RunResult
 * @typedef {{
 *   run: (command: string, args: string[]) => Promise<RunResult>,
 *   platform: string,
 *   store: string,
 *   writeStore: (relative: string, contents: string | Uint8Array) => Promise<void>,
 *   fetch: (url: string, options?: any) => Promise<{ ok: boolean, status: number, text(): Promise<string>, json(): Promise<any> }>,
 *   now: () => number,
 *   random: () => string,
 * }} Deps
 * @typedef {{ id: string, label: string, path: string }} Root
 * @typedef {import("./catalog.js").LocalSkill} LocalSkill
 * @typedef {import("./catalog.js").RemoteSkill} RemoteSkill
 * @typedef {import("./catalog.js").Source} Source
 */

export const SKILL_FILE = "SKILL.md";
export const DISABLED_FILE = "SKILL.md.disabled";
const MAX_INSTALL_BYTES = 20 * 1024 * 1024;

/** @param {string} a @param {string} b */
export const join = (a, b) => (a.endsWith("/") ? a + b : `${a}/${b}`);
/** @param {string} path */
const parentOf = (path) => normalize(path).split("/").slice(0, -1).join("/") || "/";

/** @param {unknown} error */
export const reason = (error) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Command-backed file operations
// ---------------------------------------------------------------------------

/** Runs a command and throws its stderr when it fails. */
async function must(/** @type {Deps} */ deps, /** @type {string} */ command, /** @type {string[]} */ args) {
  const out = await deps.run(command, args);
  if (out.code !== 0) throw new Error(out.stderr.trim().replace(/^\S+: /, "") || `${command} exited with ${out.code}`);
  return out;
}

/** Whether a path exists. `follow` follows a final link, as reading would. */
export async function exists(/** @type {Deps} */ deps, /** @type {string} */ path, follow = true) {
  const out = await deps.run("stat", follow ? ["-L", path] : [path]);
  return out.code === 0;
}

/** lstat-style facts about several paths, keyed by path. */
async function statPaths(/** @type {Deps} */ deps, /** @type {string[]} */ paths, follow = false) {
  if (paths.length === 0) return new Map();
  const out = await deps.run("stat", statArgs(deps.platform, paths, { follow }));
  return parseStat(deps.platform, out.stdout);
}

/** A folder's entries with their kind, link target and time. */
export async function list(/** @type {Deps} */ deps, /** @type {string} */ dir) {
  const out = await deps.run("ls", ["-1A", dir]);
  if (out.code !== 0) {
    if (!(await exists(deps, dir))) return [];
    throw new Error(out.stderr.trim() || `cannot list ${dir}`);
  }
  const names = out.stdout.split("\n").filter(Boolean);
  const stats = await statPaths(deps, names.map((name) => join(dir, name)));
  return names.map((name) => {
    const path = join(dir, name);
    const stat = stats.get(path);
    return { name, path, kind: stat?.kind ?? "other", target: stat?.target ?? "", mtime: stat?.mtime ?? 0 };
  });
}

/** @param {Deps} deps @param {string} path */
export async function readText(deps, path) {
  return (await must(deps, "cat", [path])).stdout;
}

/** Moves a file, folder or link; the destination must not exist. */
async function move(/** @type {Deps} */ deps, /** @type {string} */ from, /** @type {string} */ to) {
  if (await exists(deps, to, false)) throw new Error(`${to} already exists.`);
  await must(deps, "mkdir", ["-p", parentOf(to)]);
  await must(deps, "mv", [from, to]);
}

/**
 * Removes a tree, but only inside the app's own data directory: nothing in an
 * agent folder is ever deleted, only moved to the trash.
 */
async function removeInStore(/** @type {Deps} */ deps, /** @type {string} */ path) {
  if (!deps.store || !isInside(path, deps.store) || normalize(path) === normalize(deps.store)) {
    throw new Error(`refusing to delete ${path} outside the app's data folder`);
  }
  await must(deps, "rm", ["-rf", path]);
}

/** Writes files into a fresh staging folder in the data directory. */
async function stage(/** @type {Deps} */ deps, /** @type {(write: (path: string, contents: string | Uint8Array) => Promise<void>) => Promise<void>} */ fill) {
  if (!deps.store) throw new Error("The app's data folder is unavailable.");
  const name = `staging/${deps.random()}`;
  try {
    await fill((path, contents) => deps.writeStore(`${name}/${path}`, contents));
  } catch (error) {
    await removeInStore(deps, join(deps.store, name)).catch(() => {});
    throw error;
  }
  return join(deps.store, name);
}

// ---------------------------------------------------------------------------
// Installed skills
// ---------------------------------------------------------------------------

/**
 * Lists the skills in one agent folder: each subfolder (or link to one) with
 * a SKILL.md, or a SKILL.md.disabled when this app disabled it.
 * @param {Deps} deps @param {Root} root
 * @returns {Promise<LocalSkill[]>}
 */
export async function scanRoot(deps, root) {
  /** @type {LocalSkill[]} */
  const skills = [];
  for (const entry of await list(deps, root.path)) {
    if (entry.name.startsWith(".") || (entry.kind !== "dir" && entry.kind !== "link")) continue;
    const linked = entry.kind === "link";
    const dir = linked ? resolveLink(entry.path, entry.target) : entry.path;
    const base = { root, dirName: entry.name, path: entry.path, dir, linked, target: entry.target };

    let enabled = true;
    let text = null;
    let error = null;
    const shown = await deps.run("cat", [join(dir, SKILL_FILE)]);
    if (shown.code === 0) text = shown.stdout;
    else {
      const hidden = await deps.run("cat", [join(dir, DISABLED_FILE)]);
      if (hidden.code === 0) {
        enabled = false;
        text = hidden.stdout;
      } else if (linked && !(await exists(deps, dir))) {
        error = `Broken link to ${entry.target}.`;
      } else if (linked && /denied|not permitted/i.test(shown.stderr)) {
        error = shown.stderr.trim();
      } else {
        continue; // A folder that is not a skill.
      }
    }
    const data = text == null ? {} : parseFrontmatter(text).data;
    skills.push(localSkill(base, { enabled, error, name: data.name, description: data.description }));
  }

  // Modification time is the skill file's, not the folder's or the link's.
  const file = (/** @type {LocalSkill} */ s) => join(s.dir, s.enabled ? SKILL_FILE : DISABLED_FILE);
  const times = await statPaths(deps, skills.filter((s) => !s.error).map(file), true);
  for (const skill of skills) skill.mtime = times.get(file(skill))?.mtime ?? null;
  return skills;
}

/** @returns {LocalSkill} */
function localSkill(/** @type {any} */ base, /** @type {any} */ extra) {
  return {
    key: `${base.root.id}:${base.dirName}`,
    name: extra.name || base.dirName,
    dirName: base.dirName,
    description: extra.description || "",
    rootId: base.root.id,
    rootLabel: base.root.label,
    path: base.path,
    dir: base.dir,
    linked: base.linked,
    target: base.target,
    enabled: extra.enabled,
    mtime: null,
    error: extra.error,
  };
}

/** The SKILL.md text of an installed skill. @param {Deps} deps @param {LocalSkill} skill */
export function readSkill(deps, skill) {
  return readText(deps, join(skill.dir, skill.enabled ? SKILL_FILE : DISABLED_FILE));
}

/**
 * Disabling renames SKILL.md to SKILL.md.disabled, which agents do not load;
 * enabling renames it back.
 * @param {Deps} deps @param {LocalSkill} skill @param {boolean} enabled
 */
export async function setEnabled(deps, skill, enabled) {
  if (skill.enabled === enabled) return;
  await move(deps, join(skill.dir, enabled ? DISABLED_FILE : SKILL_FILE), join(skill.dir, enabled ? SKILL_FILE : DISABLED_FILE));
}

/**
 * @typedef {{
 *   id: string, name: string, dirName: string, rootId: string, rootLabel: string,
 *   path: string, kind: "dir" | "link", target: string, trashedAt: number,
 * }} TrashEntry
 */

/** @param {Deps} deps */
export const trashDir = (deps) => join(deps.store, "trash");

/**
 * Uninstalling moves the skill — a folder, or a link as a link — into the
 * app's trash, beside a record of where it came from. A linked skill's target
 * folder is never touched.
 * @param {Deps} deps @param {LocalSkill} skill
 * @returns {Promise<TrashEntry>}
 */
export async function trashSkill(deps, skill) {
  if (!deps.store) throw new Error("The app's data folder is unavailable.");
  const trashedAt = deps.now();
  const id = `${trashedAt}-${skill.rootId}-${skill.dirName}`;
  /** @type {TrashEntry} */
  const entry = {
    id,
    name: skill.name,
    dirName: skill.dirName,
    rootId: skill.rootId,
    rootLabel: skill.rootLabel,
    path: skill.path,
    kind: skill.linked ? "link" : "dir",
    target: skill.linked ? skill.target : "",
    trashedAt,
  };
  await deps.writeStore(`trash/${id}/entry.json`, JSON.stringify(entry, null, 2));
  try {
    await move(deps, skill.path, join(join(trashDir(deps), id), "skill"));
  } catch (error) {
    await removeInStore(deps, join(trashDir(deps), id)).catch(() => {});
    throw error;
  }
  return entry;
}

/** @param {Deps} deps @returns {Promise<TrashEntry[]>} */
export async function listTrash(deps) {
  if (!deps.store) return [];
  const entries = [];
  for (const item of await list(deps, trashDir(deps))) {
    if (item.kind !== "dir") continue;
    try {
      entries.push(JSON.parse(await readText(deps, join(item.path, "entry.json"))));
    } catch {
      // A half-written entry from an interrupted uninstall carries no record.
    }
  }
  return entries.sort((a, b) => b.trashedAt - a.trashedAt);
}

/** Puts a trashed skill back where it was. @param {Deps} deps @param {TrashEntry} entry */
export async function restoreSkill(deps, entry) {
  const base = join(trashDir(deps), entry.id);
  await move(deps, join(base, "skill"), entry.path);
  await removeInStore(deps, base);
}

/** @param {Deps} deps @param {TrashEntry} entry */
export function deleteForever(deps, entry) {
  return removeInStore(deps, join(trashDir(deps), entry.id));
}

/**
 * Writes a new skill folder holding one SKILL.md.
 * @param {Deps} deps @param {Root} root
 * @param {{ name: string, description: string, body: string }} skill
 */
export async function createSkill(deps, root, skill) {
  const problem = validateSkillName(skill.name);
  if (problem) throw new Error(problem);
  if (!skill.description.trim()) throw new Error("Describe when the agent should use the skill.");
  const path = join(root.path, skill.name);
  if (await exists(deps, path, false)) throw new Error(`${skill.name} already exists in ${root.label}.`);
  const staged = await stage(deps, (write) => write(SKILL_FILE, serializeSkill(skill)));
  await move(deps, staged, path);
  return path;
}

/**
 * Copies a skill folder from elsewhere on disk into an agent folder.
 * @param {Deps} deps @param {string} source @param {Root} root
 */
export async function importSkill(deps, source, root) {
  const from = normalize(source.trim().replace(/\/+$/, ""));
  if (!from.startsWith("/")) throw new Error("Enter an absolute folder path.");
  if (!(await exists(deps, from))) throw new Error(`${from} does not exist.`);
  if (!(await exists(deps, join(from, SKILL_FILE)))) throw new Error(`${from} has no ${SKILL_FILE}.`);
  const name = from.split("/").pop();
  const to = join(root.path, name);
  if (isInside(to, from) || isInside(from, to)) throw new Error("The folder is already in that location.");
  if (await exists(deps, to, false)) throw new Error(`${name} already exists in ${root.label}.`);
  // -H follows the source if it is itself a link; links inside stay links.
  await must(deps, "cp", ["-RH", from, to]);
  return to;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** @param {string} path */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");
/** GitHub refuses API requests without a User-Agent. */
const HEADERS = { "User-Agent": "gpui-shell-skills-manager" };

/** @param {Deps} deps @param {string} url */
async function getJson(deps, url) {
  const response = await deps.fetch(url, { headers: { ...HEADERS, Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      detail = (() => { try { return JSON.parse(body).message; } catch { return body.trim().slice(0, 160); } })() ?? "";
    } catch {}
    throw new Error(`GitHub answered ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json();
}

/** @param {Deps} deps @param {string} url */
async function getText(deps, url) {
  const response = await deps.fetch(url, { headers: HEADERS });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return response.text();
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function pool(/** @type {any[]} */ items, /** @type {number} */ limit, /** @type {(item: any) => Promise<void>} */ work) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  });
  await Promise.all(lanes);
}

/**
 * Lists every skill in the sources: two API calls per repository (its
 * metadata and its file tree), then each SKILL.md from raw.githubusercontent,
 * which does not count against the API's rate limit.
 * @param {Deps} deps @param {Source[]} sources
 * @param {(done: number, total: number) => void} [progress]
 */
export async function fetchCatalog(deps, sources, progress = () => {}) {
  /** @type {RemoteSkill[]} */
  const skills = [];
  /** @type {{ repo: string, message: string }[]} */
  const errors = [];
  for (const source of sources) {
    try {
      const repo = await getJson(deps, `${API}/repos/${source.repo}`);
      const tree = await getJson(deps, `${API}/repos/${source.repo}/git/trees/${source.branch}?recursive=1`);
      for (const found of skillsInTree(source, tree.tree ?? [])) {
        skills.push({
          id: `${source.repo}:${found.dirName}`,
          repo: source.repo,
          author: source.author,
          dirName: found.dirName,
          name: found.dirName,
          description: "",
          path: found.path,
          stars: repo.stargazers_count ?? 0,
          pushedAt: repo.pushed_at ?? "",
          files: found.files,
        });
      }
    } catch (error) {
      errors.push({ repo: source.repo, message: reason(error) });
    }
  }

  let done = 0;
  progress(done, skills.length);
  await pool(skills, 6, async (skill) => {
    const source = sources.find((s) => s.repo === skill.repo);
    try {
      const { data } = parseFrontmatter(await getText(deps, `${RAW}/${skill.repo}/${source.branch}/${encodePath(skill.path)}/${SKILL_FILE}`));
      skill.name = data.name || skill.dirName;
      skill.description = data.description || "";
    } catch (error) {
      skill.description = `Description unavailable (${reason(error)}).`;
    }
    progress(++done, skills.length);
  });
  return { skills, errors, fetchedAt: deps.now() };
}

/**
 * Downloads every file of a remote skill into a staging folder, then moves
 * the finished folder to `root/<dirName>` in one step, so an interrupted
 * download never leaves half a skill where an agent would load it. Text comes
 * from raw.githubusercontent; other files come as base64 blobs from the API so
 * their bytes are exact.
 * @param {Deps} deps @param {RemoteSkill} skill @param {Root} root @param {Source[]} sources
 * @param {(done: number, total: number) => void} [progress]
 */
export async function installRemote(deps, skill, root, sources, progress = () => {}) {
  const source = sources.find((s) => s.repo === skill.repo);
  if (!source) throw new Error(`Unknown source ${skill.repo}.`);
  const total = skill.files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_INSTALL_BYTES) throw new Error("This skill is larger than 20 MB; install it with git instead.");
  const dest = join(root.path, skill.dirName);
  if (await exists(deps, dest, false)) throw new Error(`${skill.dirName} is already installed in ${root.label}.`);

  const staged = await stage(deps, async (write) => {
    let done = 0;
    for (const file of skill.files) {
      if (isTextFile(file.path)) {
        await write(file.path, await getText(deps, `${RAW}/${skill.repo}/${source.branch}/${encodePath(`${skill.path}/${file.path}`)}`));
      } else {
        const blob = await getJson(deps, `${API}/repos/${skill.repo}/git/blobs/${file.sha}`);
        await write(file.path, new Uint8Array(Buffer.from(String(blob.content).replace(/\s/g, ""), "base64")));
      }
      progress(++done, skill.files.length);
    }
  });
  await move(deps, staged, dest);
  return dest;
}

/**
 * Finds the absolute path of the app's data directory, which the runtime does
 * not expose: writes a uniquely named marker with `fs` and asks `find` where it
 * landed under gpui-shell's data home.
 * @param {(command: string, args: string[]) => Promise<RunResult>} run
 * @param {(relative: string, contents: string) => Promise<void>} write
 * @param {(relative: string) => Promise<void>} remove
 * @param {string} dataHome
 * @param {string} marker
 */
export async function locateStore(run, write, remove, dataHome, marker) {
  await write(marker, "");
  try {
    const out = await run("find", [join(dataHome, "gpui-shell/apps"), "-maxdepth", "2", "-name", marker, "-type", "f"]);
    const found = out.stdout.split("\n").find(Boolean);
    if (!found) throw new Error(`could not find the app's data folder under ${dataHome}`);
    return parentOf(found);
  } finally {
    await remove(marker).catch(() => {});
  }
}
