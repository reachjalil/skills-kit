import {
  loadGraph,
  mergeScannedSkills,
  resolveSkillIdsFromKits,
  saveGraph,
  syncSkillKitIds,
  upsertKit,
} from "./graph";
import { resolveWorkspacePaths, slugifyId } from "../utils/paths";
import { scanSkills } from "./scanner";
import {
  applySymlinkPlan,
  clearManagedManifest,
  loadManagedManifest,
  planSymlinkApply,
  resolveHarnessTargetDir,
} from "../services/harnesses/symlinks";
import type { SkillKitRecord, SkillsGraph, SymlinkApplyPlan } from "../types";
import type { WorkspaceState } from "./workspace";
import { ensureWorkspace } from "./workspace";

export async function initializeRepo(
  root = process.cwd()
): Promise<WorkspaceState> {
  return ensureWorkspace(root, { scan: true });
}

export async function scanRepo(root = process.cwd()): Promise<WorkspaceState> {
  const state = await ensureWorkspace(root);
  const scanned = await scanSkills(state.paths);
  const graph = mergeScannedSkills(state.graph, scanned);
  await saveGraph(state.paths, graph);
  return { ...state, graph };
}

export async function inspectRepo(root = process.cwd()): Promise<SkillsGraph> {
  const paths = resolveWorkspacePaths(root);
  const existingGraph = await loadGraph(paths);
  return mergeScannedSkills(existingGraph, await scanSkills(paths));
}

export async function createOrUpdateKit(
  state: WorkspaceState,
  input: {
    name: string;
    description?: string;
    skillIds: string[];
    tags?: string[];
    reason?: string;
    notes?: string;
  }
): Promise<SkillsGraph> {
  assertKnownSkillIds(state.graph, input.skillIds);
  const graph = upsertKit(state.graph, {
    name: input.name,
    description: input.description,
    skillIds: input.skillIds,
    tags: input.tags,
    reason: input.reason,
    notes: input.notes,
  });
  await saveGraph(state.paths, graph);
  return graph;
}

export async function deleteKit(
  state: WorkspaceState,
  nameOrId: string
): Promise<SkillsGraph> {
  const kit = findKit(state.graph, nameOrId);
  if (!kit) {
    throw new Error(`Unknown kit: ${nameOrId}`);
  }

  const graph = syncSkillKitIds({
    ...state.graph,
    generated_at: new Date().toISOString(),
    kits: state.graph.kits.filter((candidate) => candidate.id !== kit.id),
    selections: state.graph.selections.map((selection) => ({
      ...selection,
      included_kit_ids: selection.included_kit_ids.filter(
        (kitId) => kitId !== kit.id
      ),
    })),
  });
  await saveGraph(state.paths, graph);
  return graph;
}

export async function renameKit(
  state: WorkspaceState,
  nameOrId: string,
  nextName: string
): Promise<SkillsGraph> {
  const kit = findKit(state.graph, nameOrId);
  if (!kit) {
    throw new Error(`Unknown kit: ${nameOrId}`);
  }

  const normalizedNextName = nextName.trim();
  const nextId = slugifyId(normalizedNextName);
  if (!nextId) {
    throw new Error("New kit name is required.");
  }

  const conflict = state.graph.kits.find(
    (candidate) => candidate.id === nextId && candidate.id !== kit.id
  );
  if (conflict) {
    throw new Error(`A kit named ${normalizedNextName} already exists.`);
  }

  const nowIso = new Date().toISOString();
  const graph = syncSkillKitIds({
    ...state.graph,
    generated_at: nowIso,
    kits: state.graph.kits
      .map((candidate) =>
        candidate.id === kit.id
          ? {
              ...candidate,
              id: nextId,
              name: normalizedNextName,
              updated_at: nowIso,
            }
          : candidate
      )
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    selections: state.graph.selections.map((selection) => ({
      ...selection,
      included_kit_ids: selection.included_kit_ids.map((kitId) =>
        kitId === kit.id ? nextId : kitId
      ),
    })),
  });
  await saveGraph(state.paths, graph);
  return graph;
}

