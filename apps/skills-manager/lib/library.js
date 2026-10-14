// @ts-check
// Native file operations and GitHub downloads, with injected dependencies for tests.

import { Buffer } from "buffer";
import { parseFrontmatter, serializeSkill, validateSkillName } from "./frontmatter.js";
import { skillsInTree, isTextFile } from "./catalog.js";
import { resolveLink, normalize, isInside } from "./stat.js";

/**
 * @typedef {{
 *   fs: typeof import("fs/promises"),
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
// Native file operations
// ---------------------------------------------------------------------------

function missing(error) {
  return error?.code === "ENOENT" || /no such file|not found/i.test(reason(error));
}

export async function exists(deps, path, follow = true) {
  try {
    await (follow ? deps.fs.stat(path) : deps.fs.lstat(path));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function statPaths(deps, paths, follow = false) {
  const entries = await Promise.all(paths.map(async (path) => {
    try {
      const stat = await (follow ? deps.fs.stat(path) : deps.fs.lstat(path));
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
      return [path, { kind, mtime: stat.mtimeMs, target: kind === "link" ? await deps.fs.readlink(path) : "" }];
    } catch (error) {
      if (missing(error)) return null;
      return [path, { kind: "other", mtime: 0, target: "", error: reason(error) }];
    }
  }));
  return new Map(entries.filter(Boolean));
}

export async function list(deps, dir) {
  let names;
  try { names = await deps.fs.readdir(dir); }
  catch (error) { if (missing(error)) return []; throw error; }
  const stats = await statPaths(deps, names.map((name) => join(dir, name)));
  return names.map((name) => {
    const path = join(dir, name);
    const stat = stats.get(path);
    return { name, path, kind: stat?.kind ?? "other", target: stat?.target ?? "", mtime: stat?.mtime ?? 0, error: stat?.error ?? null };
  });
}

export function readText(deps, path) {
  return deps.fs.readFile(path, "utf8");
}

async function move(deps, from, to) {
  if (await exists(deps, to, false)) throw new Error(`${to} already exists.`);
  await deps.fs.mkdir(parentOf(to), { recursive: true });
  await deps.fs.rename(from, to);
}

async function removeTree(deps, path) {
  const stat = await deps.fs.lstat(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of await deps.fs.readdir(path)) await removeTree(deps, join(path, name));
    await deps.fs.rmdir(path);
  } else await deps.fs.unlink(path);
}

async function removeInStore(deps, path) {
  if (!deps.store || !isInside(path, deps.store) || normalize(path) === normalize(deps.store)) {
    throw new Error(`refusing to delete ${path} outside the app's data folder`);
  }
  // Refuse a symlink in a parent component: confinement must hold on disk too.
  const parts = normalize(path).slice(normalize(deps.store).length + 1).split("/");
  let parent = deps.store;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if ((await deps.fs.lstat(parent)).isSymbolicLink()) throw new Error(`refusing to delete through link ${parent}`);
  }
  if (await exists(deps, path, false)) await removeTree(deps, path);
}

async function copyTree(deps, from, to, follow = false) {
  const stat = await (follow ? deps.fs.stat(from) : deps.fs.lstat(from));
  if (stat.isSymbolicLink()) throw new Error(`Cannot import nested symbolic link ${from}.`);
  if (stat.isDirectory()) {
    await deps.fs.mkdir(to, { recursive: true });
    for (const name of await deps.fs.readdir(from)) await copyTree(deps, join(from, name), join(to, name));
  } else if (stat.isFile()) {
    await deps.fs.mkdir(parentOf(to), { recursive: true });
    await deps.fs.writeFile(to, await deps.fs.readFile(from));
  } else throw new Error(`Cannot import special file ${from}.`);
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
    if (entry.name.startsWith(".")) continue;
    if (entry.error) {
      skills.push(localSkill({ root, dirName: entry.name, path: entry.path, dir: entry.path, linked: false, target: "" },
        { enabled: true, error: entry.error }));
      continue;
    }
    if (entry.kind !== "dir" && entry.kind !== "link") continue;
    const linked = entry.kind === "link";
    const dir = linked ? resolveLink(entry.path, entry.target) : entry.path;
    const base = { root, dirName: entry.name, path: entry.path, dir, linked, target: entry.target };

    let enabled = true;
    let text = null;
    let error = null;
    try { text = await readText(deps, join(dir, SKILL_FILE)); }
    catch (shown) {
      try {
        text = await readText(deps, join(dir, DISABLED_FILE));
        enabled = false;
      } catch (hidden) {
        if (linked && missing(shown) && missing(hidden) && !(await exists(deps, dir))) error = `Broken link to ${entry.target}.`;
        else if (!missing(shown)) error = reason(shown);
        else if (!missing(hidden)) error = reason(hidden);
        else continue;
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
  const staged = await stage(deps, async (write) => {
    // Create the staging directory through the same data-directory writer.
    await write(".import-marker", "");
  });
  try {
    await deps.fs.unlink(join(staged, ".import-marker"));
    await copyTree(deps, from, staged, true);
    await move(deps, staged, to);
  } catch (error) {
    await removeInStore(deps, staged).catch(() => {});
    throw error;
  }
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
 * Reads repositories concurrently and publishes cards before descriptions.
 * Unchanged SKILL.md descriptions are reused by SHA; other downloads use a
 * bounded pool on raw.githubusercontent.com.
 * @param {Deps} deps @param {Source[]} sources
 * @param {(done: number, total: number) => void} [progress]
 * @param {(catalog: { skills: RemoteSkill[], errors: { repo: string, message: string }[], fetchedAt: number }) => void} [publish]
 * @param {RemoteSkill[]} [cached]
 */
