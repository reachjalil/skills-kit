import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";

import {
  applySelection,
  createOrUpdateKit,
  getCurrentActivation,
  scanRepo,
} from "../../core/commands";
import { getConfiguredHarnessTargets } from "./health";
import { slugifyId } from "../../utils/paths";
import {
  describeHarnessTargetDirectoryIssue,
  loadManagedManifest,
  resolveHarnessTargetDir,
} from "./symlinks";
import type { HarnessTargetRecord } from "../../types";
import type { WorkspaceState } from "../../core/workspace";

export interface LegacyCompatibleEntry {
  target: HarnessTargetRecord;
  targetDir: string;
  skillId: string;
  sourcePath: string;
  targetPath: string;
  originPath?: string;
  kind:
    | "source-symlink"
    | "identical-copy"
    | "external-identical-symlink"
    | "migrate-directory"
    | "migrate-external-symlink";
}

export interface LegacyWarning {
  target: HarnessTargetRecord;
  targetPath: string;
  name: string;
  reason: string;
}

export interface LegacyHarnessInspection {
  compatible: LegacyCompatibleEntry[];
  warnings: LegacyWarning[];
}

export interface LegacyImportResult {
  graph: WorkspaceState["graph"];
  createdKitIds: string[];
  normalized: number;
  migrated: number;
  managedTargets: number;
}

export async function inspectLegacyHarnessEntries(
  state: WorkspaceState,
  options: { includeManagedTargets?: boolean } = {}
): Promise<LegacyHarnessInspection> {
  const compatible: LegacyCompatibleEntry[] = [];
  const warnings: LegacyWarning[] = [];
  const skillsById = new Map(
    state.graph.skills.map((skill) => [skill.id, skill])
  );

  for (const target of getConfiguredHarnessTargets(state)) {
    const targetDir = resolveHarnessTargetDir({
      root: state.paths.root,
      preferences: state.preferences,
      targetPath: target.target_path,
    });
    const manifest = await loadManagedManifest(state.paths.root, targetDir);
    if (
      !options.includeManagedTargets &&
      (manifest.managed_skill_ids.length > 0 ||
        manifest.active_kit_ids.length > 0 ||
        manifest.active_skill_ids.length > 0)
    ) {
      continue;
    }
    const managedSkillIds = new Set(manifest.managed_skill_ids);
    const targetDirectoryIssue = await describeHarnessTargetDirectoryIssue(
      state.paths.root,
      targetDir
    );
    if (targetDirectoryIssue) {
      warnings.push({
        target,
        targetPath: targetDir,
        name: target.target_path,
        reason: targetDirectoryIssue,
      });
      continue;
    }

    const entries = await readdir(targetDir, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (options.includeManagedTargets && managedSkillIds.has(entry.name)) {
        continue;
      }

      const targetPath = path.join(targetDir, entry.name);
      const skill = skillsById.get(entry.name);
      if (!skill) {
        const migratable = await inspectMigratableTargetEntry({
          entryName: entry.name,
          entryIsSymbolicLink: entry.isSymbolicLink(),
          entryIsDirectory: entry.isDirectory(),
          sourcePath: path.join(state.paths.sourceSkillsDir, entry.name),
          targetPath,
        });
        if (migratable) {
          compatible.push({
            target,
            targetDir,
            skillId: entry.name,
            sourcePath: migratable.sourcePath,
            targetPath,
            originPath: migratable.originPath,
            kind: migratable.kind,
          });
          continue;
        }

        warnings.push({
          target,
          targetPath,
          name: entry.name,
          reason: "entry is not a known source skill in ./.agents/skills",
        });
        continue;
      }
      if (skill.status === "missing_skill_md") {
        warnings.push({
          target,
          targetPath,
          name: entry.name,
          reason:
            "matching source skill exists in ./.agents/skills but is missing SKILL.md",
        });
        continue;
      }

      const sourcePath = path.resolve(state.paths.root, skill.path);
      if (entry.isSymbolicLink()) {
        const linkTarget = await readlink(targetPath);
        const resolved = path.resolve(path.dirname(targetPath), linkTarget);
        if (resolved === sourcePath) {
          compatible.push({
            target,
            targetDir,
            skillId: skill.id,
            sourcePath,
            targetPath,
            kind: "source-symlink",
          });
        } else if (await directoriesMatch(sourcePath, resolved)) {
          compatible.push({
            target,
            targetDir,
            skillId: skill.id,
            sourcePath,
            targetPath,
            originPath: resolved,
            kind: "external-identical-symlink",
          });
        } else {
          warnings.push({
            target,
            targetPath,
            name: entry.name,
            reason: `symlink points outside ./.agents/skills and differs from the source skill (${linkTarget})`,
          });
        }
        continue;
      }

      if (!entry.isDirectory()) {
        warnings.push({
          target,
          targetPath,
          name: entry.name,
          reason: "entry exists but is not a skill symlink or directory",
        });
        continue;
      }

      if (await directoriesMatch(sourcePath, targetPath)) {
        compatible.push({
          target,
          targetDir,
          skillId: skill.id,
          sourcePath,
          targetPath,
          kind: "identical-copy",
        });
      } else {
        warnings.push({
          target,
          targetPath,
          name: entry.name,
          reason:
            "directory differs from the matching source skill; skills-kit cannot replace it safely",
        });
      }
    }
  }

  return { compatible, warnings };
}