export async function planSelection(
  state: WorkspaceState,
  input: {
    kitIds?: string[];
    skillIds?: string[];
    targetPath?: string;
    query?: string;
    mode?: "update" | "add";
  }
): Promise<SymlinkApplyPlan> {
  const requestedKitIds = (input.kitIds ?? []).map(slugifyId);
  const requestedSkillIds = input.skillIds ?? [];
  assertKnownKitIds(state.graph, requestedKitIds);
  assertKnownSkillIds(state.graph, requestedSkillIds);
  const current =
    input.mode === "add"
      ? await getCurrentActivation(state, input.targetPath)
      : undefined;
  const kitIds =
    input.mode === "add"
      ? [...new Set([...(current?.activeKitIds ?? []), ...requestedKitIds])]
      : requestedKitIds;
  const activeSkillIds =
    input.mode === "add"
      ? [...new Set([...(current?.activeSkillIds ?? []), ...requestedSkillIds])]
      : requestedSkillIds;
  const skillIds = [
    ...resolveSkillIdsFromKits(state.graph, kitIds),
    ...activeSkillIds,
  ];
  return planSymlinkApply({
    root: state.paths.root,
    graph: state.graph,
    preferences: state.preferences,
    skillIds,
    activeSkillIds,
    kitIds,
    query: input.query,
    targetPath: input.targetPath,
  });
}

export async function applySelection(
  state: WorkspaceState,
  input: {
    kitIds?: string[];
    skillIds?: string[];
    targetPath?: string;
    query?: string;
    mode?: "update" | "add";
  }
): Promise<{
  graph: SkillsGraph;
  created: number;
  removed: number;
  kept: number;
  targetDir: string;
}> {
  const plan = await planSelection(state, input);

  if (plan.conflicts.length > 0) {
    const details = plan.conflicts
      .map((conflict) => `${conflict.skill_id}: ${conflict.reason}`)
      .join("\n");
    throw new Error(`Selection has conflicts:\n${details}`);
  }

  const result = await applySymlinkPlan(
    {
      root: state.paths.root,
      graph: state.graph,
      preferences: state.preferences,
      skillIds: plan.selected_skill_ids,
      activeSkillIds: plan.active_skill_ids,
      kitIds: plan.active_kit_ids,
      query: input.query,
      targetPath: input.targetPath,
    },
    plan
  );
  await saveGraph(state.paths, result.graph);

  return {
    graph: result.graph,
    created: plan.create.length,
    removed: plan.remove.length,
    kept: plan.keep.length,
    targetDir: plan.target_dir,
  };
}

export async function deactivateSelection(
  state: WorkspaceState,
  input: {
    kitIds?: string[];
    skillIds?: string[];
    all?: boolean;
    targetPath?: string;
    query?: string;
  }
): Promise<{
  graph: SkillsGraph;
  created: number;
  removed: number;
  kept: number;
  targetDir: string;
}> {
  const plan = await planDeactivation(state, input);

  if (plan.conflicts.length > 0) {
    const details = plan.conflicts
      .map((conflict) => `${conflict.skill_id}: ${conflict.reason}`)
      .join("\n");
    throw new Error(`Deactivation has conflicts:\n${details}`);
  }

  const result = await applySymlinkPlan(
    {
      root: state.paths.root,
      graph: state.graph,
      preferences: state.preferences,
      skillIds: plan.selected_skill_ids,
      activeSkillIds: plan.active_skill_ids,
      kitIds: plan.active_kit_ids,
      query: input.query ?? "deactivate",
      targetPath: input.targetPath,
    },
    plan
  );
  await saveGraph(state.paths, result.graph);

  return {
    graph: result.graph,
    created: plan.create.length,
    removed: plan.remove.length,
    kept: plan.keep.length,
    targetDir: plan.target_dir,
  };
}

export async function planDeactivation(
  state: WorkspaceState,
  input: {
    kitIds?: string[];
    skillIds?: string[];
    all?: boolean;
    targetPath?: string;
    query?: string;
  }
): Promise<SymlinkApplyPlan> {
  const nextSelection = await resolveDeactivationSelection(state, input);
  return planSymlinkApply({
    root: state.paths.root,
    graph: state.graph,
    preferences: state.preferences,
    skillIds: nextSelection.remainingSkillIds,
    activeSkillIds: nextSelection.remainingExplicitSkillIds,
    kitIds: nextSelection.remainingKitIds,
    query: input.query ?? "deactivate",
    targetPath: input.targetPath,
  });
}

