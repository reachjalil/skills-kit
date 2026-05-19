import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";

import { addSelection, markSkillsActivated } from "../../core/graph";
import {
  assertRepoLocalPath,
  fromRepoRelative,
  resolveRepoLocalPath,
  slugifyId,
} from "../../utils/paths";
import type {
  ManagedSymlinkManifest,
  SelectionRecord,
  SkillRecord,
  SkillsGraph,
  SkillsKitPreferences,
  SymlinkAction,
  SymlinkApplyPlan,
  SymlinkConflict,
} from "../../types";

export interface ApplySelectionInput {
  root: string;
  graph: SkillsGraph;
  preferences: SkillsKitPreferences;
  skillIds: string[];
  kitIds?: string[];
  activeSkillIds?: string[];
  query?: string;
  targetPath?: string;
  now?: Date;
}

export async function planSymlinkApply(
  input: ApplySelectionInput
): Promise<SymlinkApplyPlan> {
  if (input.preferences.harness.selection_mode !== "symlink") {
    throw new Error("Only symlink selection mode is implemented in V1.");
  }

  const targetDir = resolveRepoLocalPath(
    input.root,
    input.targetPath ?? input.preferences.harness.target_path,
    "Harness target"
  );
  await assertHarnessTargetDirectory(input.root, targetDir);
  await assertSafeHarnessTarget(input.root, targetDir);
  await assertTargetIsNotFullSkillCopy(input.root, targetDir, input.graph);

  const selectedSkillIds = [...new Set(input.skillIds)].toSorted();
  const knownSkillIds = new Set(input.graph.skills.map((skill) => skill.id));
  const unknownSkillIds = selectedSkillIds.filter(
    (skillId) => !knownSkillIds.has(skillId)
  );
  if (unknownSkillIds.length > 0) {
    throw new Error(`Unknown skill id(s): ${unknownSkillIds.join(", ")}`);
  }
  const selectedSkills = selectedSkillIds
    .map((skillId) => input.graph.skills.find((skill) => skill.id === skillId))
    .filter((skill): skill is SkillRecord => Boolean(skill));
  const manifest = await loadManagedManifest(input.root, targetDir);
  const previousManagedIds = new Set(manifest.managed_skill_ids);
  const selectedIds = new Set(selectedSkills.map((skill) => skill.id));
  const create: SymlinkAction[] = [];
  const keep: SymlinkAction[] = [];
  const remove: SymlinkAction[] = [];
  const conflicts: SymlinkConflict[] = [];

  for (const skill of selectedSkills) {
    const action = createAction(input.root, targetDir, skill);
    const targetState = await readTargetState(action.target_path);

    if (targetState.kind === "missing") {
      create.push(action);
      continue;
    }

    if (targetState.kind === "symlink") {
      const resolved = path.resolve(
        path.dirname(action.target_path),
        targetState.to
      );
      if (resolved === action.source_path) {
        keep.push(action);
      } else {
        conflicts.push({
          skill_id: skill.id,
          target_path: action.target_path,
          reason: `target symlink points to ${targetState.to}`,
        });
      }
      continue;
    }

    conflicts.push({
      skill_id: skill.id,
      target_path: action.target_path,
      reason: "target exists and is not a symlink",
    });
  }

  for (const skillId of previousManagedIds) {
    if (selectedIds.has(skillId)) {
      continue;
    }
    const skill = input.graph.skills.find(
      (candidate) => candidate.id === skillId
    );
    if (!skill) {
      remove.push({
        skill_id: skillId,
        target_path: path.join(targetDir, skillId),
        source_path: "",
      });
      continue;
    }

    const action = createAction(input.root, targetDir, skill);
    const targetState = await readTargetState(action.target_path);
    if (targetState.kind === "missing") {
      continue;
    }
    if (targetState.kind !== "symlink") {
      conflicts.push({
        skill_id: skill.id,
        target_path: action.target_path,
        reason: "managed target is no longer a symlink",
      });
      continue;
    }
    remove.push(action);
  }

  return {
    target_dir: targetDir,
    selected_skill_ids: selectedSkillIds,
    active_kit_ids: (input.kitIds ?? []).map(slugifyId).toSorted(),
    active_skill_ids: (input.activeSkillIds ?? input.skillIds).toSorted(),
    create,
    remove,
    keep,
    conflicts,
  };
}

