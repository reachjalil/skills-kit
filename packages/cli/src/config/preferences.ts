import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";

import type {
  HarnessName,
  HarnessTargetRecord,
  PackageJsonOfferStatus,
  PackageJsonPreferences,
  SkillsKitPreferences,
  StartupReviewPreferences,
  WorkspacePaths,
} from "../types";

const BUILT_IN_HARNESSES: HarnessName[] = [
  "codex",
  "claude",
  "gemini",
  "cursor",
];
export const DEFAULT_PACKAGE_SCRIPT_NAME = "skills";
export const DEFAULT_PACKAGE_SCRIPT_COMMAND = "skills-kit";
export const DEFAULT_PACKAGE_DEPENDENCY_SPEC = "^1.0.0";

export function defaultTargetPathForHarness(harness: HarnessName): string {
  if (harness === "claude") {
    return "./.claude/skills";
  }
  if (harness === "gemini") {
    return "./.gemini/skills";
  }
  if (harness === "cursor") {
    return "./.cursor/skills";
  }
  if (harness === "custom") {
    return "./.skills";
  }
  return "./.codex/skills";
}

export function createDefaultPreferences(
  harness: HarnessName = "codex"
): SkillsKitPreferences {
  return {
    version: 1,
    harness: {
      name: harness,
      target_path: defaultTargetPathForHarness(harness),
      selection_mode: "symlink",
      confirm_before_write: true,
      managed_symlinks: true,
    },
    default_harnesses: [
      {
        name: harness,
        target_path: defaultTargetPathForHarness(harness),
      },
    ],
    supported_harnesses: [
      {
        name: harness,
        target_path: defaultTargetPathForHarness(harness),
      },
    ],
    startup_review: createDefaultStartupReviewPreferences(),
    package_json: createDefaultPackageJsonPreferences(),
  };
}

export function createDefaultStartupReviewPreferences(): StartupReviewPreferences {
  return {
    offer: "ask",
  };
}

export function createDefaultPackageJsonPreferences(): PackageJsonPreferences {
  return {
    offer: "ask",
    script_name: DEFAULT_PACKAGE_SCRIPT_NAME,
    script_command: DEFAULT_PACKAGE_SCRIPT_COMMAND,
    dependency_spec: DEFAULT_PACKAGE_DEPENDENCY_SPEC,
  };
}

export async function detectExistingHarnessTargets(
  root: string
): Promise<HarnessTargetRecord[]> {
  const detected: HarnessTargetRecord[] = [];

  for (const harness of BUILT_IN_HARNESSES) {
    const targetPath = defaultTargetPathForHarness(harness);
    const target = await stat(path.resolve(root, targetPath)).catch(
      () => undefined
    );
    if (target?.isDirectory()) {
      detected.push({
        name: harness,
        target_path: targetPath,
      });
    }
  }

  return detected;
}

export async function loadPreferences(
  paths: WorkspacePaths
): Promise<SkillsKitPreferences> {
  const raw = await readFile(paths.preferencesPath, "utf8").catch(() => "");
  if (!raw.trim()) {
    return createDefaultPreferences();
  }

  const parsed = parse(raw) as Partial<SkillsKitPreferences>;
  return normalizePreferences(parsed);
}

export async function savePreferences(
  paths: WorkspacePaths,
  preferences: SkillsKitPreferences
): Promise<void> {
  await mkdir(paths.kitDir, { recursive: true });
  await writeFile(paths.preferencesPath, stringify(preferences), "utf8");
}