export async function importLegacyHarnessEntries(
  state: WorkspaceState,
  compatible: LegacyCompatibleEntry[],
  options: { normalizeCopies?: boolean; mergeExistingActivation?: boolean } = {}
): Promise<LegacyImportResult> {
  let graph = state.graph;
  let normalized = 0;
  let migrated = 0;

  for (const entry of compatible) {
    if (isMigratableKind(entry.kind) && options.normalizeCopies) {
      await migrateTargetSkillToSource(entry);
      migrated += 1;
      continue;
    }
    if (isNormalizableKind(entry.kind) && options.normalizeCopies) {
      await replaceWithSourceSymlink(entry);
      normalized += 1;
    }
  }
  if (migrated > 0) {
    graph = (await scanRepo(state.paths.root)).graph;
  }

  const kitGroups = buildLegacyKitGroups(compatible);

  const createdKitIds: string[] = [];
  for (const group of kitGroups) {
    const kitName = formatLegacyKitName(group.targets);
    graph = await createOrUpdateKit(
      { ...state, graph },
      {
        name: kitName,
        description:
          "Imported from pre-existing harness skills during skills-kit setup.",
        skillIds: group.skillIds.toSorted(),
        tags: ["legacy"],
        reason:
          "Preserve the active harness state that existed before skills-kit.",
      }
    );
    createdKitIds.push(slugifyId(kitName));
  }

  for (const target of getConfiguredHarnessTargets({ ...state, graph })) {
    const legacyKitIds = createdKitIds.filter((kitId) => {
      const kit = graph.kits.find((candidate) => candidate.id === kitId);
      if (!kit) {
        return false;
      }
      return kit.skill_ids.some((skillId) =>
        compatible.some(
          (entry) =>
            entry.skillId === skillId &&
            entry.target.target_path === target.target_path
        )
      );
    });
    if (legacyKitIds.length === 0) {
      continue;
    }
    const currentActivation = options.mergeExistingActivation
      ? await getCurrentActivation({ ...state, graph }, target.target_path)
      : undefined;
    const kitIds = uniqueSorted([
      ...(currentActivation?.activeKitIds ?? []),
      ...legacyKitIds,
    ]);
    const result = await applySelection(
      { ...state, graph },
      {
        kitIds,
        skillIds: currentActivation?.activeSkillIds,
        targetPath: target.target_path,
        query: "legacy harness import",
      }
    );
    graph = result.graph;
  }

  return {
    graph,
    createdKitIds: createdKitIds.toSorted(),
    normalized,
    migrated,
    managedTargets: new Set(compatible.map((entry) => entry.target.target_path))
      .size,
  };
}