export async function applySymlinkPlan(
  input: ApplySelectionInput,
  plan: SymlinkApplyPlan
): Promise<{
  graph: SkillsGraph;
  manifest: ManagedSymlinkManifest;
}> {
  if (plan.conflicts.length > 0) {
    const details = plan.conflicts
      .map((conflict) => `${conflict.skill_id}: ${conflict.reason}`)
      .join("; ");
    throw new Error(
      `Cannot apply selection because conflicts exist: ${details}`
    );
  }

  const targetDir = assertRepoLocalPath(
    input.root,
    plan.target_dir,
    "Harness target"
  );
  await assertHarnessTargetDirectory(input.root, targetDir);
  await mkdir(targetDir, { recursive: true });
  await assertPlanStillSafe(targetDir, plan);

  for (const action of plan.remove) {
    assertActionInsideTarget(targetDir, action);
    await removeManagedSymlink(action);
  }

  for (const action of plan.create) {
    assertActionInsideTarget(targetDir, action);
    if (await targetAlreadyPointsToSource(action)) {
      continue;
    }
    const relativeSource = path.relative(
      path.dirname(action.target_path),
      action.source_path
    );
    await symlink(relativeSource, action.target_path, "dir");
  }

  const now = input.now ?? new Date();
  const manifest: ManagedSymlinkManifest = {
    version: 1,
    generated_at: now.toISOString(),
    target_path: path.relative(input.root, targetDir).split(path.sep).join("/"),
    managed_skill_ids: plan.selected_skill_ids,
    active_kit_ids: plan.active_kit_ids,
    active_skill_ids: plan.active_skill_ids,
  };
  await writeManagedManifest(input.root, targetDir, manifest);

  const selection: SelectionRecord = {
    id: `selection-${now.getTime()}`,
    query: input.query ?? "",
    included_kit_ids: (input.kitIds ?? []).map(slugifyId),
    included_skill_ids: plan.selected_skill_ids,
    target_harness: input.preferences.harness.name,
    created_at: now.toISOString(),
  };

  return {
    graph: addSelection(
      markSkillsActivated(input.graph, {
        kitIds: plan.active_kit_ids,
        skillIds: plan.selected_skill_ids,
        activatedAt: now.toISOString(),
      }),
      selection
    ),
    manifest,
  };
}

export async function loadManagedManifest(
  root: string,
  targetDir: string
): Promise<ManagedSymlinkManifest> {
  const safeTargetDir = assertRepoLocalPath(root, targetDir, "Harness target");
  const manifestPath = getManagedManifestPath(root, safeTargetDir);
  const raw = await readFile(manifestPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return {
      version: 1,
      generated_at: "",
      target_path: safeTargetDir,
      managed_skill_ids: [],
      active_kit_ids: [],
      active_skill_ids: [],
    };
  }

  const parsed = parse(raw) as Partial<ManagedSymlinkManifest>;
  return {
    version: 1,
    generated_at:
      typeof parsed.generated_at === "string" ? parsed.generated_at : "",
    target_path:
      typeof parsed.target_path === "string"
        ? parsed.target_path
        : safeTargetDir,
    managed_skill_ids: Array.isArray(parsed.managed_skill_ids)
      ? parsed.managed_skill_ids.map(String)
      : [],
    active_kit_ids: Array.isArray(parsed.active_kit_ids)
      ? parsed.active_kit_ids.map(String)
      : [],
    active_skill_ids: Array.isArray(parsed.active_skill_ids)
      ? parsed.active_skill_ids.map(String)
      : [],
  };
}

export async function clearManagedManifest(
  root: string,
  targetDir: string,
  now = new Date()
): Promise<ManagedSymlinkManifest> {
  const safeTargetDir = assertRepoLocalPath(root, targetDir, "Harness target");
  const manifest: ManagedSymlinkManifest = {
    version: 1,
    generated_at: now.toISOString(),
    target_path: path.relative(root, safeTargetDir).split(path.sep).join("/"),
    managed_skill_ids: [],
    active_kit_ids: [],
    active_skill_ids: [],
  };
  await writeManagedManifest(root, safeTargetDir, manifest);
  return manifest;
}

