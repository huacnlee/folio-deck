// @ts-check
// Pure rules for the two views: which public repositories Discover reads, how
// its skills are grouped, and how either list is searched, filtered and
// sorted. Nothing here touches the disk or the network, so it is tested in
// Node directly.

/**
 * A public repository Discover lists. `prefix` is the folder whose immediate
 * subfolders are skills (each holding a SKILL.md).
 * @typedef {{ repo: string, branch: string, prefix: string, author: string }} Source
 */

/** @type {Source[]} */
export const SOURCES = [
  { repo: "anthropics/skills", branch: "main", prefix: "skills/", author: "Anthropic" },
  { repo: "openai/skills", branch: "main", prefix: "skills/.curated/", author: "OpenAI" },
  { repo: "vercel-labs/agent-skills", branch: "main", prefix: "skills/", author: "Vercel" },
];

/**
 * The editor's picks shown under Recommended, in order. A pick that a source
 * no longer carries is skipped.
 */
export const RECOMMENDED = [
  "anthropics/skills:skill-creator",
  "anthropics/skills:frontend-design",
  "vercel-labs/agent-skills:react-best-practices",
  "anthropics/skills:mcp-builder",
  "openai/skills:define-goal",
  "vercel-labs/agent-skills:web-design-guidelines",
];

export const GROUP_SIZE = 6;

/**
 * @typedef {{
 *   id: string, repo: string, author: string, dirName: string, name: string,
 *   description: string, path: string, stars: number, pushedAt: string,
 *   files: { path: string, sha: string, size: number }[],
 * }} RemoteSkill
 */

/**
 * The skills inside one repository tree, each with the files it owns.
 * @param {Source} source
 * @param {{ path: string, type: string, sha: string, size?: number }[]} tree
 * @returns {{ dirName: string, path: string, files: { path: string, sha: string, size: number }[] }[]}
 */
export function skillsInTree(source, tree) {
  const names = new Set();
  for (const entry of tree) {
    if (entry.type !== "blob" || !entry.path.startsWith(source.prefix)) continue;
    const rest = entry.path.slice(source.prefix.length).split("/");
    if (rest.length === 2 && rest[1] === "SKILL.md" && !rest[0].startsWith(".")) names.add(rest[0]);
  }
  return [...names].sort().map((dirName) => {
    const path = source.prefix + dirName;
    const files = tree
      .filter((entry) => entry.type === "blob" && entry.path.startsWith(path + "/"))
      .map((entry) => ({ path: entry.path.slice(path.length + 1), sha: entry.sha, size: entry.size ?? 0 }));
    return { dirName, path, files };
  });
}

/**
 * Discover's groups. Recommended is the curated list above. New skills are
 * the ones first seen most recently by this app (it records when each skill
 * first appeared in a refresh; on the very first refresh every skill shares one
 * date, so the most recently pushed repository's come first). Most installed
 * ranks by the source repository's stars, as GitHub publishes no per-skill
 * install counts. Everything else is listed under All skills.
 * @param {RemoteSkill[]} skills
 * @param {Record<string, number>} firstSeen
 */
export function groupDiscover(skills, firstSeen) {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const taken = new Set();
  const take = (/** @type {RemoteSkill[]} */ list) => {
    const picked = list.filter((skill) => !taken.has(skill.id)).slice(0, GROUP_SIZE);
    picked.forEach((skill) => taken.add(skill.id));
    return picked;
  };

  const recommended = take(RECOMMENDED.map((id) => byId.get(id)).filter(Boolean));
  const fresh = take(
    [...skills].sort(
      (a, b) =>
        (firstSeen[b.id] ?? 0) - (firstSeen[a.id] ?? 0) ||
        b.pushedAt.localeCompare(a.pushedAt) ||
        a.name.localeCompare(b.name),
    ),
  );
  const popular = take([...skills].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name)));
  const rest = skills.filter((skill) => !taken.has(skill.id)).sort((a, b) => a.name.localeCompare(b.name));
  return [
    { id: "recommended", title: "Recommended", skills: recommended },
    { id: "new", title: "New skills", skills: fresh },
    { id: "popular", title: "Most installed", skills: popular },
    { id: "all", title: "All skills", skills: rest },
  ].filter((group) => group.skills.length > 0);
}

/**
 * Records the first time each skill was seen. Skills already known keep their
 * date; on the first refresh (nothing known yet) every skill gets 0, so that a
 * catalog's starting contents are not all "new".
 * @param {Record<string, number>} firstSeen
 * @param {string[]} ids
 * @param {number} now
 */
export function recordFirstSeen(firstSeen, ids, now) {
  const baseline = Object.keys(firstSeen).length === 0;
  const next = { ...firstSeen };
  for (const id of ids) if (!(id in next)) next[id] = baseline ? 0 : now;
  return next;
}

/**
 * @typedef {{
 *   key: string, name: string, dirName: string, description: string,
 *   rootId: string, rootLabel: string, path: string, dir: string,
 *   linked: boolean, target: string, enabled: boolean, mtime: number | null, error: string | null,
 * }} LocalSkill
 */

/**
 * @template {{ name: string, description: string, dirName?: string, rootLabel?: string, author?: string }} T
 * @param {T[]} list
 * @param {string} query
 */
export function searchSkills(list, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list;
  return list.filter((skill) => {
    const haystack = [skill.name, skill.dirName, skill.description, skill.rootLabel, skill.author]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Installed filters. "all" keeps everything. */
export const STATUS_FILTERS = [
  { id: "all", label: "Any status" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "linked", label: "Linked" },
  { id: "broken", label: "Unreadable" },
];

/**
 * @param {LocalSkill[]} list
 * @param {{ root: string, status: string }} filter
 */
export function filterLocal(list, filter) {
  return list.filter((skill) => {
    if (filter.root !== "all" && skill.rootId !== filter.root) return false;
    switch (filter.status) {
      case "enabled": return skill.enabled && !skill.error;
      case "disabled": return !skill.enabled && !skill.error;
      case "linked": return skill.linked;
      case "broken": return Boolean(skill.error);
      default: return true;
    }
  });
}

export const SORTS = [
  { id: "name", label: "Name" },
  { id: "recent", label: "Recently modified" },
];

/**
 * @template {{ name: string }} T
 * @param {T[]} list
 * @param {string} sort
 * @param {(item: T) => number} recency
 */
export function sortSkills(list, sort, recency) {
  const sorted = [...list];
  if (sort === "recent") sorted.sort((a, b) => recency(b) - recency(a) || a.name.localeCompare(b.name));
  else sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}

/** A description cut to about two card lines. @param {string} text @param {number} [limit] */
export function truncate(text, limit = 96) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 1).replace(/[\s,.;:]+\S*$/, "") + "…";
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Files fetched as text from raw.githubusercontent.com; anything else is
 * fetched as a base64 blob so its bytes survive.
 * @param {string} path
 */
export function isTextFile(path) {
  const name = path.split("/").pop().toLowerCase();
  if (["license", "makefile", "dockerfile", "readme"].includes(name)) return true;
  return /\.(md|mdx|txt|py|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|sh|bash|zsh|html?|css|scss|xml|csv|tsv|svg|rs|go|rb|java|kt|swift|c|h|cpp|hpp|sql|ini|cfg|env|lock|gitignore|xsd|dtd)$/.test(name);
}

/** @param {number | null} time */
export function relativeTime(time, now = Date.now()) {
  if (!time) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} d ago`;
  return new Date(time).toISOString().slice(0, 10);
}