export function countLegacyReviewItems(
  inspection: LegacyHarnessInspection
): number {
  return inspection.compatible.length + inspection.warnings.length;
}

export function formatLegacyImportPreview(
  inspection: LegacyHarnessInspection,
  importable: LegacyCompatibleEntry[],
  options: { normalizeCopies?: boolean } = {}
): string {
  const lines = [
    "Source skills in ./.agents/skills stay untouched.",
    "",
    "Existing target skills:",
    ...formatLegacyTargetSummary(inspection),
  ];
  const groups = buildLegacyKitGroups(importable);

  if (groups.length > 0) {
    lines.push(
      "",
      "Will create or update legacy kits:",
      ...groups.map(
        (group) =>
          `- ${slugifyId(formatLegacyKitName(group.targets))}: ${formatCount(group.skillIds.length, "skill")}`
      )
    );
  }

  const normalizing = importable.filter((entry) =>
    isNormalizableKind(entry.kind)
  );
  if (normalizing.length > 0 && options.normalizeCopies) {
    lines.push(
      "",
      "Will normalize:",
      `- ${formatCount(normalizing.length, "target skill")} replaced with symlinks to ./.agents/skills.`
    );
  }

  const migrating = importable.filter((entry) => isMigratableKind(entry.kind));
  if (migrating.length > 0 && options.normalizeCopies) {
    lines.push(
      "",
      "Will migrate:",
      `- ${formatCount(migrating.length, "target skill")} copied into ./.agents/skills, then replaced with managed symlinks.`
    );
  }

  if (inspection.warnings.length > 0) {
    lines.push(
      "",
      "Will not touch:",
      ...inspection.warnings
        .slice(0, 10)
        .map(
          (warning) =>
            `- ${labelForHarness(warning.target)} ${warning.name}: ${warning.reason}`
        )
    );
    if (inspection.warnings.length > 10) {
      lines.push(`... ${inspection.warnings.length - 10} more`);
    }
  }

  return lines.join("\n");
}

export function formatLegacyImportWarningSummary(
  inspection: LegacyHarnessInspection
): string {
  const lines = [
    "Some existing target entries are not safe for skills-kit to manage automatically.",
    "",
    "skills-kit can manage entries only when they are symlinks to ./.agents/skills or copied skill folders that match the source exactly.",
  ];

  if (inspection.warnings.length > 0) {
    lines.push(
      "",
      "Needs review:",
      ...inspection.warnings
        .slice(0, 10)
        .map(
          (warning) =>
            `- ${labelForHarness(warning.target)} ${warning.name}: ${warning.reason}`
        )
    );
    if (inspection.warnings.length > 10) {
      lines.push(`... ${inspection.warnings.length - 10} more`);
    }
  }

  const normalizable = inspection.compatible.filter((entry) =>
    isNormalizableKind(entry.kind)
  );
  if (normalizable.length > 0) {
    lines.push(
      "",
      "Can normalize:",
      `- ${formatCount(normalizable.length, "target skill")} match ./.agents/skills exactly.`,
      "- If you choose normalize, skills-kit replaces each matching target copy or external symlink with a symlink to the source skill.",
      "- Source skills stay untouched.",
      "- Target entries with differences are not changed."
    );
  }

  const migratable = inspection.compatible.filter((entry) =>
    isMigratableKind(entry.kind)
  );
  if (migratable.length > 0) {
    lines.push(
      "",
      "Can migrate:",
      `- ${formatCount(migratable.length, "target skill")} are valid skills that are not yet in ./.agents/skills.`,
      "- If you choose normalize, skills-kit copies each target skill into ./.agents/skills first.",
      "- Then it replaces the target entry with a symlink to the new source skill.",
      "- Existing source skills are not overwritten."
    );
  }

  return lines.join("\n");
}