export function resolveHarnessTargetDir(input: {
  root: string;
  preferences: SkillsKitPreferences;
  targetPath?: string;
}): string {
  return resolveRepoLocalPath(
    input.root,
    input.targetPath ?? input.preferences.harness.target_path,
    "Harness target"
  );
}

async function writeManagedManifest(
  root: string,
  targetDir: string,
  manifest: ManagedSymlinkManifest
): Promise<void> {
  const safeTargetDir = assertRepoLocalPath(root, targetDir, "Harness target");
  const manifestPath = getManagedManifestPath(root, safeTargetDir);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, stringify(manifest), "utf8");
}

function getManagedManifestPath(root: string, targetDir: string): string {
  const safeTargetDir = assertRepoLocalPath(root, targetDir, "Harness target");
  const relativeTarget = path
    .relative(root, safeTargetDir)
    .split(path.sep)
    .join("/");
  const manifestId = slugifyId(
    relativeTarget.replace(/^\.\//, "").replace(/^\./, "")
  );
  return path.join(
    root,
    ".agents/skills-kit/manifests",
    `${manifestId || "repo-root"}.toml`
  );
}

async function assertSafeHarnessTarget(
  root: string,
  targetDir: string
): Promise<void> {
  const sourceDir = path.resolve(root, ".agents/skills");
  const lexicalRelative = path.relative(sourceDir, targetDir);
  if (!lexicalRelative?.startsWith("..")) {
    throw new Error(
      `Harness target cannot be inside the source skill library: ${targetDir}`
    );
  }

  const sourceReal = await realpathIfExists(sourceDir);
  const targetReal = await realpathIfExists(targetDir);
  if (!sourceReal || !targetReal) {
    return;
  }

  const realRelative = path.relative(sourceReal, targetReal);
  if (!realRelative?.startsWith("..")) {
    throw new Error(
      `Harness target resolves inside the source skill library: ${targetDir}`
    );
  }
}

async function assertHarnessTargetDirectory(
  root: string,
  targetDir: string
): Promise<void> {
  const targetStat = await lstat(targetDir).catch(() => undefined);
  if (!targetStat) {
    return;
  }

  const relativeTarget = path
    .relative(root, targetDir)
    .split(path.sep)
    .join("/");
  const displayTarget = relativeTarget.startsWith("..")
    ? targetDir
    : `./${relativeTarget}`;

  if (targetStat.isSymbolicLink()) {
    throw new Error(
      `Harness target ${displayTarget} is a symlink. skills-kit needs this target to be a real directory so it can manage individual skill symlinks inside it. Remove the ${displayTarget} symlink, create a real directory at the same path, then apply again.`
    );
  }

  if (!targetStat.isDirectory()) {
    throw new Error(
      `Harness target ${displayTarget} exists but is not a directory. Remove it or replace it with a real directory, then apply again.`
    );
  }
}

async function assertTargetIsNotFullSkillCopy(
  root: string,
  targetDir: string,
  graph: SkillsGraph
): Promise<void> {
  const sourceSkillIds = graph.skills
    .filter((skill) => skill.status !== "missing_skill_md")
    .map((skill) => skill.id);
  if (sourceSkillIds.length === 0) {
    return;
  }

  const targetEntries = await readdir(targetDir, { withFileTypes: true }).catch(
    () => []
  );
  if (targetEntries.length === 0) {
    return;
  }

  const targetNames = new Set(
    targetEntries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => entry.name)
  );
  const hasEverySourceSkill = sourceSkillIds.every((skillId) =>
    targetNames.has(skillId)
  );
  if (!hasEverySourceSkill) {
    return;
  }

  const copiedSkillDirs = await Promise.all(
    sourceSkillIds.map(async (skillId) => {
      const targetSkillDir = path.join(targetDir, skillId);
      const targetState = await lstat(targetSkillDir).catch(() => undefined);
      if (!targetState?.isDirectory() || targetState.isSymbolicLink()) {
        return false;
      }

      const skillFile = await lstat(
        path.join(targetSkillDir, "SKILL.md")
      ).catch(() => undefined);
      return Boolean(skillFile?.isFile());
    })
  );

  if (copiedSkillDirs.every(Boolean)) {
    const relativeTarget = path
      .relative(root, targetDir)
      .split(path.sep)
      .join("/");
    throw new Error(
      `Harness target ./${relativeTarget} appears to contain a full copied skill library. @skills-kit/cli only manages symlink targets. Remove or move the copied skill folders, then apply again.`
    );
  }
}

