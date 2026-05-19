#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parse } from "smol-toml";

import {
  applySelection,
  deleteKit,
  createOrUpdateKit,
  deactivateSelection,
  findKit,
  formatApplyPlan,
  formatStatus,
  getCurrentActivation,
  inspectRepo,
  parsePromptKitIds,
  planDeactivation,
  planSelection,
  renameKit,
  scanRepo,
} from "./core/commands";
import {
  createSkillScanDiagnostics,
  hasBlockingSkillIssues,
  runSourceInventoryCheck,
} from "./services/validation/diagnostics";
import {
  getConfiguredHarnessTargets,
  inspectHarnessHealth,
} from "./services/harnesses/health";
import {
  formatLegacyRestorePlan,
  formatLegacyRestoreResult,
  hasLegacyRestoreChanges,
  planLegacyRestore,
  restoreLegacySetup,
} from "./services/harnesses/legacy-restore";
import { getPackageJsonIntegrationStatus } from "./services/package-json/package-json";
import { resolveWorkspacePaths, slugifyId } from "./utils/paths";
import {
  defaultTargetPathForHarness,
  loadPreferences,
  savePreferences,
} from "./config/preferences";
import {
  loadManagedManifest,
  resolveHarnessTargetDir,
} from "./services/harnesses/symlinks";
import type {
  HarnessTargetRecord,
  SkillKitRecord,
  SkillsGraph,
  SymlinkApplyPlan,
} from "./types";
import { runTui } from "./tui";
import {
  formatUninstallConfirmation,
  formatUninstallPlan,
  formatUninstallResult,
  planUninstall,
  uninstallSkillsKit,
  type UninstallScope,
} from "./services/lifecycle/uninstall";
import type { WorkspaceState } from "./core/workspace";

async function main(): Promise<void> {
  const cli = parseGlobalArgs(process.argv.slice(2));
  applyColorPreference(cli.color);
  const args = cli.args;
  const command = args[0];
  const root = resolveCliRoot(cli.root);

  if (!command) {
    assertNoJson(cli, "guided switchboard");
    await runTui(root, { startupReview: cli.startupReview });
    return;
  }

  if (command === "--help" || command === "-h") {
    console.log(formatHelp());
    return;
  }

  if (command === "help") {
    console.log(formatHelpTopic(args[1]));
    return;
  }

  if (command === "man" || command === "manual") {
    console.log(formatManual());
    return;
  }

  if (command === "completion" || command === "completions") {
    await handleCompletionCommand(args.slice(1));
    return;
  }

  if (command === "doctor") {
    await handleDoctorCommand(root, args.slice(1), cli);
    return;
  }

  if (command === "validate") {
    await handleValidateCommand(root, args.slice(1), cli);
    return;
  }

  if (command === "targets") {
    await handleTargetsCommand(root, args.slice(1), cli);
    return;
  }

  if (command === "init") {
    if (hasHelpFlag(args.slice(1))) {
      console.log(formatCommandHelp("init"));
      return;
    }
    assertNoJson(cli, "init");
    await runTui(root, { startupReview: cli.startupReview });
    return;
  }

  if (command === "scan") {
    if (hasHelpFlag(args.slice(1))) {
      console.log(formatCommandHelp("scan"));
      return;
    }
    const state = await scanRepo(root);
    console.log(
      cli.json
        ? formatJson(createStatusSummary(state.graph))
        : formatStatus(state.graph)
    );
    return;
  }

  if (command === "status") {
    if (hasHelpFlag(args.slice(1))) {
      console.log(formatCommandHelp("status"));
      return;
    }
    const graph = await inspectRepo(root);
    console.log(
      cli.json ? formatJson(createStatusSummary(graph)) : formatStatus(graph)
    );
    return;
  }

  if (command === "list") {
    if (hasHelpFlag(args.slice(1))) {
      console.log(formatCommandHelp("list"));
      return;
    }
    const graph = await inspectRepo(root);
    if (cli.json) {
      console.log(formatJson({ skills: graph.skills }));
      return;
    }
    for (const skill of graph.skills) {
      const kits = skill.kit_ids.length ? ` [${skill.kit_ids.join(", ")}]` : "";
      console.log(`${skill.id}${kits} - ${skill.description || skill.status}`);
    }
    return;
  }

  if (command === "kit") {
    await handleKitCommand(root, args.slice(1), cli);
    return;
  }

  if (command === "apply" || command === "update") {
    await handleApplyCommand(root, args.slice(1), "update", command, cli);
    return;
  }

  if (command === "add") {
    await handleApplyCommand(root, args.slice(1), "add", "add", cli);
    return;
  }

  if (command === "remove") {
    await handleApplyCommand(root, args.slice(1), "remove", "remove", cli);
    return;
  }

  if (command === "deactivate") {
    await handleDeactivateCommand(root, args.slice(1), cli);
    return;
  }

  if (command === "restore-legacy" || command === "revert-legacy") {
    await handleRestoreLegacyCommand(root, args.slice(1), cli);
    return;
  }

  if (command === "uninstall") {
    await handleUninstallCommand(root, args.slice(1), cli);
    return;
  }

  if (command.startsWith("-")) {
    throw new Error(`Unknown option: ${command}`);
  }

  const prompt = args.join(" ");
  if (prompt.trim()) {
    assertNoJson(cli, "prompt apply");
    let state = await scanRepo(root);
    const kitIds = parsePromptKitIds(state.graph, prompt);
    if (kitIds.length === 0) {
      throw new Error(`No skills-kit matched prompt: ${prompt}`);
    }
    for (const targetPath of resolveTargetPaths(state, parseApplyArgs([]))) {
      const result = await applySelection(state, {
        kitIds,
        targetPath,
        query: prompt,
      });
      state = { ...state, graph: result.graph };
      console.log(
        `Applied ${kitIds.join(", ")} to ${result.targetDir}. Created ${result.created}, removed ${result.removed}, kept ${result.kept}.`
      );
    }
    return;
  }
}

async function handleUninstallCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("uninstall"));
    return;
  }

  const parsed = parseUninstallArgs(args);
  const dryRun = parsed.dryRun;
  if (cli.json && !dryRun) {
    throw new Error("--json is available for uninstall only with --dry-run.");
  }
  const legacyState = parsed.restoreLegacy ? await scanRepo(root) : undefined;
  const legacyPlan = legacyState
    ? await planLegacyRestore(legacyState, { disconnectAfter: true })
    : undefined;
  const uninstallScope = parsed.restoreLegacy
    ? restoreLegacyUninstallScope(parsed.scope)
    : parsed.scope;
  const plan = uninstallScope
    ? await planUninstall(root, { scope: uninstallScope })
    : undefined;

  if (dryRun) {
    if (cli.json) {
      console.log(formatJson({ legacyRestore: legacyPlan, uninstall: plan }));
      return;
    }
    console.log(
      [
        legacyPlan ? formatLegacyRestorePlan(legacyPlan) : "",
        plan ? formatUninstallPlan(plan) : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return;
  }

  const hasChanges =
    (legacyPlan ? hasLegacyRestoreChanges(legacyPlan) : false) ||
    (plan ? planHasUninstallChanges(plan) : false);
  if (!hasChanges) {
    console.log(formatUninstallResult(emptyUninstallResult(parsed.scope)));
    return;
  }

  const confirmation = [
    legacyPlan ? formatLegacyRestorePlan(legacyPlan) : "",
    plan ? formatUninstallConfirmation(plan) : 'Type "delete" to confirm.',
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!(await confirmUninstall(confirmation))) {
    console.log("Uninstall cancelled. Nothing was removed.");
    return;
  }

  if (legacyState) {
    const legacyResult = await restoreLegacySetup(legacyState, {
      disconnectAfter: true,
    });
    console.log(formatLegacyRestoreResult(legacyResult));
  }
  if (plan && uninstallScope) {
    const result = await uninstallSkillsKit(root, { scope: uninstallScope });
    console.log(formatUninstallResult(result));
  }
}

async function handleRestoreLegacyCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("restore-legacy"));
    return;
  }

  const parsed = parseRestoreLegacyArgs(args);
  const state = await scanRepo(root);
  const plan = await planLegacyRestore(state, {
    disconnectAfter: parsed.disconnectAfter,
  });
  if (parsed.dryRun) {
    console.log(cli.json ? formatJson(plan) : formatLegacyRestorePlan(plan));
    return;
  }
  assertNoJson(cli, "restore-legacy");
  const result = await restoreLegacySetup(state, {
    disconnectAfter: parsed.disconnectAfter,
  });
  console.log(formatLegacyRestoreResult(result));
}

