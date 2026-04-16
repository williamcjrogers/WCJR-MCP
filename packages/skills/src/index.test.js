import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __test,
  findSkillByTrigger,
  getSkill,
  listSkills,
  loadSkills
} from "./index.js";

const { parseFrontmatter, splitFrontmatter, validateSkill } = __test;

test("parseFrontmatter handles scalars, booleans, numbers, quoted, inline lists", () => {
  const input = [
    'name: writing-plans',
    'description: "Turn a spec into a plan."',
    'triggers: ["/plan", "plan this", create a plan]',
    "tags: [process, plan]",
    "internalOnly: false",
    "version: 0.1.0"
  ].join("\n");
  const parsed = parseFrontmatter(input);
  assert.equal(parsed.name, "writing-plans");
  assert.equal(parsed.description, "Turn a spec into a plan.");
  assert.deepEqual(parsed.triggers, ["/plan", "plan this", "create a plan"]);
  assert.deepEqual(parsed.tags, ["process", "plan"]);
  assert.equal(parsed.internalOnly, false);
  assert.equal(parsed.version, "0.1.0");
});

test("splitFrontmatter extracts header and body", () => {
  const raw = [
    "---",
    "name: demo",
    "description: example",
    "---",
    "",
    "# Body",
    "Hello."
  ].join("\n");
  const { frontmatter, body } = splitFrontmatter(raw);
  assert.equal(frontmatter.name, "demo");
  assert.ok(body.startsWith("# Body"));
});

test("validateSkill rejects missing name or description", () => {
  assert.equal(validateSkill(null), null);
  assert.equal(validateSkill({ description: "no name" }), null);
  assert.equal(validateSkill({ name: "no desc" }), null);
  const ok = validateSkill({ name: "x", description: "y", body: "z" });
  assert.ok(ok);
  assert.equal(ok.name, "x");
});

test("loadSkills reads SKILL.md files, applies last-wins, and collects diagnostics", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-skills-"));
  const dirA = path.join(tmp, "a", "demo");
  const dirB = path.join(tmp, "b", "demo");
  const dirBad = path.join(tmp, "a", "bad");
  await fs.mkdir(dirA, { recursive: true });
  await fs.mkdir(dirB, { recursive: true });
  await fs.mkdir(dirBad, { recursive: true });

  await fs.writeFile(
    path.join(dirA, "SKILL.md"),
    [
      "---",
      "name: demo",
      "description: first copy",
      "triggers: [/demo]",
      "---",
      "first body"
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(dirB, "SKILL.md"),
    [
      "---",
      "name: demo",
      "description: second copy (should win)",
      "triggers: [/demo, demo-trigger]",
      "---",
      "second body"
    ].join("\n"),
    "utf-8"
  );

  await fs.writeFile(
    path.join(dirBad, "SKILL.md"),
    ["---", "description: missing-name", "---"].join("\n"),
    "utf-8"
  );

  const { registry, diagnostics } = await loadSkills([
    path.join(tmp, "a"),
    path.join(tmp, "b")
  ]);

  const demo = getSkill(registry, "demo");
  assert.ok(demo);
  assert.equal(demo.description, "second copy (should win)");
  assert.ok(demo.body.includes("second body"));
  assert.deepEqual(demo.triggers, ["/demo", "demo-trigger"]);

  const overrideNote = diagnostics.find((d) => d.message.includes("overriding"));
  assert.ok(overrideNote, "expected an override diagnostic");
  const skipNote = diagnostics.find((d) => d.message.includes("missing name"));
  assert.ok(skipNote, "expected a missing-name diagnostic");
});

test("findSkillByTrigger matches slash commands and body triggers", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-skills-trig-"));
  const skillDir = path.join(tmp, "brainstorming");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: brainstorming",
      "description: explore requirements",
      "triggers: [/brainstorm, lets brainstorm]",
      "---",
      "Body."
    ].join("\n"),
    "utf-8"
  );
  const { registry } = await loadSkills([tmp]);
  assert.ok(findSkillByTrigger(registry, "/brainstorm"));
  assert.ok(findSkillByTrigger(registry, "/brainstorming follow-up"));
  assert.ok(findSkillByTrigger(registry, "lets brainstorm this"));
  assert.equal(findSkillByTrigger(registry, "unrelated"), null);
});

test("listSkills filters internal-only and by tag", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wcjr-skills-list-"));
  await fs.mkdir(path.join(tmp, "public"), { recursive: true });
  await fs.mkdir(path.join(tmp, "hidden"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "public", "SKILL.md"),
    [
      "---",
      "name: public",
      "description: open",
      "tags: [process]",
      "---",
      "body"
    ].join("\n")
  );
  await fs.writeFile(
    path.join(tmp, "hidden", "SKILL.md"),
    [
      "---",
      "name: hidden",
      "description: internal",
      "internalOnly: true",
      "tags: [process]",
      "---",
      "body"
    ].join("\n")
  );
  const { registry } = await loadSkills([tmp]);
  const visible = listSkills(registry, { includeInternal: false });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].name, "public");
  const all = listSkills(registry);
  assert.equal(all.length, 2);
  const byTag = listSkills(registry, { tag: "process" });
  assert.equal(byTag.length, 2);
});
