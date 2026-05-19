import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PACKAGE_DEPENDENCY_SPEC,
  DEFAULT_PACKAGE_SCRIPT_COMMAND,
  DEFAULT_PACKAGE_SCRIPT_NAME,
} from "../../config/preferences";
import type { PackageJsonPreferences } from "../../types";

export const SKILLS_KIT_PACKAGE_NAME = "@skills-kit/cli";
export type PackageManagerName = "pnpm" | "yarn" | "npm" | "bun";

interface EditablePackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageJsonIntegrationStatus {
  hasPackageJson: boolean;
  packageJsonPath: string;
  hasDependency: boolean;
  hasScript: boolean;
  scriptName: string;
  scriptCommand: string;
  packageManager: PackageManagerName;
  runScriptCommand: string;
  scriptConflict?: string;
}

export interface PackageJsonIntegrationResult {
  packageJsonPath: string;
  addedDependency: boolean;
  addedScript: boolean;
  scriptName: string;
  scriptCommand: string;
  packageManager: PackageManagerName;
  runScriptCommand: string;
}

export interface PackageJsonRemovalResult {
  packageJsonPath: string;
  removedScripts: number;
  removedDependencies: number;
}

export function defaultPackageJsonPreferences(): PackageJsonPreferences {
  return {
    offer: "ask",
    script_name: DEFAULT_PACKAGE_SCRIPT_NAME,
    script_command: DEFAULT_PACKAGE_SCRIPT_COMMAND,
    dependency_spec: DEFAULT_PACKAGE_DEPENDENCY_SPEC,
  };
}

export async function getPackageJsonIntegrationStatus(
  root: string,
  preferences: PackageJsonPreferences = defaultPackageJsonPreferences()
): Promise<PackageJsonIntegrationStatus> {
  const packageJsonPath = getPackageJsonPath(root);
  const packageJson = await readPackageJson(root);
  const scriptName = preferences.script_name || DEFAULT_PACKAGE_SCRIPT_NAME;
  const scriptCommand =
    preferences.script_command || DEFAULT_PACKAGE_SCRIPT_COMMAND;
  const packageManager = await detectPackageManager(root, packageJson);
  const runScriptCommand = formatPackageScriptCommand(
    packageManager,
    scriptName
  );

  if (!packageJson) {
    return {
      hasPackageJson: false,
      packageJsonPath,
      hasDependency: false,
      hasScript: false,
      scriptName,
      scriptCommand,
      packageManager,
      runScriptCommand,
    };
  }

  const scriptValue = packageJson.scripts?.[scriptName];
  return {
    hasPackageJson: true,
    packageJsonPath,
    hasDependency: hasAnyDependency(packageJson),
    hasScript: scriptValue === scriptCommand,
    scriptName,
    scriptCommand,
    packageManager,
    runScriptCommand,
    scriptConflict:
      scriptValue && scriptValue !== scriptCommand ? scriptValue : undefined,
  };
}

export async function applyPackageJsonIntegration(
  root: string,
  input: {
    scriptName?: string;
    scriptCommand?: string;
    dependencySpec?: string;
  } = {}
): Promise<PackageJsonIntegrationResult> {
  const packageJsonPath = getPackageJsonPath(root);
  const packageJson = await readPackageJson(root);
  if (!packageJson) {
    throw new Error("No package.json found in this repo.");
  }
  const packageManager = await detectPackageManager(root, packageJson);

  const scriptName = normalizeScriptName(
    input.scriptName ?? DEFAULT_PACKAGE_SCRIPT_NAME
  );
  const scriptCommand = normalizeScriptCommand(
    input.scriptCommand ?? DEFAULT_PACKAGE_SCRIPT_COMMAND
  );
  const dependencySpec = normalizeDependencySpec(
    input.dependencySpec ?? DEFAULT_PACKAGE_DEPENDENCY_SPEC
  );
  const scripts = packageJson.scripts ?? {};
  const existingScript = scripts[scriptName];
  if (existingScript && existingScript !== scriptCommand) {
    throw new Error(
      `package.json already has a "${scriptName}" script. Choose a different script name.`
    );
  }

  const addedScript = existingScript !== scriptCommand;
  packageJson.scripts = {
    ...scripts,
    [scriptName]: scriptCommand,
  };

  const addedDependency = !hasAnyDependency(packageJson);
  if (addedDependency) {
    packageJson.devDependencies = {
      ...(packageJson.devDependencies ?? {}),
      [SKILLS_KIT_PACKAGE_NAME]: dependencySpec,
    };
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    packageJsonPath,
    addedDependency,
    addedScript,
    scriptName,
    scriptCommand,
    packageManager,
    runScriptCommand: formatPackageScriptCommand(packageManager, scriptName),
  };
}