async function confirmUninstall(message: string): Promise<boolean> {
  console.log(message);
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question("> ");
    if (!input.isTTY) {
      output.write("\n");
    }
    return answer.trim() === "delete";
  } finally {
    readline.close();
  }
}

function planHasUninstallChanges(
  plan: Awaited<ReturnType<typeof planUninstall>>
): boolean {
  return (
    ((plan.scope === "settings" || plan.scope === "all") &&
      plan.metadataExists) ||
    plan.manifests.some(
      (manifest) =>
        manifest.managedSkillIds.length > 0 ||
        manifest.removeSymlinks.length > 0 ||
        manifest.skipped.length > 0
    ) ||
    (plan.packageJson?.removeScripts.length ?? 0) > 0 ||
    (plan.packageJson?.removeDependencySections.length ?? 0) > 0
  );
}

function emptyUninstallResult(
  scope: UninstallScope
): Awaited<ReturnType<typeof uninstallSkillsKit>> {
  return {
    scope,
    removedSymlinks: 0,
    skipped: 0,
    clearedManifests: 0,
    removedMetadata: false,
    removedPackageScripts: 0,
    removedPackageDependencies: 0,
  };
}

type ColorPreference = "auto" | "always" | "never";

interface GlobalCliOptions {
  args: string[];
  root?: string;
  json: boolean;
  color: ColorPreference;
  startupReview: boolean;
}

function parseGlobalArgs(args: string[]): GlobalCliOptions {
  const remaining: string[] = [];
  let root: string | undefined;
  let json = false;
  let color: ColorPreference = "auto";
  let startupReview = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root" || arg === "-C") {
      root = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      if (!root) {
        throw new Error("--root requires a value.");
      }
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-startup-review") {
      startupReview = false;
      continue;
    }
    if (arg === "--no-color") {
      color = "never";
      continue;
    }
    if (arg === "--color") {
      color = parseColorPreference(requireFlagValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--color=")) {
      color = parseColorPreference(arg.slice("--color=".length));
      continue;
    }

    remaining.push(arg);
  }

  return {
    args: remaining,
    root,
    json,
    color,
    startupReview,
  };
}

function parseColorPreference(value: string): ColorPreference {
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }
  throw new Error("--color must be auto, always, or never.");
}

function applyColorPreference(color: ColorPreference): void {
  if (color === "never") {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    return;
  }
  if (color === "always") {
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
  }
}

function assertNoJson(cli: GlobalCliOptions, command: string): void {
  if (!cli.json) {
    return;
  }
  throw new Error(`--json is not available for ${command}.`);
}

function resolveCliRoot(rootOverride?: string): string {
  return path.resolve(
    rootOverride ??
      process.env.SKILLS_KIT_ROOT ??
      process.env.INIT_CWD ??
      process.cwd()
  );
}

async function handleCompletionCommand(args: string[]): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("completion"));
    return;
  }

  const shell = args[0] ?? "zsh";
  if (shell !== "zsh") {
    throw new Error("Only zsh completion is available right now.");
  }

  console.log(formatZshCompletion());
}

async function handleDoctorCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("doctor"));
    return;
  }
  assertNoArgs(args, "doctor");

  const report = await createDiagnosticsReport(root);
  console.log(cli.json ? formatJson(report) : formatDoctorReport(report));
  if (report.blocking) {
    process.exitCode = 1;
  }
}

async function handleValidateCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("validate"));
    return;
  }
  const parsed = parseValidateArgs(args);
  const report = await createDiagnosticsReport(root);
  console.log(
    cli.json ? formatJson(report.validation) : formatValidationReport(report)
  );

  if (
    report.validation.errors > 0 ||
    report.harnessHealth.issues.length > 0 ||
    (parsed.strict && report.validation.warnings > 0)
  ) {
    process.exitCode = 1;
  }
}

async function handleTargetsCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("targets"));
    return;
  }
  const parsed = parseTargetsArgs(args);

  const state = await inspectWorkspaceState(root);
  if (parsed.setDefaults) {
    const defaultHarnesses = resolveDefaultHarnessTargets(
      state,
      parsed.setDefaults
    );
    const preferences = {
      ...state.preferences,
      harness: {
        ...state.preferences.harness,
        name: defaultHarnesses[0]?.name ?? state.preferences.harness.name,
        target_path:
          defaultHarnesses[0]?.target_path ??
          state.preferences.harness.target_path,
      },
      supported_harnesses: mergeHarnessTargets(
        getSupportedHarnessTargets(state),
        defaultHarnesses
      ),
      default_harnesses: defaultHarnesses,
    };
    await savePreferences(state.paths, preferences);
    const nextState = { ...state, preferences };
    const targets = await createTargetsSummary(nextState);
    const output = {
      ...targets,
      updated_defaults: defaultHarnesses.map((target) => target.target_path),
    };
    console.log(cli.json ? formatJson(output) : formatTargetsSummary(targets));
    return;
  }

  const targets = await createTargetsSummary(state);
  console.log(cli.json ? formatJson(targets) : formatTargetsSummary(targets));
}

async function handleKitCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("kit"));
    return;
  }

  const action = args[0];
  if (action === "list" || action === "ls") {
    const graph = await inspectRepo(root);
    console.log(
      cli.json
        ? formatJson({ kits: graph.kits.map(createKitSummary) })
        : formatKitList(graph)
    );
    return;
  }

  if (action === "show") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: skills-kit kit show <name>");
    }
    assertNoArgs(args.slice(2), "kit show");
    const graph = await inspectRepo(root);
    const kit = findKit(graph, name);
    if (!kit) {
      throw new Error(`Unknown kit: ${name}`);
    }
    console.log(cli.json ? formatJson({ kit }) : formatKitDetails(kit));
    return;
  }

  if (action === "delete" || action === "rm") {
    await handleKitDeleteCommand(root, args.slice(1), cli);
    return;
  }

  if (action === "rename" || action === "mv") {
    await handleKitRenameCommand(root, args.slice(1), cli);
    return;
  }

  if (action !== "create" && action !== "set") {
    throw new Error(
      "Usage: skills-kit kit <list|show|create|set|rename|delete>"
    );
  }

  const name = args[1];
  const parsed = parseKitArgs(args.slice(2));
  if (!name) {
    throw new Error(
      "Usage: skills-kit kit create <name> <skill...> [--description ...] [--reason ...] [--tag ...]"
    );
  }
  if (name.startsWith("--")) {
    throw new Error("Kit name is required before flags.");
  }
  if (parsed.skillIds.length === 0) {
    throw new Error("Usage: skills-kit kit create <name> <skill...>");
  }

  const state = await scanRepo(root);
  const graph = await createOrUpdateKit(state, {
    name,
    skillIds: parsed.skillIds,
    description: parsed.description,
    reason: parsed.reason,
    tags: parsed.tags,
  });
  const kit = graph.kits.find(
    (candidate) => candidate.id === name || candidate.name === name
  );
  if (cli.json) {
    console.log(formatJson({ kit, skill_count: parsed.skillIds.length }));
    return;
  }

  console.log(
    `Saved ${kit?.name ?? name} with ${parsed.skillIds.length} skills.`
  );
}