export function formatLegacyImportResult(result: LegacyImportResult): string {
  return [
    `Legacy kits: ${result.createdKitIds.join(", ") || "none"}`,
    `Managed targets: ${result.managedTargets}`,
    `Normalized target entries: ${result.normalized}`,
    `Migrated target skills: ${result.migrated}`,
  ].join("\n");
}

function buildLegacyKitGroups(
  compatible: LegacyCompatibleEntry[]
): Array<{ targets: HarnessTargetRecord[]; skillIds: string[] }> {
  const bySkill = new Map<string, LegacyCompatibleEntry[]>();
  for (const entry of compatible) {
    const entries = bySkill.get(entry.skillId) ?? [];
    entries.push(entry);
    bySkill.set(entry.skillId, entries);
  }

  const byTargetKey = new Map<
    string,
    { targets: HarnessTargetRecord[]; skillIds: string[] }
  >();
  for (const [skillId, entries] of bySkill) {
    const targets = entries
      .map((entry) => entry.target)
      .toSorted((a, b) => targetSlug(a).localeCompare(targetSlug(b)));
    const key = targets.map(targetSlug).join("|");
    const group = byTargetKey.get(key) ?? { targets, skillIds: [] };
    group.skillIds.push(skillId);
    byTargetKey.set(key, group);
  }

  return [...byTargetKey.values()].map((group) => ({
    targets: group.targets,
    skillIds: group.skillIds.toSorted(),
  }));
}

function formatLegacyTargetSummary(
  inspection: LegacyHarnessInspection
): string[] {
  const byTarget = new Map<
    string,
    {
      target: HarnessTargetRecord;
      sourceSymlinks: number;
      copiedMatches: number;
      externalMatches: number;
      migrations: number;
      warnings: number;
    }
  >();
  for (const entry of inspection.compatible) {
    const summary = legacyTargetSummary(byTarget, entry.target);
    if (entry.kind === "source-symlink") {
      summary.sourceSymlinks += 1;
    } else if (entry.kind === "identical-copy") {
      summary.copiedMatches += 1;
    } else if (entry.kind === "external-identical-symlink") {
      summary.externalMatches += 1;
    } else {
      summary.migrations += 1;
    }
  }
  for (const warning of inspection.warnings) {
    legacyTargetSummary(byTarget, warning.target).warnings += 1;
  }

  return [...byTarget.values()]
    .toSorted((a, b) =>
      targetSlug(a.target).localeCompare(targetSlug(b.target))
    )
    .map((summary) => {
      const parts = [
        summary.sourceSymlinks > 0
          ? `${formatCount(summary.sourceSymlinks, "source symlink")}`
          : "",
        summary.copiedMatches > 0
          ? `${formatCount(summary.copiedMatches, "copied match")}`
          : "",
        summary.externalMatches > 0
          ? `${formatCount(summary.externalMatches, "external symlink match")}`
          : "",
        summary.migrations > 0
          ? `${formatCount(summary.migrations, "migration")}`
          : "",
        summary.warnings > 0 ? `${summary.warnings} need review` : "",
      ].filter(Boolean);
      return `- ${labelForHarness(summary.target)}: ${parts.join(", ")}`;
    });
}

function legacyTargetSummary(
  byTarget: Map<
    string,
    {
      target: HarnessTargetRecord;
      sourceSymlinks: number;
      copiedMatches: number;
      externalMatches: number;
      migrations: number;
      warnings: number;
    }
  >,
  target: HarnessTargetRecord
): {
  target: HarnessTargetRecord;
  sourceSymlinks: number;
  copiedMatches: number;
  externalMatches: number;
  migrations: number;
  warnings: number;
} {
  const key = target.target_path;
  const existing = byTarget.get(key);
  if (existing) {
    return existing;
  }
  const summary = {
    target,
    sourceSymlinks: 0,
    copiedMatches: 0,
    externalMatches: 0,
    migrations: 0,
    warnings: 0,
  };
  byTarget.set(key, summary);
  return summary;
}

