// @ts-check
// The runtime's fs module has no stat, lstat or readlink, so file kinds,
// modification times and link targets come from the system `stat` command.

/** @typedef {{ name: string, kind: "dir" | "link" | "file" | "other", mtime: number, target: string }} StatEntry */

/**
 * Arguments for an lstat of each path: one line per path, tab-separated.
 * @param {string} platform
 * @param {string[]} paths
 * @param {{ follow?: boolean }} [options]
 */
export function statArgs(platform, paths, options = {}) {
  const follow = options.follow ? ["-L"] : [];
  if (platform === "darwin" || platform === "macos" || /bsd/.test(platform)) {
    return [...follow, "-f", "%m%t%HT%t%N%t%Y", ...paths];
  }
  return [...follow, "-c", "%Y\t%F\t%n\t%N", ...paths];
}

/**
 * Parses `statArgs` output. Lines for missing paths go to stderr, so they are
 * simply absent here.
 * @param {string} platform
 * @param {string} stdout
 * @returns {Map<string, StatEntry>}
 */
export function parseStat(platform, stdout) {
  const bsd = platform === "darwin" || platform === "macos" || /bsd/.test(platform);
  /** @type {Map<string, StatEntry>} */
  const entries = new Map();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [mtime, type, name, extra = ""] = line.split("\t");
    const lower = (type ?? "").toLowerCase();
    const kind = lower === "directory" ? "dir" : lower === "symbolic link" ? "link" : lower.includes("regular") ? "file" : "other";
    let target = "";
    if (kind === "link") {
      if (bsd) target = extra;
      else {
        // GNU %N prints 'name' -> 'target' with shell-style quotes.
        const arrow = extra.indexOf(" -> ");
        if (arrow >= 0) target = extra.slice(arrow + 4).replace(/^['"‘]|['"’]$/g, "");
      }
    }
    entries.set(name, { name, kind, mtime: Number(mtime) * 1000, target });
  }
  return entries;
}

/**
 * Where a link points, as an absolute normalized path.
 * @param {string} linkPath absolute path of the link itself
 * @param {string} target the link's text
 */
export function resolveLink(linkPath, target) {
  if (target.startsWith("/")) return normalize(target);
  const parent = linkPath.split("/").slice(0, -1).join("/");
  return normalize(`${parent}/${target}`);
}

/** @param {string} path */
export function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return (path.startsWith("/") ? "/" : "") + parts.join("/");
}

/** Whether `path` is inside (or is) `root`. @param {string} path @param {string} root */
export function isInside(path, root) {
  const a = normalize(path);
  const b = normalize(root);
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/");
}

/** Replaces the home directory with ~ for display. @param {string} path @param {string} home */
export function tildify(path, home) {
  if (home && isInside(path, home)) return "~" + normalize(path).slice(normalize(home).length);
  return path;
}
