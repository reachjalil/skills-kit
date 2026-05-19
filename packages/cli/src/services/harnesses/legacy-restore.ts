import {
  applySelection,
  getCurrentActivation,
  planSelection,
} from "../../core/commands";
import { getConfiguredHarnessTargets } from "./health";
import { resolveHarnessTargetDir, clearManagedManifest } from "./symlinks";
import type { HarnessTargetRecord, SymlinkApplyPlan } from "../../types";
import type { WorkspaceState } from "../../core/workspace";

export interface LegacyRestoreTargetPlan {
  target: HarnessTargetRecord;
  targetPath: string;
  legacyKitIds: string[];
  currentManagedSkillIds: string[];
  plan?: SymlinkApplyPlan;
  planError?: string;
}

export interface LegacyRestorePlan {
  targets: LegacyRestoreTargetPlan[];
  disconnectAfter: boolean;
}

export interface LegacyRestoreResult {
  graph: WorkspaceState["graph"];
  restoredTargets: number;
  created: number;
  removed: number;
  kept: number;
  disconnectedTargets: number;
}

export async function planLegacyRestore(
  state: WorkspaceState,
  options: { disconnectAfter?: boolean } = {}
): Promise<LegacyRestorePlan> {
  const targets: LegacyRestoreTargetPlan[] = [];
  for (const target of getConfiguredHarnessTargets(state)) {
    const legacyKitIds = getLegacyKitIdsForTarget(state, target);
    const current = await getCurrentActivation(state, target.target_path);
    if (legacyKitIds.length === 0 && current.managedSkillIds.length === 0) {
      continue;
    }

    const targetPlan: LegacyRestoreTargetPlan = {
      target,
      targetPath: target.target_path,
      legacyKitIds,
      currentManagedSkillIds: current.managedSkillIds,
    };
    try {
      targetPlan.plan = await planSelection(state, {
        kitIds: legacyKitIds,
        targetPath: target.target_path,
        query: "restore legacy setup",
      });
    } catch (error) {
      targetPlan.planError =
        error instanceof Error ? error.message : String(error);
    }
    targets.push(targetPlan);
  }

  return {
    targets,
    disconnectAfter: options.disconnectAfter === true,
  };
}

export async function restoreLegacySetup(
  state: WorkspaceState,
  options: { disconnectAfter?: boolean } = {}
): Promise<LegacyRestoreResult> {
  let graph = state.graph;
  let restoredTargets = 0;
  let created = 0;
  let removed = 0;
  let kept = 0;
  let disconnectedTargets = 0;

  for (const target of getConfiguredHarnessTargets({ ...state, graph })) {
    const legacyKitIds = getLegacyKitIdsForTarget({ ...state, graph }, target);
    const current = await getCurrentActivation(
      { ...state, graph },
      target.target_path
    );
    if (legacyKitIds.length === 0 && current.managedSkillIds.length === 0) {
      continue;
    }

    const result = await applySelection(
      { ...state, graph },
      {
        kitIds: legacyKitIds,
        targetPath: target.target_path,
        query: "restore legacy setup",
      }
    );
    graph = result.graph;
    restoredTargets += 1;
    created += result.created;
    removed += result.removed;
    kept += result.kept;

    if (options.disconnectAfter) {
      const targetDir = resolveHarnessTargetDir({
        root: state.paths.root,
        preferences: state.preferences,
        targetPath: target.target_path,
      });
      await clearManagedManifest(state.paths.root, targetDir);
      disconnectedTargets += 1;
    }
  }

  return {
    graph,
    restoredTargets,
    created,
    removed,
    kept,
    disconnectedTargets,
  };
}

export function hasLegacyRestoreChanges(plan: LegacyRestorePlan): boolean {
  return plan.targets.some(
    (target) =>
      target.planError ||
      (target.plan?.create.length ?? 0) > 0 ||
      (target.plan?.remove.length ?? 0) > 0 ||
      plan.disconnectAfter
  );
}

export function formatLegacyRestorePlan(plan: LegacyRestorePlan): string {
  if (plan.targets.length === 0) {
    return [
      "No legacy kits are available for the configured targets.",
      "",
      "Nothing would change.",
    ].join("\n");
  }

  const lines = [
    "Restore legacy skill setup",
    "",
    "Legacy kits become the active target state.",
    "Source skills in ./.agents/skills stay untouched.",
    ...(plan.disconnectAfter
      ? [
          "After restore, skills-kit manifests are cleared so restored links are left as plain harness links.",
        ]
      : []),
    "",
    "Targets:",
  ];

  for (const target of plan.targets) {
    lines.push(
      `- ${formatTargetLabel(target.target)}: ${formatCount(target.legacyKitIds.length, "legacy kit")}, ${formatCount(target.currentManagedSkillIds.length, "current skill")}`
    );
    if (target.planError) {
      lines.push(`  ! ${target.planError}`);
      continue;
    }
    if (target.plan) {
      lines.push(
        `  create ${target.plan.create.length}, remove ${target.plan.remove.length}, keep ${target.plan.keep.length}, conflicts ${target.plan.conflicts.length}`
      );
    }
  }

  return lines.join("\n");
}

export function formatLegacyRestoreResult(result: LegacyRestoreResult): string {
  if (result.restoredTargets === 0) {
    return [
      "No legacy kits are available for the configured targets.",
      "",
      "Nothing was changed.",
    ].join("\n");
  }

  return [
    "Legacy setup restored.",
    "",
    `Targets: ${result.restoredTargets}`,
    `Created links: ${result.created}`,
    `Removed links: ${result.removed}`,
    `Kept links: ${result.kept}`,
    `Disconnected manifests: ${result.disconnectedTargets}`,
    "",
    "Source skills stayed untouched.",
  ].join("\n");
}

function getLegacyKitIdsForTarget(
  state: WorkspaceState,
  target: HarnessTargetRecord
): string[] {
  const slug = targetSlug(target);
  return state.graph.kits
    .filter((kit) => kit.id.startsWith("legacy-kit-"))
    .filter((kit) => legacyKitTargetSlugs(kit.id).includes(slug))
    .map((kit) => kit.id)
    .toSorted();
}

function legacyKitTargetSlugs(kitId: string): string[] {
  const suffix = kitId.replace(/^legacy-kit-/, "").replace(/-only$/, "");
  const slugs = ["gemini-cli", "claude", "codex", "cursor", "custom"];
  const found = slugs.filter((slug) => {
    if (suffix === slug) {
      return true;
    }
    return suffix.startsWith(`${slug}-`) || suffix.includes(`-${slug}`);
  });
  return found.toSorted();
}

function targetSlug(target: HarnessTargetRecord): string {
  return target.name === "gemini" ? "gemini-cli" : target.name;
}

function formatTargetLabel(target: HarnessTargetRecord): string {
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
    return target.target_path;
  }
  return "Codex";
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
