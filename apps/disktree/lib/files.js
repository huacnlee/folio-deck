// Filesystem logic, independent of GPUI. Commands always receive argv, never shell text.
export const reason = (error) => {
  const value = error instanceof Error ? error.message : error?.message ?? String(error);
  return !value || ["null", "undefined", "Null\"null\""].includes(value)
    ? "The operation was interrupted." : value;
};
export function normalize(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
export const join = (dir, name) => normalize(`${dir}/${name}`);
export const basename = (path) => normalize(path).split("/").pop() || "/";
export const parent = (path) =>
  normalize(path).split("/").slice(0, -1).join("/") || "/";
export const inside = (path, root) =>
  normalize(root) === "/" ||
  normalize(path) === normalize(root) ||
  normalize(path).startsWith(normalize(root) + "/");
export const displayPath = (path, home) =>
  inside(path, home)
    ? "~" + normalize(path).slice(normalize(home).length)
    : path;
export function resolvePath(text, current, home) {
  const path = text.trim();
  if (!path || path.includes("\0")) throw new Error("Enter a folder path.");
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return normalize(path.startsWith("/") ? path : `${current}/${path}`);
}
export function validName(name) {
  if (!name.trim() || name === "." || name === ".." || /[/\0]/.test(name))
    throw new Error("Use a name without / or a null character.");
  return name;
}
function missing(error) {
  return (
    error?.code === "ENOENT" || /no such file|not found/i.test(reason(error))
  );
}
export async function exists(fs, path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function pool(items, work, limit = 12) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
export function typeOf(name, directory) {
  if (directory) return "Folder";
  const extension = name.split(".").pop().toLowerCase();
  if (/^(png|jpe?g|webp|gif|bmp|svg)$/.test(extension)) return "Image";
  if (/^(mp4|mkv|mov|webm)$/.test(extension)) return "Video";
  if (/^(mp3|flac|wav|ogg|m4a)$/.test(extension)) return "Audio";
  if (extension === "pdf") return "PDF";
  if (/^(zip|gz|xz|7z|tar|zst)$/.test(extension)) return "Archive";
  if (/^(js|mjs|ts|rs|py|sh|go|css|html|json|toml|yaml|yml)$/.test(extension))
    return "Code";
  return "Document";
}
export function formatSize(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024,
    index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
export async function readDirectory(fs, path) {
  const names = await fs.readdir(path, { withFileTypes: true });
  const entries = names.map((entry) => ({
    name: entry.name,
    path: join(path, entry.name),
    directory: entry.isDirectory(),
    size: null,
    modified: null,
    error: null,
  }));
  await pool(entries, async (entry) => {
    try {
      const stat = await fs.stat(entry.path);
      entry.directory = stat.isDirectory();
      entry.size = stat.size;
      entry.modified = stat.mtimeMs;
    } catch (error) {
      entry.error = reason(error);
    }
    entry.type = typeOf(entry.name, entry.directory);
  });
  return entries;
}
export function visibleEntries(
  entries,
  { query = "", hidden = false, sort = "name", descending = false } = {},
) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries
    .filter(
      (entry) =>
        (hidden || !entry.name.startsWith(".")) &&
        words.every((word) => entry.name.toLowerCase().includes(word)),
    )
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        (descending ? -1 : 1) *
          (sort === "size"
            ? (a.size ?? 0) - (b.size ?? 0) || a.name.localeCompare(b.name)
            : sort === "modified"
              ? (a.modified ?? 0) - (b.modified ?? 0) ||
                a.name.localeCompare(b.name)
              : a.name.localeCompare(b.name, undefined, { numeric: true })),
    );
}
export async function command(deps, name, args) {
  const result = await deps.run(name, args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `${name} failed (${result.code}).`);
  return result.stdout;
}
// Check the real parent, not the final component: renaming a symlink moves the link.
export async function writable(deps, path) {
  if (!inside(path, deps.home) && !inside(path, deps.store))
    throw new Error("Changes are limited to your home folder.");
  if (
    [deps.home, deps.store, "/", join(deps.store, "trash")].includes(
      normalize(path),
    ) ||
    inside(deps.store, path)
  )
    throw new Error("This location cannot be changed.");
  const real = (await command(deps, "realpath", [parent(path)])).trim();
  if (!inside(real, deps.home) && !inside(real, deps.store))
    throw new Error(
      "The parent is a link to a location outside your home folder.",
    );
}
async function entryExists(deps, path) {
  if (await exists(deps.fs, path)) return true;
  return (await deps.run("readlink", [path])).code === 0;
}
export async function moveNoReplace(deps, from, to) {
  await writable(deps, from);
  await writable(deps, to);
  if (await entryExists(deps, to))
    throw new Error(`${basename(to)} already exists. Choose another name.`);
  // GNU -n never overwrites, including a destination created after the check.
  await command(deps, "mv", ["-nT", "--", from, to]);
  if (await entryExists(deps, from))
    throw new Error(
      "The destination appeared during the move; the source was kept.",
    );
}
export async function newFolder(deps, dir, name) {
  const path = join(dir, validName(name));
  await writable(deps, path);
  await deps.fs.mkdir(path);
  return path;
}
export async function rename(deps, path, name) {
  const to = join(parent(path), validName(name));
  if (to !== path) await moveNoReplace(deps, path, to);
  return to;
}
export async function transfer(
  deps,
  sources,
  destination,
  cut,
  progress = () => {},
) {
  const finished = [],
    failures = [];
  for (let index = 0; index < sources.length; index++) {
    const from = sources[index],
      to = join(destination, basename(from));
    try {
      if (inside(destination, from))
        throw new Error("A folder cannot be placed inside itself.");
      let isDirectory = false;
      try {
        isDirectory = (await deps.fs.stat(from)).isDirectory();
      } catch {}
      if (isDirectory) {
        const realSource = (await command(deps, "realpath", [from])).trim();
        const realDestination = (
          await command(deps, "realpath", [destination])
        ).trim();
        if (inside(realDestination, realSource))
          throw new Error(
            "A folder cannot be placed inside itself through a link.",
          );
      }
      if (from === to) throw new Error("The item is already in this folder.");
      await writable(deps, to);
      if (await entryExists(deps, to))
        throw new Error(`${basename(to)} already exists.`);
      if (cut) await moveNoReplace(deps, from, to);
      else {
        // Unique staging is owned by this operation. -P preserves nested symlinks.
        const staging = join(parent(to), `.omanta-copy-${deps.random()}`);
        await deps.fs.mkdir(staging);
        const staged = join(staging, basename(from));
        try {
          await command(deps, "cp", ["-RP", "--", from, staged]);
          await moveNoReplace(deps, staged, to);
        } catch (error) {
          await command(deps, "rm", ["-rf", "--", staging]).catch(() => {});
          throw error;
        }
        await deps.fs.rmdir(staging);
      }
      finished.push({ from, to });
    } catch (error) {
      failures.push({ path: from, message: reason(error) });
    }
    progress(index + 1, sources.length);
  }
  return { finished, failures };
}
export async function trash(deps, paths, progress = () => {}) {
  const entries = [],
    failures = [];
  await deps.fs.mkdir(join(deps.store, "trash"), { recursive: true });
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    let recordDir;
    try {
      await writable(deps, path);
      if (inside(path, join(deps.store, "trash")))
        throw new Error("An item in Trash cannot be trashed again.");
      const id = deps.random();
      recordDir = join(deps.store, `trash/${id}`);
      await deps.fs.mkdir(recordDir);
      const entry = { id, path, name: basename(path), trashedAt: deps.now() };
      await deps.fs.writeFile(
        join(recordDir, "entry.json"),
        JSON.stringify(entry),
      );
      await moveNoReplace(deps, path, join(recordDir, "item"));
      entries.push(entry);
    } catch (error) {
      if (recordDir) {
        // Keep a record if the item moved but a later step failed.
        if (!(await entryExists(deps, join(recordDir, "item"))))
          await command(deps, "rm", ["-rf", "--", recordDir]).catch(() => {});
      }
      failures.push({ path, message: reason(error) });
    }
    progress(index + 1, paths.length);
  }
  return { entries, failures };
}
export async function readTrash(deps) {
  const dir = join(deps.store, "trash");
  if (!(await exists(deps.fs, dir))) return [];
  const entries = [];
  for (const name of await deps.fs.readdir(dir)) {
    if (name.includes("/") || name === "..") continue;
    try {
      const entry = JSON.parse(
        await deps.fs.readFile(join(dir, `${name}/entry.json`), "utf8"),
      );
      if (
        entry.id !== name ||
        typeof entry.path !== "string" ||
        !entry.path.startsWith("/")
      )
        continue;
      if (!(await entryExists(deps, join(dir, `${name}/item`)))) continue;
      let directory = false;
      try {
        directory = (
          await deps.fs.stat(join(dir, `${name}/item`))
        ).isDirectory();
      } catch {}
      entries.push({
        ...entry,
        originalPath: entry.path,
        path: join(dir, `${name}/item`),
        directory,
        modified: entry.trashedAt,
        type: "Trashed item",
      });
    } catch {
      /* Incomplete or unreadable records are left untouched. */
    }
  }
  return entries.sort((a, b) => b.trashedAt - a.trashedAt);
}
export async function restore(deps, entry) {
  validName(entry.id);
  const record = join(deps.store, `trash/${entry.id}`);
  const saved = JSON.parse(
    await deps.fs.readFile(join(record, "entry.json"), "utf8"),
  );
  if (saved.id !== entry.id) throw new Error("Invalid trash record.");
  // Parent must still exist; do not recreate removed user directories implicitly.
  await moveNoReplace(deps, join(record, "item"), saved.path);
  await deps.fs.unlink(join(record, "entry.json"));
  await deps.fs.rmdir(record);
  return saved.path;
}
export async function preview(fs, entry) {
  if (entry.directory)
    return { kind: "folder", text: "Open this folder to browse its contents." };
  if (entry.error) throw new Error(entry.error);
  if (
    entry.type === "Image" &&
    !entry.name.toLowerCase().endsWith(".svg") &&
    (entry.size ?? 0) <= 8 * 1024 * 1024
  )
    return { kind: "image", path: entry.path };
  if ((entry.size ?? 0) > 2 * 1024 * 1024)
    return {
      kind: "info",
      text: "This file is too large for a text preview. Open it in its default app.",
    };
  const allowed =
    /\.(txt|md|mdx|json|toml|ya?ml|js|mjs|ts|rs|py|css|html|sh|log|csv|ini|cfg|xml|svg)$/i.test(
      entry.name,
    ) || /^(README|LICENSE|Makefile)(\.|$)/i.test(entry.name);
  if (!allowed)
    return { kind: "info", text: "Open in its default app to view this file." };
  const text = await fs.readFile(entry.path, "utf8");
  return {
    kind: "text",
    text: text.slice(0, 12000),
    truncated: text.length > 12000,
  };
}