export async function fetchCatalog(deps, sources, progress = () => {}, publish = () => {}, cached = []) {
  /** @type {RemoteSkill[]} */
  const skills = [];
  /** @type {{ repo: string, message: string }[]} */
  const errors = [];
  const previous = new Map(cached.map((skill) => [skill.id, skill]));
  const snapshot = () => publish({ skills: skills.map((skill) => ({ ...skill })), errors: [...errors], fetchedAt: 0 });
  await Promise.all(sources.map(async (source) => {
    try {
      const [repo, tree] = await Promise.all([
        getJson(deps, `${API}/repos/${source.repo}`),
        getJson(deps, `${API}/repos/${source.repo}/git/trees/${source.branch}?recursive=1`),
      ]);
      if (tree.truncated) throw new Error("GitHub returned an incomplete repository tree.");
      for (const found of skillsInTree(source, tree.tree ?? [])) {
        const id = `${source.repo}:${found.dirName}`;
        const old = previous.get(id);
        const sha = found.files.find((file) => file.path === SKILL_FILE)?.sha;
        const unchanged = old?.files.find((file) => file.path === SKILL_FILE)?.sha === sha;
        skills.push({
          id, repo: source.repo, author: source.author, dirName: found.dirName,
          name: unchanged ? old.name : found.dirName,
          description: unchanged ? old.description : "",
          path: found.path, stars: repo.stargazers_count ?? 0,
          pushedAt: repo.pushed_at ?? "", files: found.files,
        });
      }
      snapshot();
    } catch (error) {
      errors.push({ repo: source.repo, message: reason(error) });
      // A temporary failure must not discard a previously loaded source.
      skills.push(...cached.filter((skill) => skill.repo === source.repo));
      snapshot();
    }
  }));

  let done = 0;
  const pending = skills.filter((skill) => {
    const old = previous.get(skill.id);
    return !old?.description || old.description.startsWith("Description unavailable (") ||
      old.files.find((file) => file.path === SKILL_FILE)?.sha !== skill.files.find((file) => file.path === SKILL_FILE)?.sha;
  });
  progress(done, pending.length);
  await pool(pending, 8, async (skill) => {
    const source = sources.find((s) => s.repo === skill.repo);
    try {
      const { data } = parseFrontmatter(await getText(deps, `${RAW}/${skill.repo}/${source.branch}/${encodePath(skill.path)}/${SKILL_FILE}`));
      skill.name = data.name || skill.dirName;
      skill.description = data.description || "";
    } catch (error) {
      skill.description = `Description unavailable (${reason(error)}).`;
    }
    progress(++done, pending.length);
    if (done % 4 === 0 || done === pending.length) snapshot();
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
