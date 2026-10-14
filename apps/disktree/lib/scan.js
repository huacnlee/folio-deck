import { join, basename } from "./files.js";
export const categories = [
  "Code",
  "Agent scratch",
  "Toolchains",
  "Synced",
  "Git",
  "Media",
  "Documents",
  "Cache",
];
export function category(path) {
  if (/(^|\/)\.git(\/|$)/.test(path)) return "Git";
  if (/(^|\/)(target|node_modules|build|dist|\.cache|Cache)(\/|$)/.test(path))
    return "Cache";
  if (/\.(worktrees|claude|codex|agents)(\/|$)/.test(path))
    return "Agent scratch";
  if (/\.(rustup|cargo|npm|local)(\/|$)/.test(path)) return "Toolchains";
  if (/(Dropbox|Sync|OneDrive)/i.test(path)) return "Synced";
  if (/\.(png|jpe?g|mp4|mp3|mkv|webp|wav)$/i.test(path)) return "Media";
  if (/(^|\/)(work|src|projects)(\/|$)|\.(rs|js|ts|py|go)$/i.test(path))
    return "Code";
  return "Documents";
}
export const reclaimable = (node) =>
  ["target", "node_modules", "build", "dist", ".cache", "Cache"].includes(
    node.name,
  );
export function parseStats(text) {
  const fields = text.split("\0");
  const result = [];
  for (let i = 0; i + 7 < fields.length; i += 8)
    result.push({
      path: fields[i],
      mode: parseInt(fields[i + 1], 16),
      size: Number(fields[i + 2]),
      allocated: Number(fields[i + 3]) * 512,
      modified: Number(fields[i + 4]) * 1000,
      inode: fields[i + 5] + ":" + fields[i + 6],
      links: Number(fields[i + 7]),
    });
  return result;
}
const STAT_FORMAT = "%n\\0%f\\0%s\\0%b\\0%Y\\0%i\\0%d\\0%h\\0";
// Files share one empty child list; nothing ever adds to a file's children.
const NONE = Object.freeze([]);
// A scan holds hundreds of thousands of nodes inside QuickJS's heap limit, so
// a node keeps only what varies: its path and category derive from its name
// and parent, and fixed values live on the prototype.
class Entry {
  constructor(parent, name, info) {
    this.parent = parent;
    this.name = name;
    this.size = info.size;
    this.allocated = info.allocated;
    this.modified = info.modified;
  }
  get path() {
    const base = this.parent.path;
    return base === "/" ? `/${this.name}` : `${base}/${this.name}`;
  }
  get category() {
    return category(this.path);
  }
}
class File extends Entry {
  constructor(parent, name, info, link) {
    super(parent, name, info);
    this.link = link;
  }
}
class Folder extends Entry {
  constructor(parent, name, info) {
    super(parent, name, info);
    this.files = 0;
    this.dirs = 1;
    this.children = [];
  }
}
class Root extends Folder {
  constructor(path, info) {
    super(null, basename(path), info);
    this.dirs = 0;
    this.root = path;
  }
  get path() {
    return this.root;
  }
}
const fixed = (value) => ({ value, enumerable: true });
Object.defineProperties(File.prototype, {
  directory: fixed(false),
  files: fixed(1),
  dirs: fixed(0),
  children: fixed(NONE),
});
Object.defineProperties(Folder.prototype, {
  directory: fixed(true),
  link: fixed(false),
});
export async function scan(deps, rootPath, options = {}) {
  const rootResult = await deps.run("stat", [
    "--printf",
    STAT_FORMAT,
    "--",
    rootPath,
  ]);
  if (rootResult.code !== 0)
    throw new Error(rootResult.stderr.trim() || "Cannot inspect scan root.");
  const rootInfo = parseStats(rootResult.stdout)[0];
  if (!rootInfo || (rootInfo.mode & 0xf000) !== 0x4000)
    throw new Error("The scan root must be a directory, not a symbolic link.");
  const root = new Root(rootPath, rootInfo);
  const queue = [root],
    seen = new Set(),
    errors = [];
  let visited = 0,
    queueCursor = 0;
  // Reclaimable folders are collected as they are found, outermost only, so
  // suggestions never need a walk over the whole tree.
  const reclaim = [],
    claimed = new WeakSet();
  if (reclaimable(root)) {
    reclaim.push(root);
    claimed.add(root);
  }
  let lastPublished = 0;
  let published = false;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && published && now - lastPublished < 300) return;
    lastPublished = now;
    published = true;
    options.partial?.(root, visited, queue.length - queueCursor, reclaim);
  };
  while (queueCursor < queue.length) {
    if (options.cancelled?.())
      return { root, errors, cancelled: true, visited, reclaim };
    // Collect across directories so small folders share stat subprocesses.
    const batch = queue.slice(queueCursor, queueCursor + 32);
    queueCursor += batch.length;
    const groups = await Promise.all(
      batch.map(async (node) => {
        try {
          const base = node.path;
          const names = await deps.fs.readdir(base);
          return names
            .filter((name) => options.hidden !== false || !name.startsWith("."))
            .map((name) => ({ path: join(base, name), parent: node }));
        } catch (error) {
          errors.push(`${node.path}: ${String(error)}`);
          return [];
        }
      }),
    );
    const entries = groups.flat();
    for (let offset = 0; offset < entries.length; offset += 128) {
      if (options.cancelled?.())
        return { root, errors, cancelled: true, visited, reclaim };
      const chunk = entries.slice(offset, offset + 128);
      const parentByPath = new Map(
        chunk.map((entry) => [entry.path, entry.parent]),
      );
      try {
        const result = await deps.run("stat", [
          "--printf",
          STAT_FORMAT,
          "--",
          ...chunk.map((entry) => entry.path),
        ]);
        if (result.code !== 0) errors.push(result.stderr.trim());
        const parsed = parseStats(result.stdout);
        if (result.code === 0 && parsed.length !== chunk.length)
          errors.push(
            `${rootPath}: incomplete stat output; some entries were not counted.`,
          );
        for (const info of parsed) {
          const node = parentByPath.get(info.path);
          if (!node) {
            errors.push("Unexpected stat record was skipped.");
            continue;
          }
          const directory = (info.mode & 0xf000) === 0x4000,
            link = (info.mode & 0xf000) === 0xa000;
          // Only files with several hard links can be counted twice.
          const shared = !directory && !link && info.links > 1;
          const duplicate = shared && seen.has(info.inode);
          if (shared) seen.add(info.inode);
          if (duplicate) info.size = info.allocated = 0;
          const name = basename(info.path);
          const child = directory
            ? new Folder(node, name, info)
            : new File(node, name, info, link);
          node.children.push(child);
          if (directory && claimed.has(node)) claimed.add(child);
          else if (directory && reclaimable(child)) {
            claimed.add(child);
            reclaim.push(child);
          }
          // Each entry's own stats update its ancestor chain exactly once.
          for (
            let ancestor = node;
            ancestor;
            ancestor = ancestor.parent
          ) {
            ancestor.size += child.size;
            ancestor.allocated += child.allocated;
            ancestor.files += child.files;
            ancestor.dirs += child.dirs;
          }
          visited++;
          if (directory) queue.push(child);
        }
      } catch (error) {
        errors.push(`Could not inspect a batch of entries: ${String(error)}`);
      }
      publish();
      options.progress?.(visited, queue.length - queueCursor);
      await options.yield?.();
    }
    if (!entries.length) {
      options.progress?.(visited, queue.length - queueCursor);
      await options.yield?.();
    }
  }
  if (options.cancelled?.()) return { root, errors, cancelled: true, visited, reclaim };
  publish(true);
  return { root, errors, visited, cancelled: false, reclaim };
}
export function weight(
  node,
  metric = "size",
  apparent = false,
  now = Date.now(),
) {
  return metric === "files"
    ? node.files
    : metric === "age"
      ? Math.max(1, (now - node.modified) / 86400000)
      : apparent
        ? node.size
        : node.allocated;
}
// Balanced binary area partition. Every leaf preserves its exact proportion.
export function treemap(
  nodes,
  width,
  height,
  metric = "size",
  apparent = false,
) {
  const entries = nodes
    .map((node) => ({
      node,
      value: Math.max(0, weight(node, metric, apparent)),
    }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);
  const result = [];
  function split(items, x, y, w, h) {
    if (!items.length) return;
    if (items.length === 1) {
      result.push({ node: items[0].node, x, y, w, h });
      return;
    }
    const total = items.reduce((s, e) => s + e.value, 0);
    let sum = 0,
      index = 0;
    while (index < items.length - 1 && sum < total / 2)
      sum += items[index++].value;
    const ratio = sum / total;
    if (w >= h) {
      split(items.slice(0, index), x, y, w * ratio, h);
      split(items.slice(index), x + w * ratio, y, w * (1 - ratio), h);
    } else {
      split(items.slice(0, index), x, y, w, h * ratio);
      split(items.slice(index), x, y + h * ratio, w, h * (1 - ratio));
    }
  }
  split(entries, 0, 0, width, height);
  return result;
}
export function suggestions(root) {
  const result = [];
  function walk(node) {
    if (reclaimable(node)) {
      result.push(node);
      return;
    }
    for (const child of node.children ?? []) if (child.directory) walk(child);
  }
  walk(root);
  return result.sort((a, b) => b.allocated - a.allocated);
}

// Largest reclaimable folders from a scan's incrementally collected list.
export const topSuggestions = (reclaim, limit = 8) =>
  reclaim
    .filter((node) => node.allocated >= 1024 * 1024)
    .sort((a, b) => b.allocated - a.allocated)
    .slice(0, limit);