function formatLegacyKitName(targets: HarnessTargetRecord[]): string {
  const slugs = targets.map(targetSlug).toSorted();
  return slugs.length === 1
    ? `legacy-kit-${slugs[0]}-only`
    : `legacy-kit-${slugs.join("-")}`;
}

function targetSlug(target: HarnessTargetRecord): string {
  return target.name === "gemini" ? "gemini-cli" : target.name;
}

async function inspectMigratableTargetEntry(input: {
  entryName: string;
  entryIsSymbolicLink: boolean;
  entryIsDirectory: boolean;
  sourcePath: string;
  targetPath: string;
}): Promise<
  | {
      sourcePath: string;
      originPath: string;
      kind: "migrate-directory" | "migrate-external-symlink";
    }
  | undefined
> {
  if (await pathExists(input.sourcePath)) {
    return undefined;
  }
  if (input.entryIsSymbolicLink) {
    const linkTarget = await readlink(input.targetPath);
    const resolved = path.resolve(path.dirname(input.targetPath), linkTarget);
    if (await isSkillDirectory(resolved)) {
      return {
        sourcePath: input.sourcePath,
        originPath: resolved,
        kind: "migrate-external-symlink",
      };
    }
  }
  if (input.entryIsDirectory && (await isSkillDirectory(input.targetPath))) {
    return {
      sourcePath: input.sourcePath,
      originPath: input.targetPath,
      kind: "migrate-directory",
    };
  }

  return undefined;
}

async function replaceWithSourceSymlink(
  entry: LegacyCompatibleEntry
): Promise<void> {
  await assertTargetStillReplaceable(entry);
  await rm(entry.targetPath, { recursive: true, force: true });
  await mkdir(path.dirname(entry.targetPath), { recursive: true });
  await symlink(
    path.relative(path.dirname(entry.targetPath), entry.sourcePath),
    entry.targetPath,
    "dir"
  );
}

async function migrateTargetSkillToSource(
  entry: LegacyCompatibleEntry
): Promise<void> {
  if (!entry.originPath) {
    throw new Error(`Cannot migrate ${entry.skillId}: missing origin path.`);
  }
  if (await pathExists(entry.sourcePath)) {
    throw new Error(
      `Cannot migrate ${entry.skillId}: ./.agents/skills/${entry.skillId} already exists.`
    );
  }
  await assertMigratableEntryStillReadable(entry);
  await mkdir(path.dirname(entry.sourcePath), { recursive: true });
  await cp(entry.originPath, entry.sourcePath, { recursive: true });
  await replaceWithSourceSymlink(entry);
}

async function assertTargetStillReplaceable(
  entry: LegacyCompatibleEntry
): Promise<void> {
  if (entry.kind === "identical-copy") {
    if (!(await directoriesMatch(entry.sourcePath, entry.targetPath))) {
      throw new Error(
        `Cannot normalize ${entry.skillId}: target changed after review and no longer matches ./.agents/skills/${entry.skillId}.`
      );
    }
    return;
  }

  if (entry.kind === "external-identical-symlink") {
    const resolved = await resolveSymlink(entry.targetPath);
    if (!resolved || (entry.originPath && resolved !== entry.originPath)) {
      throw new Error(
        `Cannot normalize ${entry.skillId}: target symlink changed after review.`
      );
    }
    if (!(await directoriesMatch(entry.sourcePath, resolved))) {
      throw new Error(
        `Cannot normalize ${entry.skillId}: external target changed after review and no longer matches ./.agents/skills/${entry.skillId}.`
      );
    }
    return;
  }

  if (isMigratableKind(entry.kind)) {
    if (!entry.originPath) {
      throw new Error(`Cannot migrate ${entry.skillId}: missing origin path.`);
    }
    if (entry.kind === "migrate-directory") {
      if (!(await directoriesMatch(entry.sourcePath, entry.targetPath))) {
        throw new Error(
          `Cannot migrate ${entry.skillId}: target changed during migration.`
        );
      }
      return;
    }

    const resolved = await resolveSymlink(entry.targetPath);
    if (resolved !== entry.originPath) {
      throw new Error(
        `Cannot migrate ${entry.skillId}: target symlink changed during migration.`
      );
    }
    if (!(await directoriesMatch(entry.sourcePath, entry.originPath))) {
      throw new Error(
        `Cannot migrate ${entry.skillId}: external target changed during migration.`
      );
    }
  }
}