export async function getCurrentActivation(
  state: WorkspaceState,
  targetPath?: string
): Promise<{
  targetDir: string;
  managedSkillIds: string[];
  activeKitIds: string[];
  activeSkillIds: string[];
}> {
  const targetDir = resolveHarnessTargetDir({
    root: state.paths.root,
    preferences: state.preferences,
    targetPath,
  });
  const manifest = await loadManagedManifest(state.paths.root, targetDir);

  return {
    targetDir,
    managedSkillIds: manifest.managed_skill_ids,
    activeKitIds: manifest.active_kit_ids,
    activeSkillIds: manifest.active_skill_ids,
  };
}

export async function forgetActivationState(
  state: WorkspaceState,
  targetPath?: string
): Promise<{
  targetDir: string;
}> {
  const targetDir = resolveHarnessTargetDir({
    root: state.paths.root,
    preferences: state.preferences,
    targetPath,
  });
  await clearManagedManifest(state.paths.root, targetDir);
  return { targetDir };
}

async function resolveDeactivationSelection(
  state: WorkspaceState,
  input: {
    kitIds?: string[];
    skillIds?: string[];
    all?: boolean;
    targetPath?: string;
  }
): Promise<{
  remainingKitIds: string[];
  remainingExplicitSkillIds: string[];
  remainingSkillIds: string[];
}> {
  const current = await getCurrentActivation(state, input.targetPath);
  const requestedKitIds = (input.kitIds ?? []).map(slugifyId);
  assertKnownKitIds(state.graph, requestedKitIds);
  assertKnownSkillIds(state.graph, input.skillIds ?? []);
  const requestedSkillIds = [
    ...resolveSkillIdsFromKits(state.graph, requestedKitIds),
    ...(input.skillIds ?? []),
  ];

  const remainingKitIds = input.all
    ? []
    : current.activeKitIds.filter((kitId) => !requestedKitIds.includes(kitId));
  const removeSkillIds = new Set(requestedSkillIds);
  const remainingExplicitSkillIds = input.all
    ? []
    : current.activeSkillIds.filter((skillId) => !removeSkillIds.has(skillId));
  const remainingSkillIds =
    input.all || current.activeKitIds.length > 0
      ? [
          ...resolveSkillIdsFromKits(state.graph, remainingKitIds),
          ...remainingExplicitSkillIds,
        ]
      : current.managedSkillIds.filter(
          (skillId) => !removeSkillIds.has(skillId)
        );
  const blockedSkillIds = uniqueSorted(input.skillIds ?? []).filter((skillId) =>
    remainingSkillIds.includes(skillId)
  );
  if (blockedSkillIds.length > 0) {
    throw new Error(
      `Cannot remove skill id(s) still included by active kit(s): ${blockedSkillIds.join(", ")}. Remove the owning kit first.`
    );
  }
  return {
    remainingKitIds,
    remainingExplicitSkillIds,
    remainingSkillIds,
  };
}

export function formatApplyPlan(plan: SymlinkApplyPlan): string {
  const lines = [
    `Target: ${plan.target_dir}`,
    `Selected: ${plan.selected_skill_ids.length}`,
    `Create: ${plan.create.length}`,
    `Remove: ${plan.remove.length}`,
    `Keep: ${plan.keep.length}`,
    `Conflicts: ${plan.conflicts.length}`,
  ];

  lines.push("", formatApplyPlanDiff(plan));
  if (plan.conflicts.length > 0) {
    lines.push(
      "",
      "Conflicts:",
      ...plan.conflicts.map(
        (conflict) => `! ${conflict.skill_id}: ${conflict.reason}`
      )
    );
  }

  return lines.join("\n");
}

