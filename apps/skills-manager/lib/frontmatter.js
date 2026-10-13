// @ts-check
// SKILL.md files open with a YAML frontmatter block. Skills only use a flat
// mapping of scalars (`name`, `description`, `license`, …), so this reads that
// subset — plain, quoted, folded (`>`) and literal (`|`) scalars, and plain
// values continued on indented lines — rather than all of YAML.

/**
 * @typedef {{ data: Record<string, string>, body: string, hasFrontmatter: boolean }} ParsedSkill
 */

/** @param {string} text @returns {ParsedSkill} */
export function parseFrontmatter(text) {
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { data: {}, body: source, hasFrontmatter: false };
  return { data: parseMapping(match[1]), body: source.slice(match[0].length), hasFrontmatter: true };
}

/** @param {string} block */
function parseMapping(block) {
  /** @type {Record<string, string>} */
  const data = {};
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const pair = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/.exec(line);
    if (!pair) continue;
    const key = pair[1];
    let value = (pair[2] ?? "").trim();

    // Lines indented under the key belong to it.
    const continuation = [];
    while (index + 1 < lines.length && (/^[ \t]+\S/.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
      if (lines[index + 1].trim() === "" && !/^[|>]/.test(value)) {
        // A blank line ends a plain scalar unless a following line is still indented.
        const rest = lines.slice(index + 1).find((l) => l.trim() !== "");
        if (!rest || !/^[ \t]+/.test(rest)) break;
      }
      continuation.push(lines[++index]);
    }

    if (/^[|>][+-]?$/.test(value)) {
      const indent = Math.min(...continuation.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
      const body = continuation.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = value.startsWith("|") ? body.join("\n").trim() : foldLines(body);
    } else if (value.startsWith('"')) {
      data[key] = unquoteDouble([value, ...continuation.map((l) => l.trim())].join(" "));
    } else if (value.startsWith("'")) {
      data[key] = unquoteSingle([value, ...continuation.map((l) => l.trim())].join(" "));
    } else {
      data[key] = stripComment([value, ...continuation.map((l) => l.trim())].filter(Boolean).join(" "));
    }
  }
  return data;
}

/** Folded scalars join lines with spaces; blank lines become breaks. @param {string[]} lines */
function foldLines(lines) {
  return lines
    .join("\n")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split("\n").map((l) => l.trim()).join(" "))
    .join("\n");
}

/** @param {string} value */
function stripComment(value) {
  const hash = value.search(/\s#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/** @param {string} value */
function unquoteDouble(value) {
  const end = value.lastIndexOf('"');
  const inner = value.slice(1, end > 0 ? end : undefined);
  return inner.replace(/\\(["\\nt])/g, (_, c) => ({ n: "\n", t: "\t" })[c] ?? c);
}

/** @param {string} value */
function unquoteSingle(value) {
  const end = value.lastIndexOf("'");
  return value.slice(1, end > 0 ? end : undefined).replace(/''/g, "'");
}

/**
 * Writes a SKILL.md. Values are double-quoted whenever plain YAML could
 * misread them, so a description with a colon or a leading dash survives.
 * @param {{ name: string, description: string, body?: string }} skill
 */
export function serializeSkill({ name, description, body = "" }) {
  const lines = ["---", `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`, "---", ""];
  const text = body.trim() || `# ${name}\n\nDescribe when and how the agent should use this skill.`;
  return `${lines.join("\n")}\n${text}\n`;
}

/** @param {string} value */
export function yamlScalar(value) {
  const single = value.replace(/\s*\n\s*/g, " ").trim();
  if (single === "" || /^[\s\-?:,\[\]{}#&*!|>'"%@`]|:\s|\s#|:$/.test(single) || /^(true|false|null|yes|no|~|[-+]?\d)/i.test(single)) {
    return `"${single.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return single;
}

/**
 * Skill names follow the agent-skills convention: lowercase letters, digits
 * and hyphens, at most 64 characters. Answers an error sentence, or null.
 * @param {string} name
 */
export function validateSkillName(name) {
  if (!name) return "Enter a name.";
  if (name.length > 64) return "Use at most 64 characters.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return "Use lowercase letters, digits and single hyphens.";
  return null;
}

/** Turns a title into a valid skill name. @param {string} title */
export function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}
