import {
  lstat,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import { parse } from "smol-toml";

import { SKILLS_KIT_PACKAGE_NAME } from "../package-json/package-json";
import { assertRepoLocalPath, resolveWorkspacePaths } from "../../utils/paths";
import { clearManagedManifest } from "../harnesses/symlinks";
import type { ManagedSymlinkManifest } from "../../types";

export type UninstallScope = "settings" | "harnesses" | "all";

export interface UninstallPlan {
  root: string;
  scope: UninstallScope;
  metadataDir: string;
  metadataExists: boolean;
  manifests: UninstallManifestPlan[];
  packageJson?: PackageJsonUninstallPlan;
}

export interface UninstallManifestPlan {
  manifestPath: string;
  targetDir: string;
  managedSkillIds: string[];
  removeSymlinks: string[];
  skipped: Array<{
    path: string;
    reason: string;
  }>;
}

export interface PackageJsonUninstallPlan {
  path: string;
  removeScripts: string[];
  removeDependencySections: string[];
}

export interface UninstallResult {
  scope: UninstallScope;
  removedSymlinks: number;
  skipped: number;
  clearedManifests: number;
  removedMetadata: boolean;
  removedPackageScripts: number;
  removedPackageDependencies: number;
}

const PACKAGE_JSON_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export async function planUninstall(
  root = process.cwd(),
  options: { scope?: UninstallScope } = {}
): Promise<UninstallPlan> {
  const scope = options.scope ?? "all";
  const paths = resolveWorkspacePaths(root);
  const manifests = includesHarnesses(scope)
    ? await planManifestCleanups(paths.root, paths.manifestsDir)
    : [];
  const packageJson = includesSettings(scope)
    ? await planPackageJsonCleanup(paths.root)
    : undefined;

  return {
    root: paths.root,
    scope,
    metadataDir: paths.kitDir,
    metadataExists: await exists(paths.kitDir),
    manifests,
    packageJson,
  };
}

export async function uninstallSkillsKit(
  root = process.cwd(),
  options: { scope?: UninstallScope } = {}
): Promise<UninstallResult> {
  const plan = await planUninstall(root, options);
  let removedSymlinks = 0;
  let skipped = 0;
  let clearedManifests = 0;

  if (includesHarnesses(plan.scope)) {
    for (const manifest of plan.manifests) {
      for (const targetPath of manifest.removeSymlinks) {
        await rm(targetPath, { force: true });
        removedSymlinks += 1;
      }
      skipped += manifest.skipped.length;

      if (
        manifest.managedSkillIds.length > 0 ||
        manifest.removeSymlinks.length > 0 ||
        manifest.skipped.length > 0
      ) {
        await clearManagedManifest(plan.root, manifest.targetDir);
        clearedManifests += 1;
      }
    }
  }

  const packageJsonResult =
    includesSettings(plan.scope) && plan.packageJson
      ? await applyPackageJsonCleanup(plan.packageJson)
      : { removedScripts: 0, removedDependencies: 0 };

  const metadataExisted =
    includesSettings(plan.scope) && (await exists(plan.metadataDir));
  if (includesSettings(plan.scope)) {
    await rm(plan.metadataDir, { recursive: true, force: true });
  }

  return {
    scope: plan.scope,
    removedSymlinks,
    skipped,
    clearedManifests,
    removedMetadata: metadataExisted,
    removedPackageScripts: packageJsonResult.removedScripts,
    removedPackageDependencies: packageJsonResult.removedDependencies,
  };
}

export function formatUninstallPlan(plan: UninstallPlan): string {
  const removeSymlinkCount = plan.manifests.reduce(
    (count, manifest) => count + manifest.removeSymlinks.length,
    0
  );
  const skippedCount = plan.manifests.reduce(
    (count, manifest) => count + manifest.skipped.length,
    0
  );
  const packageScriptCount = plan.packageJson?.removeScripts.length ?? 0;
  const packageDependencyCount =
    plan.packageJson?.removeDependencySections.length ?? 0;

  if (
    !(includesSettings(plan.scope) && plan.metadataExists) &&
    removeSymlinkCount === 0 &&
    skippedCount === 0 &&
    packageScriptCount === 0 &&
    packageDependencyCount === 0
  ) {
    return [
      paint("green", "skills-kit is already clean."),
      "",
      paint("muted", "Nothing would be removed."),
    ].join("\n");
  }

  const lines = [
    paint("blue", "Planned removal"),
    formatField("Scope", formatUninstallScope(plan.scope), 24, "blue"),
    formatField("Managed links", removeSymlinkCount, 24, "green"),
    formatField(
      "Metadata",
      includesSettings(plan.scope) && plan.metadataExists
        ? "yes"
        : "not removed",
      24,
      includesSettings(plan.scope) && plan.metadataExists ? "green" : "muted"
    ),
    formatField("Package scripts", packageScriptCount, 24, "green"),
    formatField("Dependencies", packageDependencyCount, 24, "green"),
  ];

  if (skippedCount > 0) {
    lines.push(formatField("Skipped unmanaged", skippedCount, 24, "yellow"));
  }

  return lines.join("\n");
}

export function formatUninstallConfirmation(plan: UninstallPlan): string {
  const removeSymlinkCount = plan.manifests.reduce(
    (count, manifest) => count + manifest.removeSymlinks.length,
    0
  );
  const skippedCount = plan.manifests.reduce(
    (count, manifest) => count + manifest.skipped.length,
    0
  );
  const packageScriptCount = plan.packageJson?.removeScripts.length ?? 0;
  const packageDependencyCount =
    plan.packageJson?.removeDependencySections.length ?? 0;
  const lines = [
    paint("blue", "Uninstall skills-kit"),
    "",
    formatField("Scope", formatUninstallScope(plan.scope), 16, "blue"),
    formatField("Managed links", removeSymlinkCount, 16, "green"),
    formatField(
      "Metadata",
      includesSettings(plan.scope) && plan.metadataExists
        ? "yes"
        : "not removed",
      16,
      includesSettings(plan.scope) && plan.metadataExists ? "green" : "muted"
    ),
    formatField("Package scripts", packageScriptCount, 16, "green"),
    formatField("Dependencies", packageDependencyCount, 16, "green"),
  ];

  if (skippedCount > 0) {
    lines.push(formatField("Skipped unmanaged", skippedCount, 16, "yellow"));
  }

  lines.push(
    "",
    paint("green", "- Source skills in ./.agents/skills stay untouched"),
    "",
    'Type "delete" to confirm.'
  );

  return lines.join("\n");
}

export function formatUninstallResult(result: UninstallResult): string {
  const changed =
    result.removedSymlinks > 0 ||
    result.clearedManifests > 0 ||
    result.removedMetadata ||
    result.removedPackageScripts > 0 ||
    result.removedPackageDependencies > 0;

  if (!changed && result.skipped === 0) {
    return [
      paint("green", "skills-kit is already clean."),
      "",
      paint("muted", "Nothing was removed."),
    ].join("\n");
  }

  const lines = [
    paint("green", "Uninstall complete."),
    "",
    formatField("Scope", formatUninstallScope(result.scope), 16, "blue"),
    formatField("Managed links", result.removedSymlinks, 16, "green"),
    formatField("Manifests", result.clearedManifests, 16, "green"),
    formatField(
      "Metadata",
      result.removedMetadata ? "yes" : "no",
      16,
      result.removedMetadata ? "green" : "muted"
    ),
    formatField("Package scripts", result.removedPackageScripts, 16, "green"),
    formatField("Dependencies", result.removedPackageDependencies, 16, "green"),
  ];

  if (result.skipped > 0) {
    lines.push(formatField("Skipped unmanaged", result.skipped, 16, "yellow"));
  }

  lines.push(
    "",
    paint("blue", "Safety"),
    paint("green", "- Source skills left untouched")
  );

  return lines.join("\n");
}

function includesSettings(scope: UninstallScope): boolean {
  return scope === "settings" || scope === "all";
}

function includesHarnesses(scope: UninstallScope): boolean {
  return scope === "harnesses" || scope === "all";
}

function formatUninstallScope(scope: UninstallScope): string {
  if (scope === "settings") {
    return "settings only";
  }
  if (scope === "harnesses") {
    return "disconnect harnesses";
  }
  return "remove both";
}

function formatField(
  label: string,
  value: string | number,
  labelWidth: number,
  tone?: "blue" | "green" | "muted" | "red" | "yellow"
): string {
  return `${padVisible(formatLabel(label, tone), labelWidth)} ${value}`;
}

function formatLabel(
  label: string,
  tone?: "blue" | "green" | "muted" | "red" | "yellow"
): string {
  const value = shouldUseColor()
    ? styleText(["bold", "underline"], `${label}:`)
    : `${label}:`;
  return tone ? paint(tone, value) : value;
}

function padVisible(value: string, width: number): string {
  const visibleLength = value.replace(ANSI_PATTERN, "").length;
  return `${value}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function paint(
  tone: "blue" | "green" | "muted" | "red" | "yellow",
  value: string
): string {
  if (!shouldUseColor()) {
    return value;
  }

  const ansi = {
    blue: "\x1b[38;5;39m",
    green: "\x1b[38;5;48m",
    muted: "\x1b[38;5;244m",
    red: "\x1b[38;5;203m",
    yellow: "\x1b[38;5;226m",
    reset: "\x1b[0m",
  };
  return `${ansi[tone]}${value}${ansi.reset}`;
}

function shouldUseColor(): boolean {
  const forceColor =
    Boolean(process.env.FORCE_COLOR) && process.env.FORCE_COLOR !== "0";
  return forceColor || (process.stdout.isTTY && !process.env.NO_COLOR);
}

async function planManifestCleanups(
  root: string,
  manifestsDir: string
): Promise<UninstallManifestPlan[]> {
  const entries = await readdir(manifestsDir, { withFileTypes: true }).catch(
    () => []
  );
  const plans: UninstallManifestPlan[] = [];

  for (const entry of entries.toSorted((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) {
      continue;
    }

    const manifestPath = path.join(manifestsDir, entry.name);
    const manifest = await readManifest(manifestPath);
    const targetDir = assertRepoLocalPath(
      root,
      path.resolve(root, manifest.target_path),
      "Harness target"
    );
    const removeSymlinks: string[] = [];
    const skipped: UninstallManifestPlan["skipped"] = [];

    for (const skillId of manifest.managed_skill_ids) {
      const targetPath = assertRepoLocalPath(
        root,
        path.join(targetDir, skillId),
        "Managed skill link"
      );
      const state = await readTargetState(targetPath);

      if (state.kind === "missing") {
        continue;
      }
      if (state.kind !== "symlink") {
        skipped.push({
          path: targetPath,
          reason: "target exists and is not a symlink",
        });
        continue;
      }
      if (!pointsToManagedSource(root, targetPath, state.to, skillId)) {
        skipped.push({
          path: targetPath,
          reason: `target symlink points to ${state.to}`,
        });
        continue;
      }
      removeSymlinks.push(targetPath);
    }

    plans.push({
      manifestPath,
      targetDir,
      managedSkillIds: manifest.managed_skill_ids,
      removeSymlinks,
      skipped,
    });
  }

  return plans;
}

async function readManifest(
  manifestPath: string
): Promise<ManagedSymlinkManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = parse(raw) as Partial<ManagedSymlinkManifest>;
  return {
    version: 1,
    generated_at:
      typeof parsed.generated_at === "string" ? parsed.generated_at : "",
    target_path:
      typeof parsed.target_path === "string" ? parsed.target_path : "",
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

async function planPackageJsonCleanup(
  root: string
): Promise<PackageJsonUninstallPlan | undefined> {
  const packageJsonPath = path.join(root, "package.json");
  const raw = await readFile(packageJsonPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return undefined;
  }

  const packageJson = JSON.parse(raw) as Record<string, unknown>;
  const scripts = asRecord(packageJson.scripts) ?? {};
  const removeScripts = Object.entries(scripts)
    .filter(([, command]) => command === "skills-kit")
    .map(([name]) => name)
    .toSorted();
  const removeDependencySections = PACKAGE_JSON_DEPENDENCY_SECTIONS.filter(
    (section) =>
      Boolean(asRecord(packageJson[section])?.[SKILLS_KIT_PACKAGE_NAME])
  );

  if (removeScripts.length === 0 && removeDependencySections.length === 0) {
    return undefined;
  }

  return {
    path: packageJsonPath,
    removeScripts,
    removeDependencySections: [...removeDependencySections],
  };
}

async function applyPackageJsonCleanup(
  plan: PackageJsonUninstallPlan
): Promise<{ removedScripts: number; removedDependencies: number }> {
  const raw = await readFile(plan.path, "utf8");
  const packageJson = JSON.parse(raw) as Record<string, unknown>;
  const scripts = asRecord(packageJson.scripts);

  for (const scriptName of plan.removeScripts) {
    if (scripts?.[scriptName] === "skills-kit") {
      delete scripts[scriptName];
    }
  }
  if (scripts && Object.keys(scripts).length === 0) {
    delete packageJson.scripts;
  }

  let removedDependencies = 0;
  for (const section of plan.removeDependencySections) {
    const dependencies = asRecord(packageJson[section]);
    if (!dependencies?.[SKILLS_KIT_PACKAGE_NAME]) {
      continue;
    }
    delete dependencies[SKILLS_KIT_PACKAGE_NAME];
    removedDependencies += 1;
    if (Object.keys(dependencies).length === 0) {
      delete packageJson[section];
    }
  }

  await writeFile(plan.path, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    removedScripts: plan.removeScripts.length,
    removedDependencies,
  };
}

function asRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, string>;
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

  const entry = await lstat(targetPath).catch(() => undefined);
  return entry ? { kind: "other" } : { kind: "missing" };
}

async function exists(targetPath: string): Promise<boolean> {
  return lstat(targetPath)
    .then(() => true)
    .catch(() => false);
}

function pointsToManagedSource(
  root: string,
  targetPath: string,
  linkTarget: string,
  skillId: string
): boolean {
  const resolvedLink = path.resolve(path.dirname(targetPath), linkTarget);
  const expectedSource = path.resolve(root, ".agents/skills", skillId);
  return resolvedLink === expectedSource;
}
