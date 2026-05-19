import { mkdir, readdir, stat } from "node:fs/promises";

import { loadGraph, mergeScannedSkills, saveGraph } from "./graph";
import { resolveWorkspacePaths } from "../utils/paths";
import {
  createDefaultPreferences,
  loadPreferences,
  savePreferences,
} from "../config/preferences";
import { scanSkills } from "./scanner";
import type {
  SkillsGraph,
  SkillsKitPreferences,
  WorkspacePaths,
} from "../types";

export interface WorkspaceState {
  paths: WorkspacePaths;
  graph: SkillsGraph;
  preferences: SkillsKitPreferences;
}

export async function ensureWorkspace(
  root = process.cwd(),
  options: {
    scan?: boolean;
  } = {}
): Promise<WorkspaceState> {
  const paths = resolveWorkspacePaths(root);
  await assertSourceSkillsAvailable(paths);
  await mkdir(paths.kitDir, { recursive: true });
  await mkdir(paths.manifestsDir, { recursive: true });
  await mkdir(paths.reportsDir, { recursive: true });
  await mkdir(paths.tmpDir, { recursive: true });

  const preferences = await loadPreferences(paths);
  await savePreferences(paths, preferences ?? createDefaultPreferences());

  const existingGraph = await loadGraph(paths);
  const graph = options.scan
    ? mergeScannedSkills(existingGraph, await scanSkills(paths))
    : existingGraph;
  await saveGraph(paths, graph);

  return {
    paths,
    graph,
    preferences,
  };
}

export async function isWorkspaceInitialized(
  root = process.cwd()
): Promise<boolean> {
  const paths = resolveWorkspacePaths(root);
  return stat(paths.graphPath)
    .then((entry) => entry.isFile())
    .catch(() => false);
}

export async function assertSourceSkillsReady(
  root = process.cwd()
): Promise<void> {
  await assertSourceSkillsAvailable(resolveWorkspacePaths(root));
}

async function assertSourceSkillsAvailable(
  paths: WorkspacePaths
): Promise<void> {
  const sourceDir = await stat(paths.sourceSkillsDir).catch(() => undefined);
  if (!sourceDir?.isDirectory()) {
    throw new Error(
      "@skills-kit/cli requires ./.agents/skills with at least one skill. Add source skills, then run `npx @skills-kit/cli` again."
    );
  }

  const entries = await readdir(paths.sourceSkillsDir, {
    withFileTypes: true,
  });
  const hasSkill = entries.some(
    (entry) => !entry.name.startsWith(".") && entry.isDirectory()
  );
  if (!hasSkill) {
    throw new Error(
      "@skills-kit/cli requires at least one skill in ./.agents/skills. Add source skills, then run `npx @skills-kit/cli` again."
    );
  }
}
