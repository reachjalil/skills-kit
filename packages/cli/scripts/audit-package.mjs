#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { npmEnv } from "./npm-env.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = mkdtempSync(path.join(tmpdir(), "skills-kit-audit-"));
const packDir = path.join(tmpRoot, "pack");
const auditDir = path.join(tmpRoot, "audit-project");

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: npmEnv(),
  });
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });

  run("npm", ["pack", "--pack-destination", packDir], packageDir);

  const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`npm pack did not create a tarball in ${packDir}`);
  }

  run("npm", ["init", "-y"], auditDir);
  run(
    "npm",
    ["install", "--ignore-scripts", "--omit=dev", path.join(packDir, tarball)],
    auditDir
  );
  run("npm", ["audit", "--omit=dev", "--audit-level=low"], auditDir);

  console.log("skills-kit package dependency audit passed.");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