async function handleKitDeleteCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  const name = args[0];
  const parsed = parseKitMutationArgs(args.slice(1), "delete");
  if (!name) {
    throw new Error("Usage: skills-kit kit delete <name> [--yes]");
  }
  if (parsed.dryRun && parsed.yes) {
    throw new Error("--dry-run cannot be combined with --yes.");
  }

  const state = await inspectWorkspaceState(root);
  const kit = findKit(state.graph, name);
  if (!kit) {
    throw new Error(`Unknown kit: ${name}`);
  }
  await assertKitNotActive(state, kit.id);

  if (parsed.dryRun) {
    const summary = {
      action: "delete",
      kit: createKitSummary(kit),
      would_delete: true,
    };
    console.log(cli.json ? formatJson(summary) : formatKitDeletePlan(kit));
    return;
  }

  if (!parsed.yes) {
    throw new Error(
      "Refusing to delete without confirmation. Re-run with --yes after reviewing `skills-kit kit show <name>`."
    );
  }

  await deleteKit(state, kit.id);
  const summary = {
    action: "delete",
    kit: createKitSummary(kit),
    deleted: true,
  };
  console.log(
    cli.json
      ? formatJson(summary)
      : `Deleted kit ${kit.name}. Source skills were not changed.`
  );
}

async function handleKitRenameCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  const currentName = args[0];
  const nextName = args[1];
  const parsed = parseKitMutationArgs(args.slice(2), "rename");
  if (!currentName || !nextName) {
    throw new Error("Usage: skills-kit kit rename <current-name> <new-name>");
  }
  if (parsed.yes) {
    throw new Error("--yes is not used by kit rename.");
  }

  const state = await inspectWorkspaceState(root);
  const kit = findKit(state.graph, currentName);
  if (!kit) {
    throw new Error(`Unknown kit: ${currentName}`);
  }
  await assertKitNotActive(state, kit.id);

  if (parsed.dryRun) {
    const summary = {
      action: "rename",
      current: createKitSummary(kit),
      next_name: nextName.trim(),
      next_id: slugifyId(nextName),
      would_rename: true,
    };
    console.log(
      cli.json ? formatJson(summary) : formatKitRenamePlan(kit, nextName)
    );
    return;
  }

  const graph = await renameKit(state, kit.id, nextName);
  const renamed = findKit(graph, nextName);
  const summary = {
    action: "rename",
    previous: createKitSummary(kit),
    kit: renamed ? createKitSummary(renamed) : undefined,
    renamed: true,
  };
  console.log(
    cli.json
      ? formatJson(summary)
      : `Renamed kit ${kit.name} to ${renamed?.name ?? nextName.trim()}.`
  );
}

type ApplyMode = "update" | "add" | "remove";

async function handleApplyCommand(
  root: string,
  args: string[],
  defaultMode: ApplyMode,
  helpTopic: "add" | "apply" | "remove" | "update",
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp(helpTopic));
    return;
  }

  let state = await scanRepo(root);
  const parsed = parseApplyArgs(args);
  const kitIds = parsed.kitIds;
  const skillIds = parsed.allSkills
    ? getApplicableSkillIds(state)
    : parsed.skillIds;
  const mode = parsed.mode ?? defaultMode;
  if (cli.json && !parsed.dryRun) {
    throw new Error(
      `--json is available for ${helpTopic} only with --dry-run.`
    );
  }

  if (parsed.allSkills && (kitIds.length > 0 || parsed.skillIds.length > 0)) {
    throw new Error("--all-skills cannot be combined with --kits or --skills.");
  }

  if (kitIds.length === 0 && skillIds.length === 0 && !parsed.allSkills) {
    throw new Error(
      "Usage: skills-kit update --kits ui,testing OR skills-kit update --all-skills OR skills-kit add --skills frontend-design OR skills-kit remove --kits ui"
    );
  }

  const jsonPlans: ReturnType<typeof createApplyPlanSummary>[] = [];
  for (const targetPath of resolveTargetPaths(state, parsed)) {
    if (parsed.dryRun) {
      const plan =
        mode === "remove"
          ? await planDeactivation(state, {
              kitIds,
              skillIds,
              targetPath,
              query: `cli dry-run ${mode} ${args.join(" ")}`,
            })
          : await planSelection(state, {
              kitIds,
              skillIds,
              targetPath,
              mode,
              query: `cli dry-run ${mode} ${args.join(" ")}`,
            });
      if (cli.json) {
        jsonPlans.push(createApplyPlanSummary(plan));
        continue;
      }
      console.log(formatApplyPlan(plan));
      continue;
    }

    const result =
      mode === "remove"
        ? await deactivateSelection(state, {
            kitIds,
            skillIds,
            targetPath,
            query: `cli remove ${args.join(" ")}`,
          })
        : await applySelection(state, {
            kitIds,
            skillIds,
            targetPath,
            mode,
            query: `cli ${mode} ${args.join(" ")}`,
          });
    state = { ...state, graph: result.graph };
    console.log(
      `${formatModePastTense(mode)} selection in ${result.targetDir}. Created ${result.created}, removed ${result.removed}, kept ${result.kept}.`
    );
  }

  if (cli.json) {
    console.log(formatJson({ mode, plans: jsonPlans }));
  }
}

async function handleDeactivateCommand(
  root: string,
  args: string[],
  cli: GlobalCliOptions
): Promise<void> {
  if (hasHelpFlag(args)) {
    console.log(formatCommandHelp("deactivate"));
    return;
  }

  let state = await scanRepo(root);
  const parsed = parseApplyArgs(args);
  if (cli.json && !parsed.dryRun) {
    throw new Error("--json is available for deactivate only with --dry-run.");
  }

  if (parsed.all && (parsed.kitIds.length > 0 || parsed.skillIds.length > 0)) {
    throw new Error("--all cannot be combined with --kits or --skills.");
  }

  if (
    !parsed.all &&
    parsed.kitIds.length === 0 &&
    parsed.skillIds.length === 0
  ) {
    throw new Error(
      "Usage: skills-kit deactivate --all OR skills-kit deactivate --kits ui OR skills-kit deactivate --skills frontend-design"
    );
  }

  const jsonPlans: ReturnType<typeof createApplyPlanSummary>[] = [];
  for (const targetPath of resolveTargetPaths(state, parsed)) {
    if (parsed.dryRun) {
      const plan = await planDeactivation(state, {
        kitIds: parsed.kitIds,
        skillIds: parsed.skillIds,
        all: parsed.all,
        targetPath,
        query: `cli dry-run deactivate ${args.join(" ")}`,
      });
      if (cli.json) {
        jsonPlans.push(createApplyPlanSummary(plan));
        continue;
      }
      console.log(formatApplyPlan(plan));
      continue;
    }

    const result = await deactivateSelection(state, {
      kitIds: parsed.kitIds,
      skillIds: parsed.skillIds,
      all: parsed.all,
      targetPath,
      query: `cli deactivate ${args.join(" ")}`,
    });
    state = { ...state, graph: result.graph };
    console.log(
      `Deactivated selection in ${result.targetDir}. Removed ${result.removed}, kept ${result.kept}.`
    );
  }

  if (cli.json) {
    console.log(formatJson({ mode: "deactivate", plans: jsonPlans }));
  }
}

