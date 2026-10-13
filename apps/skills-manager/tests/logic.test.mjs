import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, serializeSkill, validateSkillName, slugify, yamlScalar } from "../lib/frontmatter.js";
import { skillsInTree, groupDiscover, recordFirstSeen, searchSkills, filterLocal, sortSkills, truncate, isTextFile, RECOMMENDED, GROUP_SIZE } from "../lib/catalog.js";
import { parseStat, statArgs, resolveLink, isInside, tildify } from "../lib/stat.js";

test("frontmatter: plain, quoted, folded, literal and continued values", () => {
  const text = [
    "---",
    "name: pdf",
    'description: "Use it: for PDFs, \\"always\\""',
    "license: Proprietary # see LICENSE",
    "summary: >",
    "  first line",
    "  second line",
    "",
    "  next paragraph",
    "notes: |",
    "  keep",
    "    indent",
    "long: starts here",
    "  and continues",
    "quote: 'it''s'",
    "---",
    "# Body",
  ].join("\n");
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  assert.equal(hasFrontmatter, true);
  assert.equal(data.name, "pdf");
  assert.equal(data.description, 'Use it: for PDFs, "always"');
  assert.equal(data.license, "Proprietary");
  assert.equal(data.summary, "first line second line\nnext paragraph");
  assert.equal(data.notes, "keep\n  indent");
  assert.equal(data.long, "starts here and continues");
  assert.equal(data.quote, "it's");
  assert.equal(body, "# Body");
});

test("frontmatter: missing block and CRLF", () => {
  assert.deepEqual(parseFrontmatter("# just text").data, {});
  assert.equal(parseFrontmatter("---\r\nname: x\r\n---\r\nhi").data.name, "x");
});

test("serializeSkill round-trips awkward descriptions", () => {
  for (const description of ["Plain words", "Has: colon", "- leading dash", "true", 'quote "inside"', "#hash"]) {
    const { data, body } = parseFrontmatter(serializeSkill({ name: "my-skill", description, body: "Do it." }));
    assert.equal(data.name, "my-skill");
    assert.equal(data.description, description);
    assert.equal(body.trim(), "Do it.");
  }
  assert.equal(yamlScalar("simple"), "simple");
});

test("skill names", () => {
  assert.equal(validateSkillName("meeting-prep"), null);
  assert.ok(validateSkillName("Meeting Prep"));
  assert.ok(validateSkillName("a--b"));
  assert.ok(validateSkillName("x".repeat(65)));
  assert.equal(slugify("  Café Notes: v2! "), "cafe-notes-v2");
});

test("skillsInTree finds one level of skills and their files", () => {
  const source = { repo: "o/r", branch: "main", prefix: "skills/", author: "O" };
  const tree = [
    { path: "skills/pdf/SKILL.md", type: "blob", sha: "1", size: 10 },
    { path: "skills/pdf/scripts/a.py", type: "blob", sha: "2", size: 20 },
    { path: "skills/pdf/scripts", type: "tree", sha: "3" },
    { path: "skills/deep/x/SKILL.md", type: "blob", sha: "4", size: 1 },
    { path: "skills/.hidden/SKILL.md", type: "blob", sha: "5", size: 1 },
    { path: "template/SKILL.md", type: "blob", sha: "6", size: 1 },
  ];
  const found = skillsInTree(source, tree);
  assert.deepEqual(found.map((s) => s.dirName), ["pdf"]);
  assert.deepEqual(found[0].files, [
    { path: "SKILL.md", sha: "1", size: 10 },
    { path: "scripts/a.py", sha: "2", size: 20 },
  ]);
});

const remote = (id, stars, pushedAt = "2026-01-01") => {
  const [repo, dirName] = id.split(":");
  return { id, repo, author: repo, dirName, name: dirName, description: `${dirName} does things`, path: dirName, stars, pushedAt, files: [] };
};

test("groupDiscover: curated, then first-seen, then stars, no duplicates", () => {
  const skills = [
    ...RECOMMENDED.slice(0, 2).map((id) => remote(id, 100)),
    ...Array.from({ length: 20 }, (_, i) => remote(`x/y:s${String(i).padStart(2, "0")}`, i)),
    remote("z/z:fresh", 1),
  ];
  const groups = groupDiscover(skills, { "z/z:fresh": 50, "x/y:s00": 40 });
  const [rec, fresh, popular, all] = groups;
  assert.deepEqual(rec.skills.map((s) => s.id), RECOMMENDED.slice(0, 2));
  assert.equal(fresh.skills[0].id, "z/z:fresh");
  assert.equal(fresh.skills[1].id, "x/y:s00");
  assert.equal(popular.skills[0].id, "x/y:s19");
  const ids = groups.flatMap((g) => g.skills.map((s) => s.id));
  assert.equal(new Set(ids).size, skills.length);
  assert.ok(fresh.skills.length <= GROUP_SIZE);
  assert.equal(all.title, "All skills");
});