async function realpathIfExists(
  targetPath: string
): Promise<string | undefined> {
  return import("node:fs/promises").then(({ realpath }) =>
    realpath(targetPath).catch(() => undefined)
  );
}

function assertActionInsideTarget(
  targetDir: string,
  action: SymlinkAction
): void {
  const relativeTarget = path.relative(targetDir, action.target_path);
  if (
    !relativeTarget ||
    relativeTarget.startsWith("..") ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(
      `Refusing to manage a symlink outside the harness target: ${action.target_path}`
    );
  }
}

async function assertPlanStillSafe(
  targetDir: string,
  plan: SymlinkApplyPlan
): Promise<void> {
  const conflicts: SymlinkConflict[] = [];

  for (const action of plan.remove) {
    assertActionInsideTarget(targetDir, action);
    const targetState = await readTargetState(action.target_path);
    if (targetState.kind === "missing") {
      continue;
    }
    if (targetState.kind !== "symlink") {
      conflicts.push({
        skill_id: action.skill_id,
        target_path: action.target_path,
        reason: "managed target is no longer a symlink",
      });
      continue;
    }
    if (
      action.source_path &&
      !symlinkPointsTo(action, targetState, action.source_path)
    ) {
      conflicts.push({
        skill_id: action.skill_id,
        target_path: action.target_path,
        reason: `managed symlink changed after planning and points to ${targetState.to}`,
      });
    }
  }

  for (const action of plan.create) {
    assertActionInsideTarget(targetDir, action);
    const targetState = await readTargetState(action.target_path);
    if (targetState.kind === "missing") {
      continue;
    }
    if (
      targetState.kind === "symlink" &&
      symlinkPointsTo(action, targetState, action.source_path)
    ) {
      continue;
    }

    conflicts.push({
      skill_id: action.skill_id,
      target_path: action.target_path,
      reason:
        targetState.kind === "symlink"
          ? `target symlink points to ${targetState.to}`
          : "target exists and is not a symlink",
    });
  }

  if (conflicts.length > 0) {
    const details = conflicts
      .map((conflict) => `${conflict.skill_id}: ${conflict.reason}`)
      .join("; ");
    throw new Error(
      `Cannot apply selection because the harness target changed after planning: ${details}`
    );
  }
}

async function removeManagedSymlink(action: SymlinkAction): Promise<void> {
  const targetState = await readTargetState(action.target_path);
  if (targetState.kind === "missing") {
    return;
  }
  if (targetState.kind !== "symlink") {
    throw new Error(
      `Refusing to remove non-symlink managed target: ${action.target_path}`
    );
  }

  await rm(action.target_path, { force: true });
}

async function targetAlreadyPointsToSource(
  action: SymlinkAction
): Promise<boolean> {
  const targetState = await readTargetState(action.target_path);
  return (
    targetState.kind === "symlink" &&
    symlinkPointsTo(action, targetState, action.source_path)
  );
}

function symlinkPointsTo(
  action: SymlinkAction,
  targetState: { kind: "symlink"; to: string },
  expectedPath: string
): boolean {
  return (
    path.resolve(path.dirname(action.target_path), targetState.to) ===
    expectedPath
  );
}

function createAction(
  root: string,
  targetDir: string,
  skill: SkillRecord
): SymlinkAction {
  return {
    skill_id: skill.id,
    source_path: fromRepoRelative(root, skill.path),
    target_path: path.join(targetDir, skill.id),
  };
}

async function readTargetState(
  targetPath: string
): Promise<
  { kind: "missing" } | { kind: "symlink"; to: string } | { kind: "other" }
> {
  const link = await readlink(targetPath).catch(() => undefined);
  if (link !== undefined) {
    return { kind: "symlink", to: link };
  }

  const exists = await lstat(targetPath)
    .then(() => true)
    .catch(() => false);
  return exists ? { kind: "other" } : { kind: "missing" };
}