function parseKitArgs(args: string[]): {
  skillIds: string[];
  description?: string;
  reason?: string;
  tags: string[];
} {
  const skillIds: string[] = [];
  const tags: string[] = [];
  let description: string | undefined;
  let reason: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--description") {
      description = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      reason = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--tag" || arg === "--tags") {
      tags.push(...splitCsv(requireFlagValue(args, index, arg), arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown kit option: ${arg}`);
    }
    if (!arg.startsWith("--")) {
      skillIds.push(arg);
    }
  }

  return { skillIds, description, reason, tags };
}

function parseApplyArgs(args: string[]): {
  kitIds: string[];
  skillIds: string[];
  targetPath?: string;
  targetPaths: string[];
  allHarnesses: boolean;
  dryRun: boolean;
  all: boolean;
  allSkills: boolean;
  mode?: ApplyMode;
} {
  const kitIds: string[] = [];
  const skillIds: string[] = [];
  const targetPaths: string[] = [];
  let targetPath: string | undefined;
  let dryRun = false;
  let all = false;
  let allSkills = false;
  let allHarnesses = false;
  let mode: ApplyMode | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--kits") {
      kitIds.push(...splitCsv(requireFlagValue(args, index, arg), arg));
      index += 1;
      continue;
    }
    if (arg === "--skills") {
      skillIds.push(...splitCsv(requireFlagValue(args, index, arg), arg));
      index += 1;
      continue;
    }
    if (arg === "--target") {
      targetPath = requireFlagValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--targets") {
      targetPaths.push(...splitCsv(requireFlagValue(args, index, arg), arg));
      index += 1;
      continue;
    }
    if (arg === "--all-harnesses" || arg === "--all-targets") {
      allHarnesses = true;
      continue;
    }
    if (arg === "--mode") {
      const next = requireFlagValue(args, index, arg);
      if (next !== "update" && next !== "add" && next !== "remove") {
        throw new Error("--mode must be update, add, or remove.");
      }
      mode = next;
      index += 1;
      continue;
    }
    if (arg === "--dry-run" || arg === "--plan") {
      dryRun = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--all-skills") {
      allSkills = true;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown selection option: ${arg}`);
    }
    if (!arg.startsWith("--")) {
      kitIds.push(arg);
    }
  }

  return {
    kitIds,
    skillIds,
    targetPath,
    targetPaths,
    allHarnesses,
    dryRun,
    all,
    allSkills,
    mode,
  };
}

function resolveTargetPaths(
  state: Awaited<ReturnType<typeof scanRepo>>,
  parsed: ReturnType<typeof parseApplyArgs>
): Array<string | undefined> {
  const supported = state.preferences.supported_harnesses.length
    ? state.preferences.supported_harnesses
    : [
        {
          name: state.preferences.harness.name,
          target_path: state.preferences.harness.target_path,
        },
      ];

  if (parsed.allHarnesses) {
    return supported.map((target) => target.target_path);
  }

  const explicitTargets = [
    ...parsed.targetPaths,
    ...(parsed.targetPath ? [parsed.targetPath] : []),
  ];
  if (explicitTargets.length === 0) {
    return state.preferences.default_harnesses.length
      ? state.preferences.default_harnesses.map((target) => target.target_path)
      : [undefined];
  }

  return explicitTargets.map((target) => {
    const matched = supported.find(
      (candidate) =>
        candidate.name === target || candidate.target_path === target
    );
    return (
      matched?.target_path ??
      defaultTargetPathForBuiltInHarness(target) ??
      target
    );
  });
}

function getSupportedHarnessTargets(
  state: WorkspaceState
): HarnessTargetRecord[] {
  return state.preferences.supported_harnesses.length
    ? state.preferences.supported_harnesses
    : [
        {
          name: state.preferences.harness.name,
          target_path: state.preferences.harness.target_path,
        },
      ];
}

function resolveDefaultHarnessTargets(
  state: WorkspaceState,
  targets: string[]
): HarnessTargetRecord[] {
  const supported = getSupportedHarnessTargets(state);
  const resolved: HarnessTargetRecord[] = targets.map((target) => {
    const matched = supported.find(
      (candidate) =>
        candidate.name === target || candidate.target_path === target
    );
    if (matched) {
      return matched;
    }

    if (
      target === "codex" ||
      target === "claude" ||
      target === "gemini" ||
      target === "cursor"
    ) {
      return {
        name: target,
        target_path: defaultTargetPathForHarness(target),
      };
    }

    return {
      name: "custom" as const,
      target_path: target,
    };
  });

  return mergeHarnessTargets([], resolved);
}

function mergeHarnessTargets(
  current: HarnessTargetRecord[],
  next: HarnessTargetRecord[]
): HarnessTargetRecord[] {
  const byPath = new Map<string, HarnessTargetRecord>();
  for (const target of [...current, ...next]) {
    byPath.set(target.target_path, target);
  }
  return [...byPath.values()];
}

function defaultTargetPathForBuiltInHarness(
  target: string
): string | undefined {
  if (
    target === "codex" ||
    target === "claude" ||
    target === "gemini" ||
    target === "cursor"
  ) {
    return defaultTargetPathForHarness(target);
  }
  return undefined;
}

function formatModePastTense(mode: ApplyMode): string {
  if (mode === "add") {
    return "Added";
  }
  if (mode === "remove") {
    return "Removed";
  }
  return "Updated";
}

function getApplicableSkillIds(
  state: Awaited<ReturnType<typeof scanRepo>>
): string[] {
  return state.graph.skills
    .filter((skill) => skill.status !== "missing_skill_md")
    .map((skill) => skill.id)
    .toSorted();
}

function parseUninstallArgs(args: string[]): {
  dryRun: boolean;
  scope: UninstallScope;
  restoreLegacy: boolean;
} {
  let dryRun = false;
  let scope: UninstallScope = "all";
  let restoreLegacy = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run" || arg === "--plan") {
      dryRun = true;
      continue;
    }
    if (
      arg === "--restore-legacy" ||
      arg === "--revert-legacy" ||
      arg === "--legacy"
    ) {
      restoreLegacy = true;
      continue;
    }
    if (arg === "--scope") {
      scope = parseUninstallScope(requireFlagValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      scope = parseUninstallScope(arg.slice("--scope=".length));
      continue;
    }
    throw new Error(`Unknown uninstall option: ${arg}`);
  }
  return { dryRun, scope, restoreLegacy };
}

function parseRestoreLegacyArgs(args: string[]): {
  dryRun: boolean;
  disconnectAfter: boolean;
} {
  let dryRun = false;
  let disconnectAfter = false;
  for (const arg of args) {
    if (arg === "--dry-run" || arg === "--plan") {
      dryRun = true;
      continue;
    }
    if (arg === "--disconnect" || arg === "--unmanage") {
      disconnectAfter = true;
      continue;
    }
    throw new Error(`Unknown restore-legacy option: ${arg}`);
  }
  return { dryRun, disconnectAfter };
}

function restoreLegacyUninstallScope(
  scope: UninstallScope
): UninstallScope | undefined {
  if (scope === "harnesses") {
    return undefined;
  }
  return "settings";
}

function parseUninstallScope(value: string): UninstallScope {
  if (value === "settings" || value === "harnesses" || value === "all") {
    return value;
  }
  throw new Error("--scope must be settings, harnesses, or all.");
}