export async function removePackageJsonIntegration(
  root: string
): Promise<PackageJsonRemovalResult> {
  const packageJsonPath = getPackageJsonPath(root);
  const packageJson = await readPackageJson(root);
  if (!packageJson) {
    throw new Error("No package.json found in this repo.");
  }

  let removedScripts = 0;
  const scripts = packageJson.scripts;
  if (scripts) {
    for (const [scriptName, command] of Object.entries(scripts)) {
      if (command === DEFAULT_PACKAGE_SCRIPT_COMMAND) {
        delete scripts[scriptName];
        removedScripts += 1;
      }
    }
    if (Object.keys(scripts).length === 0) {
      delete packageJson.scripts;
    }
  }

  let removedDependencies = 0;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ] as const) {
    const dependencies = packageJson[section];
    if (!dependencies?.[SKILLS_KIT_PACKAGE_NAME]) {
      continue;
    }
    delete dependencies[SKILLS_KIT_PACKAGE_NAME];
    removedDependencies += 1;
    if (Object.keys(dependencies).length === 0) {
      delete packageJson[section];
    }
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    packageJsonPath,
    removedScripts,
    removedDependencies,
  };
}

export async function detectPackageManager(
  root: string,
  packageJson?: { packageManager?: string }
): Promise<PackageManagerName> {
  const packageJsonConfig = packageJson ?? (await readPackageJson(root));
  const declared = normalizePackageManagerName(
    packageJsonConfig?.packageManager
  );
  if (declared) {
    return declared;
  }

  const lockfileMatches: Array<[string, PackageManagerName]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ];

  for (const [fileName, packageManager] of lockfileMatches) {
    const entry = await stat(path.join(root, fileName)).catch(() => undefined);
    if (entry?.isFile()) {
      return packageManager;
    }
  }

  return "npm";
}

export function formatPackageScriptCommand(
  packageManager: PackageManagerName,
  scriptName: string
): string {
  if (packageManager === "pnpm") {
    return `pnpm ${scriptName}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${scriptName}`;
  }
  if (packageManager === "bun") {
    return `bun run ${scriptName}`;
  }
  return `npm run ${scriptName}`;
}

function getPackageJsonPath(root: string): string {
  return path.join(root, "package.json");
}

async function readPackageJson(
  root: string
): Promise<EditablePackageJson | undefined> {
  const packageJsonPath = getPackageJsonPath(root);
  const entry = await stat(packageJsonPath).catch(() => undefined);
  if (!entry?.isFile()) {
    return undefined;
  }

  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json must contain a JSON object.");
  }
  return parsed as EditablePackageJson;
}

function hasAnyDependency(packageJson: EditablePackageJson): boolean {
  return Boolean(
    packageJson.dependencies?.[SKILLS_KIT_PACKAGE_NAME] ||
      packageJson.devDependencies?.[SKILLS_KIT_PACKAGE_NAME] ||
      packageJson.optionalDependencies?.[SKILLS_KIT_PACKAGE_NAME] ||
      packageJson.peerDependencies?.[SKILLS_KIT_PACKAGE_NAME]
  );
}

function normalizePackageManagerName(
  value: string | undefined
): PackageManagerName | undefined {
  const name = value?.split("@")[0]?.trim().toLowerCase();
  if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") {
    return name;
  }
  return undefined;
}

function normalizeScriptName(value: string): string {
  const scriptName = value.trim();
  if (!scriptName) {
    throw new Error("Package script name is required.");
  }
  if (scriptName.length > 64 || !/^[a-zA-Z0-9:_-]+$/.test(scriptName)) {
    throw new Error(
      "Package script name can use letters, numbers, dashes, underscores, and colons."
    );
  }
  return scriptName;
}

function normalizeScriptCommand(value: string): string {
  const scriptCommand = value.trim();
  if (scriptCommand !== DEFAULT_PACKAGE_SCRIPT_COMMAND) {
    throw new Error(
      `Package script command must be ${DEFAULT_PACKAGE_SCRIPT_COMMAND}.`
    );
  }
  return scriptCommand;
}

function normalizeDependencySpec(value: string): string {
  const dependencySpec = value.trim();
  if (
    !dependencySpec ||
    !/^[~^]?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(dependencySpec)
  ) {
    throw new Error("Package dependency spec must be a plain semver range.");
  }
  return dependencySpec;
}