// Permanent deletion is limited to validated app-owned Trash records.
async function trashRecord(deps, entry) {
  if (
    !entry ||
    typeof entry.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      entry.id,
    )
  ) {
    throw new Error("Invalid Trash record id.");
  }
  if (!deps.store || !deps.store.startsWith("/"))
    throw new Error("Missing application data directory.");
  const store = (await command(deps, "realpath", ["--", deps.store])).trim();
  if (store === "/" || store === deps.home)
    throw new Error("Invalid application data directory.");
  const trashRoot = join(deps.store, "trash");
  const record = join(trashRoot, entry.id);
  if (
    (await command(deps, "realpath", ["--", trashRoot])).trim() !==
    join(store, "trash")
  )
    throw new Error("Trash directory points outside application data.");
  if (
    (await command(deps, "realpath", ["--", record])).trim() !==
    join(store, `trash/${entry.id}`)
  )
    throw new Error("Trash record is a symbolic link.");
  if (
    (
      await command(deps, "realpath", ["--", join(record, "entry.json")])
    ).trim() !== join(store, `trash/${entry.id}/entry.json`)
  )
    throw new Error("Trash metadata is a symbolic link.");
  const saved = JSON.parse(
    await deps.fs.readFile(join(record, "entry.json"), "utf8"),
  );
  if (
    saved.id !== entry.id ||
    typeof saved.name !== "string" ||
    typeof saved.path !== "string" ||
    !saved.path.startsWith("/") ||
    saved.path.includes("\0") ||
    (entry.originalPath && saved.path !== entry.originalPath)
  )
    throw new Error("Invalid or changed Trash record.");
  if (!(await entryExists(deps, join(record, "item"))))
    throw new Error("Trash item is missing.");
  return record;
}
export async function estimateTrash(deps, entries) {
  const records = [];
  for (const entry of entries) records.push(await trashRecord(deps, entry));
  if (!records.length) return 0;
  const output = await command(deps, "du", ["-sc", "-B1", "--", ...records]);
  const total = output.trim().split("\n").pop();
  const match = /^(\d+)\s+\S/.exec(total);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    throw new Error("Cannot measure Trash allocated bytes.");
  return Number(match[1]);
}
export async function purgeTrash(deps, entries) {
  const records = [];
  // Validate the complete request before deleting any record.
  for (const entry of entries) records.push(await trashRecord(deps, entry));
  const removed = [],
    failures = [];
  for (let index = 0; index < records.length; index++) {
    try {
      // GNU rm never follows nested symlinks; only this private record is removed.
      await command(deps, "rm", ["-rf", "--", records[index]]);
      removed.push(entries[index].id);
    } catch (error) {
      failures.push({ id: entries[index].id, message: reason(error) });
    }
  }
  return { removed, failures };
}