function parseTargetsArgs(args: string[]): { setDefaults?: string[] } {
  let setDefaults: string[] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--set-defaults") {
      setDefaults = splitCsv(requireFlagValue(args, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--set-defaults=")) {
      setDefaults = splitCsv(arg.slice("--set-defaults=".length), arg);
      continue;
    }
    throw new Error(`Unknown targets option: ${arg}`);
  }
  return { setDefaults };
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function splitCsv(value: string, flag = "value"): string[] {
  const values = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${flag} requires at least one value.`);
  }
  return values;
}

function hasHelpFlag(args: string[]): boolean {
  return (
    args[0] === "help" || args.some((arg) => arg === "--help" || arg === "-h")
  );
}

function assertNoArgs(args: string[], command: string): void {
  if (args.length === 0) {
    return;
  }
  throw new Error(`skills-kit ${command} does not accept: ${args.join(" ")}`);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function inspectWorkspaceState(root: string): Promise<WorkspaceState> {
  const paths = resolveWorkspacePaths(root);
  const [graph, preferences] = await Promise.all([
    inspectRepo(root),
    loadPreferences(paths),
  ]);
  return { paths, graph, preferences };
}

function createStatusSummary(graph: SkillsGraph): {
  skills: number;
  kits: number;
  grouped: number;
  ungrouped: number;
  needs_review: number;
} {
  const groupedSkillIds = new Set(graph.kits.flatMap((kit) => kit.skill_ids));
  const needsReview = graph.skills.filter(
    (skill) => !skill.last_reviewed_at
  ).length;

  return {
    skills: graph.skills.length,
    kits: graph.kits.length,
    grouped: groupedSkillIds.size,
    ungrouped: graph.skills.length - groupedSkillIds.size,
    needs_review: needsReview,
  };
}

async function createDiagnosticsReport(root: string): Promise<{
  root: string;
  status: ReturnType<typeof createStatusSummary>;
  validation: {
    skills: number;
    errors: number;
    warnings: number;
    issues: Array<{
      severity: string;
      skill_id?: string;
      message: string;
      detail?: string;
    }>;
  };
  environment: {
    source_inventory: {
      status: string;
      command: string;
      message: string;
      skill_count?: number;
    };
  };
  targets: Awaited<ReturnType<typeof createTargetsSummary>>;
  package_json: Awaited<ReturnType<typeof getPackageJsonIntegrationStatus>>;
  harnessHealth: Awaited<ReturnType<typeof inspectHarnessHealth>>;
  blocking: boolean;
}> {
  const state = await inspectWorkspaceState(root);
  const sourceInventory = await runSourceInventoryCheck(root);
  const diagnostics = createSkillScanDiagnostics({
    skills: state.graph.skills,
    sourceInventory,
  });
  const harnessHealth = await inspectHarnessHealth(state);
  const validation = {
    skills: diagnostics.skills.length,
    errors: diagnostics.issues.filter((issue) => issue.severity === "error")
      .length,
    warnings: diagnostics.issues.filter((issue) => issue.severity === "warning")
      .length,
    issues: diagnostics.issues.map((issue) => ({
      severity: issue.severity,
      skill_id: issue.skillId,
      message: issue.message,
      detail: issue.detail,
    })),
  };

  return {
    root,
    status: createStatusSummary(state.graph),
    validation,
    environment: {
      source_inventory: {
        status: sourceInventory.status,
        command: sourceInventory.command,
        message: sourceInventory.message,
        skill_count: sourceInventory.skillCount,
      },
    },
    targets: await createTargetsSummary(state),
    package_json: await getPackageJsonIntegrationStatus(
      root,
      state.preferences.package_json
    ),
    harnessHealth,
    blocking:
      hasBlockingSkillIssues(diagnostics) || harnessHealth.issues.length > 0,
  };
}

function formatDoctorReport(
  report: Awaited<ReturnType<typeof createDiagnosticsReport>>
): string {
  const lines = [
    "skills-kit doctor",
    "",
    "Repo",
    `Root: ${report.root}`,
    `Skills: ${report.status.skills}`,
    `Kits: ${report.status.kits}`,
    `Ungrouped: ${report.status.ungrouped}`,
    "",
    "Validation",
    `Skills:   ${report.validation.skills}`,
    `Errors:   ${report.validation.errors}`,
    `Warnings: ${report.validation.warnings}`,
  ];

  if (report.validation.issues.length > 0) {
    lines.push(
      "",
      "Issues",
      ...report.validation.issues.map((issue) => {
        const subject = issue.skill_id ? `${issue.skill_id}: ` : "";
        const detail = issue.detail ? ` (${issue.detail})` : "";
        return `- ${issue.severity}: ${subject}${issue.message}${detail}`;
      })
    );
  }

  lines.push(
    "",
    "Harnesses",
    ...formatTargetSummaryLines(report.targets.targets),
    "",
    "Package script",
    report.package_json.hasPackageJson
      ? `Script: ${report.package_json.hasScript ? report.package_json.runScriptCommand : "not configured"}`
      : "No package.json found.",
    "",
    "Environment",
    `Source inventory: ${report.environment.source_inventory.message}`,
    "",
    report.blocking ? "Result: needs attention" : "Result: clean"
  );

  return lines.join("\n");
}

function formatValidationReport(
  report: Awaited<ReturnType<typeof createDiagnosticsReport>>
): string {
  const lines = [
    "Validation",
    `Skills:   ${report.validation.skills}`,
    `Errors:   ${report.validation.errors}`,
    `Warnings: ${report.validation.warnings}`,
  ];

  if (report.validation.issues.length > 0) {
    lines.push(
      "",
      ...report.validation.issues.map((issue) => {
        const subject = issue.skill_id ? `${issue.skill_id}: ` : "";
        const detail = issue.detail ? ` (${issue.detail})` : "";
        return `- ${issue.severity}: ${subject}${issue.message}${detail}`;
      })
    );
  }

  return lines.join("\n");
}

async function createTargetsSummary(state: WorkspaceState): Promise<{
  default_targets: string[];
  targets: Array<{
    name: string;
    target_path: string;
    target_dir: string;
    is_default: boolean;
    exists: boolean;
    managed_links: number;
    active_kits: string[];
    active_skills: string[];
  }>;
}> {
  const defaultTargets = new Set(
    state.preferences.default_harnesses.map((target) => target.target_path)
  );
  const targets = await Promise.all(
    getConfiguredHarnessTargets(state).map(async (target) => {
      const targetDir = resolveHarnessTargetDir({
        root: state.paths.root,
        preferences: state.preferences,
        targetPath: target.target_path,
      });
      const manifest = await loadManagedManifest(state.paths.root, targetDir);
      return {
        name: target.name,
        target_path: target.target_path,
        target_dir: targetDir,
        is_default: defaultTargets.has(target.target_path),
        exists: await pathExists(targetDir),
        managed_links: manifest.managed_skill_ids.length,
        active_kits: manifest.active_kit_ids,
        active_skills: manifest.active_skill_ids,
      };
    })
  );

  return {
    default_targets: [...defaultTargets],
    targets,
  };
}

function formatTargetsSummary(
  summary: Awaited<ReturnType<typeof createTargetsSummary>>
): string {
  return ["Harnesses", ...formatTargetSummaryLines(summary.targets)].join("\n");
}

function formatTargetSummaryLines(
  targets: Awaited<ReturnType<typeof createTargetsSummary>>["targets"]
): string[] {
  if (targets.length === 0) {
    return ["- No harnesses configured."];
  }

  return targets.map((target) => {
    const flags = [
      target.is_default ? "default" : "",
      target.exists ? "exists" : "not created",
      target.managed_links > 0 ? `${target.managed_links} active` : "0 active",
    ].filter(Boolean);
    return `- ${labelForHarness(target)} ${target.target_path} (${flags.join(", ")})`;
  });
}

function parseValidateArgs(args: string[]): { strict: boolean } {
  let strict = false;
  for (const arg of args) {
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    throw new Error(`Unknown validate option: ${arg}`);
  }
  return { strict };
}

function parseKitMutationArgs(
  args: string[],
  command: "delete" | "rename"
): { dryRun: boolean; yes: boolean } {
  let dryRun = false;
  let yes = false;

  for (const arg of args) {
    if (arg === "--dry-run" || arg === "--plan") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    throw new Error(`Unknown kit ${command} option: ${arg}`);
  }

  return { dryRun, yes };
}

async function assertKitNotActive(
  state: WorkspaceState,
  kitId: string
): Promise<void> {
  for (const target of getConfiguredHarnessTargets(state)) {
    const activation = await getCurrentActivation(state, target.target_path);
    if (activation.activeKitIds.includes(kitId)) {
      throw new Error(
        `Kit ${kitId} is active in ${labelForHarness(target)} (${target.target_path}). Deactivate it before changing the kit record.`
      );
    }
  }

  for (const manifest of await readManifestActiveKitIds(state)) {
    if (!manifest.activeKitIds.includes(kitId)) {
      continue;
    }
    throw new Error(
      `Kit ${kitId} is active in ${manifest.targetPath}. Deactivate it before changing the kit record.`
    );
  }
}

async function readManifestActiveKitIds(
  state: WorkspaceState
): Promise<Array<{ targetPath: string; activeKitIds: string[] }>> {
  const entries = await readdir(state.paths.manifestsDir, {
    withFileTypes: true,
  }).catch(() => []);
  const manifests: Array<{ targetPath: string; activeKitIds: string[] }> = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) {
      continue;
    }
    const manifestPath = path.join(state.paths.manifestsDir, entry.name);
    const raw = await readFile(manifestPath, "utf8").catch(() => "");
    if (!raw.trim()) {
      continue;
    }
    const parsed = parse(raw) as {
      target_path?: unknown;
      active_kit_ids?: unknown;
    };
    manifests.push({
      targetPath:
        typeof parsed.target_path === "string"
          ? parsed.target_path
          : manifestPath,
      activeKitIds: Array.isArray(parsed.active_kit_ids)
        ? parsed.active_kit_ids.map(String)
        : [],
    });
  }

  return manifests;
}

function createKitSummary(kit: SkillKitRecord): {
  id: string;
  name: string;
  description: string;
  skill_count: number;
  skills: string[];
  tags: string[];
} {
  return {
    id: kit.id,
    name: kit.name,
    description: kit.description,
    skill_count: kit.skill_ids.length,
    skills: kit.skill_ids,
    tags: kit.tags,
  };
}

function formatKitList(graph: SkillsGraph): string {
  if (graph.kits.length === 0) {
    return "No kits saved.";
  }

  return [
    "Kits",
    ...graph.kits.map((kit) => {
      const description = kit.description ? ` - ${kit.description}` : "";
      return `- ${kit.name} (${kit.id}, ${kit.skill_ids.length} skills)${description}`;
    }),
  ].join("\n");
}

function formatKitDetails(kit: SkillKitRecord): string {
  const lines = [kit.name, `Id: ${kit.id}`, `Skills: ${kit.skill_ids.length}`];
  if (kit.description) {
    lines.push(`Description: ${kit.description}`);
  }
  if (kit.tags.length > 0) {
    lines.push(`Tags: ${kit.tags.join(", ")}`);
  }
  if (kit.skill_ids.length > 0) {
    lines.push("", "Skills", ...kit.skill_ids.map((skillId) => `- ${skillId}`));
  }
  return lines.join("\n");
}

function formatKitDeletePlan(kit: SkillKitRecord): string {
  return [
    `Delete kit ${kit.name}`,
    "",
    `Skills in kit: ${kit.skill_ids.length}`,
    "Source skills will not be changed.",
    "Run with --yes to delete the kit record.",
  ].join("\n");
}

function formatKitRenamePlan(kit: SkillKitRecord, nextName: string): string {
  return [
    "Rename kit",
    "",
    `Current: ${kit.name} (${kit.id})`,
    `Next:    ${nextName.trim()} (${slugifyId(nextName)})`,
    "Source skills will not be changed.",
  ].join("\n");
}

function createApplyPlanSummary(plan: SymlinkApplyPlan): {
  target_dir: string;
  selected: number;
  create: string[];
  remove: string[];
  keep: string[];
  conflicts: Array<{ skill_id: string; reason: string; target_path: string }>;
} {
  return {
    target_dir: plan.target_dir,
    selected: plan.selected_skill_ids.length,
    create: plan.create.map((action) => action.skill_id),
    remove: plan.remove.map((action) => action.skill_id),
    keep: plan.keep.map((action) => action.skill_id),
    conflicts: plan.conflicts.map((conflict) => ({
      skill_id: conflict.skill_id,
      reason: conflict.reason,
      target_path: conflict.target_path,
    })),
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  return stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

function labelForHarness(target: { name: string }): string {
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

function formatZshCompletion(): string {
  return [
    "#compdef skills-kit",
    "",
    "_skills_kit() {",
    "  local -a commands",
    "  commands=(",
    "    'init:open the guided switchboard'",
    "    'scan:rescan source skills and update the local map'",
    "    'status:print repo counts'",
    "    'list:list source skills'",
    "    'kit:create, list, show, rename, or delete kits'",
    "    'targets:list configured harnesses'",
    "    'validate:check source skills and metadata'",
    "    'doctor:run a full repo health check'",
    "    'update:replace the active skill set'",
    "    'apply:alias for update'",
    "    'add:add kits or skills to the active set'",
    "    'remove:remove kits or skills from the active set'",
    "    'deactivate:turn off managed active skills'",
    "    'restore-legacy:restore active targets from legacy kits'",
    "    'uninstall:remove skills-kit traces'",
    "    'completion:print shell completion'",
    "    'man:show the detailed manual'",
    "    'help:show help for a command'",
    "  )",
    "",
    "  _arguments -C \\",
    "    '(-h --help)'{-h,--help}'[show help]' \\",
    "    '--root[run as if started in another repo]:repo:_files -/' \\",
    "    '-C[run as if started in another repo]:repo:_files -/' \\",
    "    '--json[print machine-readable JSON when supported]' \\",
    "    '--no-startup-review[skip guided startup issue review]' \\",
    "    '--no-color[disable color]' \\",
    "    '--color[control color output]:mode:(auto always never)' \\",
    "    '1:command:->command' \\",
    "    '*::arg:->args'",
    "",
    "  case $state in",
    "    command)",
    "      _describe 'skills-kit command' commands",
    "      ;;",
    "    args)",
    "      case $words[2] in",
    "        kit)",
    "          _values 'kit action' create set list show rename delete",
    "          ;;",
    "        completion)",
    "          _values 'shell' zsh",
    "          ;;",
    "        update|apply|add|remove|deactivate)",
    "          _values 'option' --kits --skills --target --targets --all-harnesses --dry-run --plan --all-skills --all",
    "          ;;",
    "        restore-legacy)",
    "          _values 'option' --dry-run --plan --disconnect --unmanage",
    "          ;;",
    "        uninstall)",
    "          _values 'option' --dry-run --plan --scope --restore-legacy --revert-legacy --legacy",
    "          ;;",
    "        targets)",
    "          _values 'option' --set-defaults",
    "          ;;",
    "        *)",
    "          _files",
    "          ;;",
    "      esac",
    "      ;;",
    "  esac",
    "}",
    "",
    '_skills_kit "$@"',
  ].join("\n");
}

type HelpTopic =
  | "add"
  | "apply"
  | "completion"
  | "deactivate"
  | "doctor"
  | "init"
  | "kit"
  | "list"
  | "man"
  | "remove"
  | "restore-legacy"
  | "scan"
  | "status"
  | "targets"
  | "uninstall"
  | "validate"
  | "update";

const HELP_TOPICS = new Set<HelpTopic>([
  "add",
  "apply",
  "completion",
  "deactivate",
  "doctor",
  "init",
  "kit",
  "list",
  "man",
  "remove",
  "restore-legacy",
  "scan",
  "status",
  "targets",
  "uninstall",
  "validate",
  "update",
]);

function formatHelpTopic(topic: string | undefined): string {
  if (!topic) {
    return formatHelp();
  }
  if (HELP_TOPICS.has(topic as HelpTopic)) {
    return topic === "man"
      ? formatManual()
      : formatCommandHelp(topic as Exclude<HelpTopic, "man">);
  }
  return [
    `Unknown help topic: ${topic}`,
    "",
    "Run `skills-kit --help` to see available commands.",
  ].join("\n");
}

function formatCommandHelp(topic: Exclude<HelpTopic, "man">): string {
  const help: Record<Exclude<HelpTopic, "man">, string[]> = {
    add: [
      "skills-kit add",
      "Add kits or individual skills to the current active set.",
      "",
      "Usage:",
      "  skills-kit add --kits <kit[,kit]> [options]",
      "  skills-kit add --skills <skill[,skill]> [options]",
      "",
      "Options:",
      "  --kits <ids>             Kits to add.",
      "  --skills <ids>           Individual skills to add.",
      "  --target <path|name>     Apply to one harness.",
      "  --targets <items>        Apply to multiple harnesses.",
      "  --all-harnesses          Apply to every configured harness.",
      "  --dry-run, --plan        Show the plan and write nothing.",
      "  -h, --help               Show this help.",
      "",
      "Example:",
      "  skills-kit add --kits ui,testing --targets codex,claude",
    ],
    apply: [
      "skills-kit apply",
      "Alias for `skills-kit update`. It replaces the active set by default.",
      "",
      "Usage:",
      "  skills-kit apply --kits <kit[,kit]> [options]",
      "  skills-kit apply --all-skills [options]",
      "",
      "Options:",
      "  --mode update|add|remove Choose replace, add, or remove behavior.",
      "  --kits <ids>             Kits to apply.",
      "  --skills <ids>           Individual skills to apply.",
      "  --all-skills             Turn on every source skill explicitly.",
      "  --target <path|name>     Apply to one harness.",
      "  --targets <items>        Apply to multiple harnesses.",
      "  --all-harnesses          Apply to every configured harness.",
      "  --dry-run, --plan        Show the plan and write nothing.",
      "  -h, --help               Show this help.",
    ],
    completion: [
      "skills-kit completion",
      "Print a shell completion script.",
      "",
      "Usage:",
      "  skills-kit completion zsh",
      "",
      "Install:",
      "  skills-kit completion zsh > ~/.zsh/completions/_skills-kit",
      "",
      "Notes:",
      "  Completion is static and does not inspect the repo.",
      "  -h, --help               Show this help.",
    ],
    deactivate: [
      "skills-kit deactivate",
      "Turn off active skills that skills-kit manages.",
      "",
      "Usage:",
      "  skills-kit deactivate --all [options]",
      "  skills-kit deactivate --kits <kit[,kit]> [options]",
      "  skills-kit deactivate --skills <skill[,skill]> [options]",
      "",
      "Options:",
      "  --all                    Turn off every managed active skill.",
      "  --kits <ids>             Turn off skills supplied by these kits.",
      "  --skills <ids>           Turn off specific skills.",
      "  --target <path|name>     Apply to one harness.",
      "  --targets <items>        Apply to multiple harnesses.",
      "  --all-harnesses          Apply to every configured harness.",
      "  --dry-run, --plan        Show the plan and write nothing.",
      "  -h, --help               Show this help.",
      "",
      "Safety:",
      "  Only skills recorded by skills-kit are removed. Source skills stay put.",
    ],
    doctor: [
      "skills-kit doctor",
      "Run a read-only repo health check.",
      "",
      "Usage:",
      "  skills-kit doctor [--json]",
      "",
      "Checks:",
      "  - source skill validation",
      "  - source skill inventory",
      "  - configured harnesses",
      "  - package.json script status",
      "  - active harness drift",
      "  -h, --help               Show this help.",
    ],
    init: [
      "skills-kit init",
      "Open the guided switchboard explicitly.",
      "",
      "Usage:",
      "  skills-kit init",
      "",
      "What happens:",
      "  - Checks for source skills in the repo.",
      "  - Creates the local skills-kit map only after confirmation.",
      "  - Lets you choose harnesses and create the first kit.",
      "  -h, --help               Show this help.",
    ],
    kit: [
      "skills-kit kit",
      "List, inspect, create, rename, or delete kits.",
      "",
      "Usage:",
      "  skills-kit kit list",
      "  skills-kit kit show <name>",
      "  skills-kit kit create <name> <skill...> [options]",
      "  skills-kit kit set <name> <skill...> [options]",
      "  skills-kit kit rename <current-name> <new-name>",
      "  skills-kit kit delete <name> --yes",
      "",
      "Options:",
      "  --description <text>     Human-readable kit description.",
      "  --reason <text>          Why this kit exists.",
      "  --tag <tag>              Add one tag. Can be repeated.",
      "  --tags <a,b>             Add tags from a comma-separated list.",
      "  --dry-run, --plan        Preview rename/delete metadata changes.",
      "  --yes                    Confirm kit delete.",
      "  -h, --help               Show this help.",
      "",
      "Safety:",
      "  Rename and delete refuse to run while the kit is active in a harness.",
      "",
      "Example:",
      '  skills-kit kit create ui frontend-design webapp-testing --reason "Frontend UI work"',
    ],
    list: [
      "skills-kit list",
      "List source skills and show which kits include them.",
      "",
      "Usage:",
      "  skills-kit list",
      "  -h, --help               Show this help.",
    ],
    remove: [
      "skills-kit remove",
      "Remove kits or individual skills from the current active set.",
      "",
      "Usage:",
      "  skills-kit remove --kits <kit[,kit]> [options]",
      "  skills-kit remove --skills <skill[,skill]> [options]",
      "",
      "Options:",
      "  --kits <ids>             Kits to remove from the active set.",
      "  --skills <ids>           Individual skills to remove.",
      "  --target <path|name>     Apply to one harness.",
      "  --targets <items>        Apply to multiple harnesses.",
      "  --all-harnesses          Apply to every configured harness.",
      "  --dry-run, --plan        Show the plan and write nothing.",
      "  -h, --help               Show this help.",
    ],
    "restore-legacy": [
      "skills-kit restore-legacy",
      "Revert configured targets to the legacy kits imported during setup.",
      "",
      "Usage:",
      "  skills-kit restore-legacy [--dry-run]",
      "  skills-kit restore-legacy --disconnect",
      "",
      "Options:",
      "  --dry-run, --plan        Show the restore plan and write nothing.",
      "  --disconnect, --unmanage Restore links, then clear skills-kit manifests.",
      "  -h, --help               Show this help.",
      "",
      "Aliases:",
      "  skills-kit revert-legacy",
      "",
      "Safety:",
      "  Source skills stay untouched. Only target links managed by skills-kit change.",
    ],
    scan: [
      "skills-kit scan",
      "Rescan source skills and update the local skills-kit map.",
      "",
      "Usage:",
      "  skills-kit scan",
      "  -h, --help               Show this help.",
      "",
      "Safety:",
      "  The source skills folder is read, not rewritten.",
    ],
    status: [
      "skills-kit status",
      "Print repo skill counts without creating skills-kit files.",
      "",
      "Usage:",
      "  skills-kit status",
      "  skills-kit status --json",
      "  -h, --help               Show this help.",
    ],
    targets: [
      "skills-kit targets",
      "List configured harnesses and active managed links.",
      "",
      "Usage:",
      "  skills-kit targets [--json]",
      "  skills-kit targets --set-defaults <name[,name]>",
      "",
      "Options:",
      "  --set-defaults <items>  Set direct-command defaults.",
      "  -h, --help               Show this help.",
    ],
    uninstall: [
      "skills-kit uninstall",
      "Remove skills-kit traces from this repo.",
      "",
      "Usage:",
      "  skills-kit uninstall [--dry-run]",
      "",
      "Options:",
      "  --dry-run, --plan        Show what would be removed and write nothing.",
      "  --scope <scope>          settings, harnesses, or all.",
      "  --restore-legacy         Restore legacy kit links before uninstalling.",
      "  --revert-legacy, --legacy Aliases for --restore-legacy.",
      "  -h, --help               Show this help.",
      "",
      "Confirmation:",
      '  Type "delete" to confirm when there is anything to remove.',
      "",
      "Safety:",
      "  Source skills stay untouched. Uninstall removes only skills-kit map files,",
      "  package.json traces, and active skill links recorded by skills-kit.",
    ],
    validate: [
      "skills-kit validate",
      "Check source skills and metadata without writing files.",
      "",
      "Usage:",
      "  skills-kit validate [--strict] [--json]",
      "",
      "Options:",
      "  --strict                 Exit non-zero for warnings as well as errors.",
      "  -h, --help               Show this help.",
    ],
    update: [
      "skills-kit update",
      "Replace the active skill set for the selected/default harnesses.",
      "",
      "Usage:",
      "  skills-kit update --kits <kit[,kit]> [options]",
      "  skills-kit update --skills <skill[,skill]> [options]",
      "  skills-kit update --all-skills [options]",
      "",
      "Options:",
      "  --kits <ids>             Kits that should become active.",
      "  --skills <ids>           Individual skills that should become active.",
      "  --all-skills             Turn on every source skill explicitly.",
      "  --mode update|add|remove Override the command behavior.",
      "  --target <path|name>     Apply to one harness.",
      "  --targets <items>        Apply to multiple harnesses.",
      "  --all-harnesses          Apply to every configured harness.",
      "  --dry-run, --plan        Show the plan and write nothing.",
      "  -h, --help               Show this help.",
      "",
      "Example:",
      "  skills-kit update --dry-run --kits ui --targets codex,claude",
    ],
  };

  return help[topic].join("\n");
}

function formatHelp(): string {
  return [
    "skills-kit",
    "Repo-local skill switchboard for local agent skill libraries.",
    "",
    "Use the guided switchboard for normal work. Use direct commands for scripts,",
    "dry runs, docs, and repeatable operations.",
    "",
    "Usage:",
    "  skills-kit                         Open the guided switchboard",
    "  skills-kit <command> [options]     Run a direct command",
    "  skills-kit help <command>          Show command help",
    "  skills-kit man                     Show the full manual",
    "",
    "Commands:",
    "  init        Open setup explicitly",
    "  scan        Rescan source skills and update the local map",
    "  status      Print repo counts without creating skills-kit files",
    "  list        List skills and kit membership",
    "  kit         List, inspect, create, rename, or delete kits",
    "  targets     List configured harnesses",
    "  validate    Check source skills and metadata",
    "  doctor      Run a full read-only health check",
    "  update      Replace the active skill set",
    "  apply       Alias for update",
    "  add         Add kits or skills to the active set",
    "  remove      Remove kits or skills from the active set",
    "  deactivate  Turn off managed active skills",
    "  restore-legacy  Restore active targets from legacy kits",
    "  uninstall   Remove skills-kit traces from the repo",
    "  completion  Print shell completion",
    "  man         Show the detailed manual",
    "",
    "Common examples:",
    "  npx @skills-kit/cli",
    "  npx @skills-kit/cli doctor",
    "  npx @skills-kit/cli kit create ui frontend-design webapp-testing",
    "  npx @skills-kit/cli kit list --json",
    "  npx @skills-kit/cli update --dry-run --kits ui",
    "  npx @skills-kit/cli update --kits ui --targets codex,claude",
    "  npx @skills-kit/cli deactivate --all --dry-run",
    "  npx @skills-kit/cli restore-legacy --dry-run",
    "  npx @skills-kit/cli uninstall --restore-legacy --dry-run",
    "  npx @skills-kit/cli uninstall --dry-run",
    "",
    "Global options:",
    "  --root <path>, -C <path>  Run as if started in another repo",
    "  --json                   Print JSON for supported commands",
    "  --no-startup-review      Skip guided startup issue review",
    "  --no-color               Disable color output",
    "  --color auto|always|never",
    "  -h, --help               Show help",
    "  help <topic>             Show help for a command",
    "  man                      Show the full manual",
    "",
    "Core rule:",
    "  Source skills stay untouched. skills-kit changes only its local map and",
    "  the active harness views it owns, after showing a plan.",
  ].join("\n");
}

function formatManual(): string {
  return [
    "skills-kit manual",
    "A repo-local switchboard for choosing which skills are active for the work.",
    "",
    "What problem it solves",
    "  A repo can have many skills. That is useful, but giving every skill to every",
    "  agent session creates noise. skills-kit keeps the broad source library in",
    "  place, lets you group skills into named kits, and turns on only the focused",
    "  set needed for the current task.",
    "",
    "Mental model",
    "  Source skills",
    "    The skills already in the repo. skills-kit reads them and leaves them",
    "    untouched.",
    "",
    "  Kit",
    "    A named group of skills for a real kind of work, such as UI polish,",
    "    release review, docs, platform work, or agent tooling.",
    "",
    "  Active tool view",
    "    The focused set of skills visible to Codex, Claude, Gemini CLI, Cursor,",
    "    or another configured harness.",
    "",
    "  Plan",
    "    The preview shown before changes. It separates create, remove, keep, and",
    "    conflict counts so the user can review before writing.",
    "",
    "Normal workflow",
    "  1. Run `skills-kit` or `npx @skills-kit/cli` from the repo root.",
    "  2. Confirm setup if this repo has no skills-kit map yet.",
    "  3. Choose which targets this repo should support.",
    "  4. Create a kit with a clear name and description.",
    "  5. Select the skills that belong in that kit.",
    "  6. Review the planned active-tool change.",
    "  7. Apply it, or go back and adjust.",
    "",
    "Direct command workflow",
    "  skills-kit status",
    "    Show repo counts without creating skills-kit files.",
    "",
    "  skills-kit scan",
    "    Rescan source skills and update the local skills-kit map.",
    "",
    "  skills-kit validate",
    "    Check source skills and metadata without writing files. Use --strict",
    "    when warnings should fail automation.",
    "",
    "  skills-kit doctor",
    "    Run a broader read-only health check: validation, source inventory,",
    "    configured harnesses, package script status, and",
    "    active harness drift.",
    "",
    "  skills-kit targets",
    "    Show configured harnesses, defaults, and active managed link counts.",
    "",
    "  skills-kit kit list",
    "    List saved kits.",
    "",
    "  skills-kit kit show <name>",
    "    Show one kit, including its description, tags, and skill ids.",
    "",
    "  skills-kit kit create <name> <skill...>",
    "    Save a named kit. Add --description, --reason, or --tag to make the kit",
    "    easier for a team to understand later.",
    "",
    "  skills-kit kit rename <current-name> <new-name>",
    "    Rename a kit record. This refuses to run while the kit is active.",
    "",
    "  skills-kit kit delete <name> --yes",
    "    Delete a kit record. This refuses to run while the kit is active and",
    "    never deletes source skills.",
    "",
    "  skills-kit update --kits <kit>",
    "    Replace the active set with the selected kit or kits.",
    "",
    "  skills-kit add --kits <kit>",
    "    Keep the current active set and add more skills from the selected kits.",
    "",
    "  skills-kit remove --kits <kit>",
    "    Turn off skills supplied by selected kits while preserving other active",
    "    skills.",
    "",
    "  skills-kit deactivate --all",
    "    Turn off every active skill that skills-kit manages.",
    "",
    "  skills-kit uninstall",
    "    Remove skills-kit traces from the repo after typing the confirmation",
    '    phrase "delete".',
    "",
    "Important options",
    "  --dry-run, --plan",
    "    Show the exact plan and write nothing. Use this in scripts, reviews, and",
    "    any flow where you want a preview first.",
    "",
    "  --kits <a,b>",
    "    Select one or more kits by id.",
    "",
    "  --skills <a,b>",
    "    Select individual skills directly.",
    "",
    "  --all-skills",
    "    Explicitly turn on every source skill. This is intentionally loud because",
    "    it removes the focus benefit.",
    "",
    "  --target <path|name>",
    "    Apply to one configured harness or path.",
    "",
    "  --targets <a,b>",
    "    Apply to multiple configured harnesses or paths.",
    "",
    "  --all-harnesses",
    "    Backward-compatible flag for applying to every configured harness.",
    "",
    "  --root <path>, -C <path>",
    "    Run as if skills-kit had started from another repo. Useful for scripts,",
    "    tests, and editor integrations.",
    "",
    "  --json",
    "    Print machine-readable output for read-only commands and dry-run plans:",
    "    status, scan, list, kit list/show/create/delete/rename, targets,",
    "    validate, doctor, update/add/remove/deactivate --dry-run, and",
    "    uninstall --dry-run.",
    "",
    "  --no-color, --color auto|always|never",
    "    Control color output for terminals and logs.",
    "",
    "  completion zsh",
    "    Print static zsh completion. It does not inspect the repo, so it is safe",
    "    to run from any folder.",
    "",
    "Safety model",
    "  - Source skills are never moved, renamed, deleted, or rewritten.",
    "  - skills-kit writes its own local repo map beside the source skills.",
    "  - Active tool views are changed only after a plan is available.",
    "  - Existing real files and folders are treated as conflicts.",
    "  - Unexpected links are treated as conflicts.",
    "  - Deactivate and uninstall remove only active skill links recorded by",
    "    skills-kit.",
    "  - package.json is changed only when the user chooses the script.",
    "",
    "Uninstall behavior",
    "  `skills-kit uninstall --dry-run` previews cleanup. `skills-kit uninstall`",
    '  asks the user to type "delete" when there is anything to remove. Cleanup',
    "  removes skills-kit map files, package.json script traces, and active skill",
    "  links owned by skills-kit. Source skills stay untouched.",
    "",
    "Help commands",
    "  skills-kit --help",
    "  skills-kit -h",
    "  skills-kit help update",
    "  skills-kit update --help",
    "  skills-kit man",
  ].join("\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`skills-kit: ${message}`);
  process.exitCode = 1;
});