function formatApplyPlanDiff(plan: SymlinkApplyPlan): string {
  const currentIds = planCurrentSkillIds(plan);
  const nextIds = planNextSkillIds(plan);
  const current = new Set(currentIds);
  const next = new Set(nextIds);
  const allIds = [...new Set([...currentIds, ...nextIds])].toSorted();
  const leftWidth = Math.min(
    Math.max(
      "Current managed links".length,
      ...allIds.map((skillId) => skillId.length + 2)
    ),
    42
  );
  const rightWidth = Math.min(
    Math.max(
      "Next managed links".length,
      ...allIds.map((skillId) => skillId.length + 2)
    ),
    42
  );
  const lines = [
    `${"Current managed links".padEnd(leftWidth)}   Next managed links`,
    `${"─".repeat(leftWidth)}   ${"─".repeat(rightWidth)}`,
  ];

  if (allIds.length === 0) {
    lines.push("No managed symlink changes.");
    return lines.join("\n");
  }

  for (const skillId of allIds) {
    const isCurrent = current.has(skillId);
    const isNext = next.has(skillId);
    const leftText = isCurrent ? `${isNext ? " " : "-"} ${skillId}` : "";
    const rightText = isNext ? `${isCurrent ? " " : "+"} ${skillId}` : "";
    lines.push(`${leftText.padEnd(leftWidth)}   ${rightText}`);
  }

  return lines.join("\n");
}

function planCurrentSkillIds(plan: SymlinkApplyPlan): string[] {
  return [
    ...new Set([
      ...plan.keep.map((action) => action.skill_id),
      ...plan.remove.map((action) => action.skill_id),
    ]),
  ].toSorted();
}

function planNextSkillIds(plan: SymlinkApplyPlan): string[] {
  return [
    ...new Set([
      ...plan.keep.map((action) => action.skill_id),
      ...plan.create.map((action) => action.skill_id),
    ]),
  ].toSorted();
}

export function findKit(
  graph: SkillsGraph,
  nameOrId: string
): SkillKitRecord | undefined {
  const id = slugifyId(nameOrId);
  return graph.kits.find((kit) => kit.id === id || kit.name === nameOrId);
}

export function parsePromptKitIds(
  graph: SkillsGraph,
  prompt: string
): string[] {
  const normalizedPrompt = prompt.toLowerCase();
  const matches = graph.kits
    .filter((kit) => {
      const id = kit.id.toLowerCase();
      const name = kit.name.toLowerCase();
      return normalizedPrompt.includes(id) || normalizedPrompt.includes(name);
    })
    .map((kit) => kit.id);

  if (matches.length > 0) {
    return matches;
  }

  return prompt
    .toLowerCase()
    .replace(/activate|only|my|skills|skill|and|,|\+/g, " ")
    .split(/\s+/)
    .map(slugifyId)
    .filter((value) => graph.kits.some((kit) => kit.id === value));
}

export function formatStatus(graph: SkillsGraph): string {
  const groupedSkillIds = new Set(graph.kits.flatMap((kit) => kit.skill_ids));
  const staleReviewCount = graph.skills.filter(
    (skill) => !skill.last_reviewed_at
  ).length;

  return [
    `Skills: ${graph.skills.length}`,
    `Kits: ${graph.kits.length}`,
    `Grouped: ${groupedSkillIds.size}`,
    `Ungrouped: ${graph.skills.length - groupedSkillIds.size}`,
    `Needs review: ${staleReviewCount}`,
  ].join("\n");
}

function assertKnownKitIds(graph: SkillsGraph, kitIds: string[]): void {
  const known = new Set(graph.kits.map((kit) => kit.id));
  const missing = uniqueSorted(kitIds).filter((kitId) => !known.has(kitId));
  if (missing.length > 0) {
    throw new Error(`Unknown skills-kit id(s): ${missing.join(", ")}`);
  }
}

function assertKnownSkillIds(graph: SkillsGraph, skillIds: string[]): void {
  const known = new Set(graph.skills.map((skill) => skill.id));
  const missing = uniqueSorted(skillIds).filter(
    (skillId) => !known.has(skillId)
  );
  if (missing.length > 0) {
    throw new Error(`Unknown skill id(s): ${missing.join(", ")}`);
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].toSorted();
}
