#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmEnv } from "./npm-env.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = mkdtempSync(path.join(tmpdir(), "skills-kit-smoke-"));
const packDir = path.join(tmpRoot, "pack");
const fixtureDir = path.join(tmpRoot, "fixture-repo");

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: npmEnv({ SKILLS_KIT_ROOT: cwd }),
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(path.join(fixtureDir, ".agents", "skills", "frontend-design"), {
    recursive: true,
  });
  writeFileSync(
    path.join(fixtureDir, ".agents", "skills", "frontend-design", "SKILL.md"),
    [
      "# frontend-design",
      "",
      "Use when working on focused frontend design tasks.",
      "",
    ].join("\n")
  );

  run("npm", ["pack", "--pack-destination", packDir], packageDir);

  const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`npm pack did not create a tarball in ${packDir}`);
  }

  const tarballPath = path.join(packDir, tarball);
  run("npm", ["init", "-y"], fixtureDir);
  run("npm", ["install", tarballPath], fixtureDir);
  run("npx", ["skills-kit", "--help"], fixtureDir);
  run("npx", ["skills-kit", "status"], fixtureDir);
  run(
    "npx",
    ["skills-kit", "kit", "create", "ui", "frontend-design"],
    fixtureDir
  );
  run(
    "npx",
    ["skills-kit", "update", "--targets", "codex,claude", "--kits", "ui"],
    fixtureDir
  );

  for (const target of [".codex/skills", ".claude/skills"]) {
    const linkedSkill = path.join(fixtureDir, target, "frontend-design");
    if (!lstatSync(linkedSkill).isSymbolicLink()) {
      throw new Error(`${linkedSkill} was not created as a symlink`);
    }
  }

  const graphText = readFileSync(
    path.join(fixtureDir, ".agents/skills-kit/skills-graph.toml"),
    "utf8"
  );
  const selectionCount = graphText.match(/\[\[selections\]\]/g)?.length ?? 0;
  if (selectionCount < 2) {
    throw new Error("Multi-target update should record each target selection");
  }

  console.log("skills-kit tarball smoke test passed.");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
