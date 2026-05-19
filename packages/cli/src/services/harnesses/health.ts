import { lstat } from "node:fs/promises";

import { planSelection } from "../../core/commands";
import { loadManagedManifest, resolveHarnessTargetDir } from "./symlinks";
import type {
  HarnessTargetRecord,
  ManagedSymlinkManifest,
  SymlinkApplyPlan,
} from "../../types";
import type { WorkspaceState } from "../../core/workspace";

export type HarnessHealthIssueKind =
  | "missing-active-target"
  | "drifted-active-target";

export interface HarnessHealthIssue {
  kind: HarnessHealthIssueKind;
  target: HarnessTargetRecord;
  targetDir: string;
  targetExists: boolean;
  manifest: ManagedSymlinkManifest;
  plan?: SymlinkApplyPlan;
  planError?: string;
}

export interface HarnessHealthReport {
  issues: HarnessHealthIssue[];
}

export async function inspectHarnessHealth(
  state: WorkspaceState
): Promise<HarnessHealthReport> {
  const issues: HarnessHealthIssue[] = [];

  for (const target of getConfiguredHarnessTargets(state)) {
    const targetDir = resolveHarnessTargetDir({
      root: state.paths.root,
      preferences: state.preferences,
      targetPath: target.target_path,
    });
    const targetExists = await pathExists(targetDir);
    const manifest = await loadManagedManifest(state.paths.root, targetDir);
    const hasActiveState = hasManifestSelection(manifest);

    if (!hasActiveState) {
      continue;
    }

    const skillIds =
      manifest.active_skill_ids.length > 0
        ? manifest.active_skill_ids
        : manifest.active_kit_ids.length > 0
          ? []
          : manifest.managed_skill_ids;

    try {
      const plan = await planSelection(state, {
        kitIds: manifest.active_kit_ids,
        skillIds,
        targetPath: target.target_path,
        query: "harness config check",
      });
      const isDrifted =
        !targetExists ||
        plan.create.length > 0 ||
        plan.remove.length > 0 ||
        plan.conflicts.length > 0;

      if (isDrifted) {
        issues.push({
          kind: targetExists
            ? "drifted-active-target"
            : "missing-active-target",
          target,
          targetDir,
          targetExists,
          manifest,
          plan,
        });
      }
    } catch (error) {
      issues.push({
        kind: targetExists ? "drifted-active-target" : "missing-active-target",
        target,
        targetDir,
        targetExists,
        manifest,
        planError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { issues };
}

export function hasActiveHarnessIssue(issue: HarnessHealthIssue): boolean {
  return hasManifestSelection(issue.manifest);
}

export function canReapplyHarnessIssue(issue: HarnessHealthIssue): boolean {
  return (
    hasActiveHarnessIssue(issue) &&
    Boolean(issue.plan) &&
    !issue.planError &&
    (issue.plan?.conflicts.length ?? 0) === 0
  );
}

export function formatHarnessHealthReport(report: HarnessHealthReport): string {
  return report.issues.map(formatHarnessHealthIssue).join("\n");
}

export function getConfiguredHarnessTargets(
  state: WorkspaceState
): HarnessTargetRecord[] {
  const candidates =
    state.preferences.supported_harnesses.length > 0
      ? state.preferences.supported_harnesses
      : [
          {
            name: state.preferences.harness.name,
            target_path: state.preferences.harness.target_path,
          },
        ];
  const seen = new Set<string>();
  const targets: HarnessTargetRecord[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.target_path)) {
      continue;
    }
    seen.add(candidate.target_path);
    targets.push(candidate);
  }

  return targets;
}

function formatHarnessHealthIssue(issue: HarnessHealthIssue): string {
  const label = `${labelForHarness(issue.target)} -> ${issue.target.target_path}`;
  const selectedCount =
    issue.plan?.selected_skill_ids.length ??
    issue.manifest.managed_skill_ids.length;
  const lines = [`- ${label}`];

  if (issue.kind === "missing-active-target") {
    lines.push(
      `  active harness view is missing (${selectedCount} saved skills)`
    );
  } else {
    lines.push(
      `  active harness view is out of sync (${selectedCount} saved skills)`
    );
  }

  if (issue.plan) {
    lines.push(
      `  plan: create ${issue.plan.create.length}, remove ${issue.plan.remove.length}, keep ${issue.plan.keep.length}, conflicts ${issue.plan.conflicts.length}`
    );
  }
  if (issue.planError) {
    lines.push(`  check failed: ${issue.planError}`);
  }

  return lines.join("\n");
}

function hasManifestSelection(manifest: ManagedSymlinkManifest): boolean {
  return (
    manifest.managed_skill_ids.length > 0 ||
    manifest.active_kit_ids.length > 0 ||
    manifest.active_skill_ids.length > 0
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  return lstat(targetPath)
    .then(() => true)
    .catch(() => false);
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