async function assertMigratableEntryStillReadable(
  entry: LegacyCompatibleEntry
): Promise<void> {
  if (!entry.originPath) {
    throw new Error(`Cannot migrate ${entry.skillId}: missing origin path.`);
  }

  if (entry.kind === "migrate-directory") {
    if (entry.originPath !== entry.targetPath) {
      throw new Error(
        `Cannot migrate ${entry.skillId}: target origin changed after review.`
      );
    }
    if (!(await isSkillDirectory(entry.targetPath))) {
      throw new Error(
        `Cannot migrate ${entry.skillId}: target changed after review.`
      );
    }
    return;
  }

  const resolved = await resolveSymlink(entry.targetPath);
  if (
    resolved !== entry.originPath ||
    !(await isSkillDirectory(entry.originPath))
  ) {
    throw new Error(
      `Cannot migrate ${entry.skillId}: target changed after review.`
    );
  }
}

async function resolveSymlink(targetPath: string): Promise<string | undefined> {
  const linkTarget = await readlink(targetPath).catch(() => undefined);
  return linkTarget
    ? path.resolve(path.dirname(targetPath), linkTarget)
    : undefined;
}

async function directoriesMatch(left: string, right: string): Promise<boolean> {
  const leftEntries = await listRelativeFiles(left);
  const rightEntries = await listRelativeFiles(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    if (leftEntries[index] !== rightEntries[index]) {
      return false;
    }
    const [leftRaw, rightRaw] = await Promise.all([
      readFile(path.join(left, leftEntries[index])),
      readFile(path.join(right, rightEntries[index])),
    ]);
    if (!leftRaw.equals(rightRaw)) {
      return false;
    }
  }

  return true;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await visit(root, "");
  return files.toSorted();

  async function visit(base: string, relative: string): Promise<void> {
    const entries = await readdir(base, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const nextPath = path.join(base, entry.name);
      const stat = await lstat(nextPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(nextPath, nextRelative);
        continue;
      }
      if (stat.isFile()) {
        files.push(nextRelative);
      }
    }
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].toSorted();
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

async function isSkillDirectory(targetPath: string): Promise<boolean> {
  const stat = await lstat(targetPath).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    return false;
  }
  const skillMd = await lstat(path.join(targetPath, "SKILL.md")).catch(
    () => undefined
  );
  return Boolean(skillMd?.isFile());
}

async function pathExists(targetPath: string): Promise<boolean> {
  return lstat(targetPath)
    .then(() => true)
    .catch(() => false);
}

function isNormalizableKind(kind: LegacyCompatibleEntry["kind"]): boolean {
  return kind === "identical-copy" || kind === "external-identical-symlink";
}

function isMigratableKind(kind: LegacyCompatibleEntry["kind"]): boolean {
  return kind === "migrate-directory" || kind === "migrate-external-symlink";
}

function labelForHarness(target: HarnessTargetRecord): string {
  if (target.name === "claude") {
    return "Claude";
  }
  if (target.name === "gemini") {
    return "Gemini CLI";
  }
  if (target.name === "cursor") {
    return "Cursor";
  }
  if (target.name === "custom") {
    return "Custom";
  }
  return "Codex";
}