test("recordFirstSeen keeps a baseline at zero, then dates newcomers", () => {
  const first = recordFirstSeen({}, ["a", "b"], 1000);
  assert.deepEqual(first, { a: 0, b: 0 });
  assert.deepEqual(recordFirstSeen(first, ["a", "c"], 2000), { a: 0, b: 0, c: 2000 });
});

test("search, filter and sort", () => {
  const local = [
    { name: "beta", dirName: "beta", description: "Writes PDFs", rootId: "claude", rootLabel: "Claude", enabled: true, linked: false, error: null, mtime: 3 },
    { name: "alpha", dirName: "alpha", description: "Reads mail", rootId: "codex", rootLabel: "Codex", enabled: false, linked: true, error: null, mtime: 5 },
    { name: "gamma", dirName: "gamma", description: "", rootId: "claude", rootLabel: "Claude", enabled: true, linked: true, error: "denied", mtime: null },
  ];
  assert.deepEqual(searchSkills(local, "pdf").map((s) => s.name), ["beta"]);
  assert.deepEqual(searchSkills(local, "codex mail").map((s) => s.name), ["alpha"]);
  assert.equal(searchSkills(local, "  ").length, 3);
  assert.deepEqual(filterLocal(local, { root: "claude", status: "all" }).map((s) => s.name), ["beta", "gamma"]);
  assert.deepEqual(filterLocal(local, { root: "all", status: "disabled" }).map((s) => s.name), ["alpha"]);
  assert.deepEqual(filterLocal(local, { root: "all", status: "enabled" }).map((s) => s.name), ["beta"]);
  assert.deepEqual(filterLocal(local, { root: "all", status: "linked" }).map((s) => s.name), ["alpha", "gamma"]);
  assert.deepEqual(filterLocal(local, { root: "all", status: "broken" }).map((s) => s.name), ["gamma"]);
  assert.deepEqual(sortSkills(local, "name", (s) => s.mtime ?? 0).map((s) => s.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(sortSkills(local, "recent", (s) => s.mtime ?? 0).map((s) => s.name), ["alpha", "beta", "gamma"]);
});

test("truncate and text detection", () => {
  assert.equal(truncate("short"), "short");
  const cut = truncate("word ".repeat(50), 40);
  assert.ok(cut.length <= 40 && cut.endsWith("…"));
  assert.ok(isTextFile("scripts/run.py") && isTextFile("LICENSE") && isTextFile("a/b.md"));
  assert.ok(!isTextFile("fonts/x.ttf") && !isTextFile("img.png"));
});

test("stat parsing on BSD and GNU", () => {
  const bsd = parseStat("darwin", "1700000000\tSymbolic Link\t/r/a\t../../x/a\n1700000001\tDirectory\t/r/b\t\n1\tRegular File\t/r/c\t\n");
  assert.deepEqual(bsd.get("/r/a"), { name: "/r/a", kind: "link", mtime: 1700000000000, target: "../../x/a" });
  assert.equal(bsd.get("/r/b").kind, "dir");
  assert.equal(bsd.get("/r/c").kind, "file");
  const gnu = parseStat("linux", "5\tsymbolic link\t/r/a\t'/r/a' -> '/opt/a'\n6\tdirectory\t/r/b\t'/r/b'\n");
  assert.equal(gnu.get("/r/a").target, "/opt/a");
  assert.equal(gnu.get("/r/b").kind, "dir");
  assert.deepEqual(statArgs("darwin", ["/p"], { follow: true }).slice(0, 2), ["-L", "-f"]);
  assert.equal(statArgs("linux", ["/p"])[0], "-c");
});

test("paths", () => {
  assert.equal(resolveLink("/h/.claude/skills/x", "../../.agents/skills/x"), "/h/.agents/skills/x");
  assert.equal(resolveLink("/h/a/x", "/abs/x"), "/abs/x");
  assert.ok(isInside("/h/a/b", "/h/a") && isInside("/h/a", "/h/a/") && !isInside("/h/ab", "/h/a"));
  assert.equal(tildify("/h/.claude/skills", "/h"), "~/.claude/skills");
});