function normalizePreferences(
  input: Partial<SkillsKitPreferences>
): SkillsKitPreferences {
  const harnessName = normalizeHarnessName(input.harness?.name);
  const primaryTargetPath =
    typeof input.harness?.target_path === "string"
      ? input.harness.target_path
      : defaultTargetPathForHarness(harnessName);
  const supportedHarnesses =
    normalizeHarnessTargets(input.supported_harnesses).length > 0
      ? normalizeHarnessTargets(input.supported_harnesses)
      : [
          {
            name: harnessName,
            target_path: primaryTargetPath,
          },
        ];
  const defaultHarnesses = normalizeDefaultHarnesses(
    input.default_harnesses,
    supportedHarnesses,
    {
      name: harnessName,
      target_path: primaryTargetPath,
    }
  );
  const primary = defaultHarnesses[0] ?? {
    name: harnessName,
    target_path: primaryTargetPath,
  };

  return {
    version: 1,
    harness: {
      name: primary.name,
      target_path: primary.target_path,
      selection_mode:
        input.harness?.selection_mode === "copy" ||
        input.harness?.selection_mode === "manifest"
          ? input.harness.selection_mode
          : "symlink",
      confirm_before_write: input.harness?.confirm_before_write !== false,
      managed_symlinks: input.harness?.managed_symlinks !== false,
    },
    default_harnesses: defaultHarnesses,
    supported_harnesses: supportedHarnesses,
    startup_review: normalizeStartupReviewPreferences(input.startup_review),
    package_json: normalizePackageJsonPreferences(input.package_json),
  };
}

function normalizeHarnessName(value: unknown): HarnessName {
  if (
    value === "claude" ||
    value === "gemini" ||
    value === "cursor" ||
    value === "custom"
  ) {
    return value;
  }
  return "codex";
}

function normalizePackageJsonPreferences(
  value: unknown
): PackageJsonPreferences {
  if (!value || typeof value !== "object") {
    return createDefaultPackageJsonPreferences();
  }

  const input = value as Partial<PackageJsonPreferences>;
  return {
    offer: normalizePackageJsonOffer(input.offer),
    script_name:
      typeof input.script_name === "string" && input.script_name.trim()
        ? input.script_name.trim()
        : DEFAULT_PACKAGE_SCRIPT_NAME,
    script_command:
      typeof input.script_command === "string" && input.script_command.trim()
        ? input.script_command.trim()
        : DEFAULT_PACKAGE_SCRIPT_COMMAND,
    dependency_spec:
      typeof input.dependency_spec === "string" && input.dependency_spec.trim()
        ? input.dependency_spec.trim()
        : DEFAULT_PACKAGE_DEPENDENCY_SPEC,
  };
}

function normalizeStartupReviewPreferences(
  value: unknown
): StartupReviewPreferences {
  const input =
    value && typeof value === "object"
      ? (value as Partial<StartupReviewPreferences>)
      : {};
  return {
    offer: input.offer === "dismissed" ? "dismissed" : "ask",
  };
}

function normalizePackageJsonOffer(value: unknown): PackageJsonOfferStatus {
  if (value === "dismissed" || value === "configured") {
    return value;
  }
  return "ask";
}

function normalizeHarnessTargets(value: unknown): HarnessTargetRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const candidate = entry as Partial<HarnessTargetRecord>;
      const name = normalizeHarnessName(candidate.name);
      const targetPath =
        typeof candidate.target_path === "string"
          ? candidate.target_path
          : defaultTargetPathForHarness(name);
      return {
        name,
        target_path: targetPath,
      };
    })
    .filter((entry): entry is HarnessTargetRecord => Boolean(entry));
}

function normalizeDefaultHarnesses(
  value: unknown,
  supportedHarnesses: HarnessTargetRecord[],
  fallback: HarnessTargetRecord
): HarnessTargetRecord[] {
  const requested = normalizeHarnessTargets(value);
  const supportedByPath = new Map(
    supportedHarnesses.map((target) => [target.target_path, target])
  );
  const supportedByName = new Map(
    supportedHarnesses.map((target) => [target.name, target])
  );
  const defaults = requested
    .map(
      (target) =>
        supportedByPath.get(target.target_path) ??
        supportedByName.get(target.name)
    )
    .filter((target): target is HarnessTargetRecord => Boolean(target));

  if (defaults.length > 0) {
    return dedupeHarnessTargets(defaults);
  }

  return [
    supportedByPath.get(fallback.target_path) ??
      supportedByName.get(fallback.name) ??
      fallback,
  ];
}

function dedupeHarnessTargets(
  targets: HarnessTargetRecord[]
): HarnessTargetRecord[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.target_path)) {
      return false;
    }
    seen.add(target.target_path);
    return true;
  });
}
