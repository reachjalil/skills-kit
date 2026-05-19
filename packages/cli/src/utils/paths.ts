import path from "node:path";

import type { WorkspacePaths } from "../types";

export function assertRepoLocalPath(
  root: string,
  absolutePath: string,
  label = "Path"
): string {
  const absoluteRoot = path.resolve(root);
  const resolvedPath = path.resolve(absolutePath);
  const relative = path.relative(absoluteRoot, resolvedPath);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `${label} must stay inside the repo: ${path.relative(process.cwd(), resolvedPath) || resolvedPath}`
    );
  }

  return resolvedPath;
}

export function resolveWorkspacePaths(root = process.cwd()): WorkspacePaths {
  const absoluteRoot = path.resolve(root);
  const agentsDir = path.join(absoluteRoot, ".agents");
  const kitDir = path.join(agentsDir, "skills-kit");

  return {
    root: absoluteRoot,
    agentsDir,
    sourceSkillsDir: path.join(agentsDir, "skills"),
    kitDir,
    graphPath: path.join(kitDir, "skills-graph.toml"),
    preferencesPath: path.join(kitDir, "skills-preferences.toml"),
    manifestsDir: path.join(kitDir, "manifests"),
    reportsDir: path.join(kitDir, "reports"),
    tmpDir: path.join(kitDir, "tmp"),
  };
}

export function toRepoRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative.split(path.sep).join("/");
}

export function fromRepoRelative(root: string, relativePath: string): string {
  return resolveRepoLocalPath(root, relativePath, "Skill path");
}

export function resolveRepoLocalPath(
  root: string,
  relativePath: string,
  label = "Path"
): string {
  return assertRepoLocalPath(root, path.resolve(root, relativePath), label);
}

export function slugifyId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
