import { rm } from "node:fs/promises";
import path from "node:path";
import { styleText } from "node:util";
import {
  ConfirmPrompt,
  GroupMultiSelectPrompt,
  MultiSelectPrompt,
  Prompt,
  SelectPrompt,
  settings,
  TextPrompt,
} from "@clack/core";
import {
  isCancel,
  limitOptions,
  log,
  note,
  outro,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  spinner,
  symbol,
} from "@clack/prompts";

import {
  formatMenuTitle,
  formatSplash,
  formatWorkspaceSnapshot,
} from "./ui/branding";
import {
  applySelection,
  createOrUpdateKit,
  deactivateSelection,
  deleteKit,
  forgetActivationState,
  getCurrentActivation,
  planDeactivation,
  planSelection,
  renameKit,
  scanRepo,
} from "./core/commands";
import {
  createSkillScanDiagnostics,
  hasBlockingSkillIssues,
  runSourceInventoryCheck,
  type SkillScanDiagnostics,
} from "./services/validation/diagnostics";
import { resolveSkillIdsFromKits } from "./core/graph";
import {
  canReapplyHarnessIssue,
  formatHarnessHealthReport,
  type HarnessHealthIssue,
  hasActiveHarnessIssue,
  hasInvalidConfiguredTargetIssue,
  inspectHarnessHealth,
} from "./services/harnesses/health";
import {
  countLegacyReviewItems,
  formatLegacyImportPreview,
  formatLegacyImportResult,
  formatLegacyImportWarningSummary,
  importLegacyHarnessEntries,
  inspectLegacyHarnessEntries,
  type LegacyHarnessInspection,
} from "./services/harnesses/legacy-import";
import {
  formatLegacyRestorePlan,
  formatLegacyRestoreResult,
  hasLegacyRestoreChanges,
  planLegacyRestore,
  restoreLegacySetup,
} from "./services/harnesses/legacy-restore";
import {
  buildManagedKitsMenuOptions,
  buildMainMenuOptions,
  buildUtilityMenuOptions,
  type ManagedKitsAction,
  type MenuAction,
  type UtilityAction,
} from "./ui/navigation";
import {
  applyPackageJsonIntegration,
  removePackageJsonIntegration,
  formatPackageScriptCommand,
  getPackageJsonIntegrationStatus,
  type PackageJsonIntegrationStatus,
  type PackageManagerName,
  SKILLS_KIT_PACKAGE_NAME,
} from "./services/package-json/package-json";
import {
  DEFAULT_PACKAGE_DEPENDENCY_SPEC,
  DEFAULT_PACKAGE_SCRIPT_COMMAND,
  DEFAULT_PACKAGE_SCRIPT_NAME,
  defaultTargetPathForHarness,
  detectExistingHarnessTargets,
  savePreferences,
} from "./config/preferences";
import type {
  HarnessName,
  HarnessTargetRecord,
  PackageJsonPreferences,
  SkillKitRecord,
  SkillRecord,
  SkillsGraph,
  SymlinkApplyPlan,
} from "./types";
import {
  formatUninstallPlan,
  formatUninstallResult,
  planUninstall,
  uninstallSkillsKit,
  type UninstallPlan,
  type UninstallScope,
} from "./services/lifecycle/uninstall";
import {
  assertSourceSkillsReady,
  isWorkspaceInitialized,
  type WorkspaceState,
} from "./core/workspace";

type KitEditorMode = "choose" | "new";
type PlanReviewAction = "apply" | "diff" | "back";
type HarnessRecoveryAction = "reapply" | "preferences" | "forget" | "continue";
type PackageJsonAction =
  | "add"
  | "customize"
  | "remove"
  | "ask"
  | "dismiss"
  | "back";
type PackageJsonStartupAction = "add" | "customize" | "skip" | "dismiss";
type PackageScriptChoice = "skills" | "skills:kit" | "skills-kit" | "custom";
type StartupIssueAction =
  | "review"
  | "normalize-targets"
  | "validate"
  | "dismiss"
  | "continue";
type ManageHarnessesAction = "edit" | "back";
type KitCreatedAction = "activate" | "new" | "manage" | "main";
type KitEditAction = "info" | "skills" | "delete" | "back";
type KitTargetSelectionState = "on" | "off" | "keep";
type TuiUninstallScope = "settings" | "harnesses" | "all" | "back";
type TuiUninstallAction = TuiUninstallScope | "restore-legacy-and-uninstall";
type NavigationOutcome = "back" | "saved";

interface TuiScanResult {
  state: WorkspaceState;
  diagnostics: SkillScanDiagnostics;
}

interface TuiRunOptions {
  startupReview?: boolean;
}

interface SessionBaseline {
  initializedAtStart: boolean;
  state: WorkspaceState;
  activationSummary: Awaited<ReturnType<typeof getNavigationActivationSummary>>;
  packageStatus?: PackageJsonIntegrationStatus;
}

interface TuiHarnessActivation {
  target: HarnessTargetRecord;
  managedSkillIds: string[];
  activeKitIds: string[];
  activeSkillIds: string[];
}

interface NavigationResult<T> {
  outcome: NavigationOutcome;
  value: T;
}

interface SkillPromptOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const HARNESS_OPTIONS: Array<{
  value: HarnessName;
  label: string;
  detail: string;
}> = [
  { value: "codex", label: "Codex", detail: "./.codex/skills" },
  { value: "claude", label: "Claude", detail: "./.claude/skills" },
  { value: "gemini", label: "Gemini CLI", detail: "./.gemini/skills" },
  { value: "cursor", label: "Cursor", detail: "./.cursor/skills" },
  { value: "custom", label: "Custom", detail: "choose another folder" },
];
const SKILLS_KIT_PACKAGE_LABEL = SKILLS_KIT_PACKAGE_NAME;
const PACKAGE_SCRIPT_PRESETS = new Set<PackageScriptChoice>([
  "skills",
  "skills:kit",
  "skills-kit",
]);
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type PromptKeyHelp =
  | "default-harness-multiselect"
  | "harness-multiselect"
  | "root-back-select"
  | "root-select"
  | "select"
  | "multiselect"
  | "search-multiselect"
  | "confirm"
  | "confirm-back"
  | "text";

const PROMPT_KEY_HELP: Record<PromptKeyHelp, string> = {
  "default-harness-multiselect":
    "↑/↓ navigate · Space select · Enter confirm · Esc back",
  "harness-multiselect":
    "↑/↓ navigate · Space select · Enter confirm · Esc back",
  "root-back-select": "↑/↓ navigate · Enter select · Esc back",
  "root-select": "↑/↓ navigate · Enter select · Esc quit",
  select: "↑/↓ navigate · Enter select · Esc back",
  multiselect: "↑/↓ navigate · Space select · Enter confirm · Esc back",
  "search-multiselect": "Type filter · Space select · Enter confirm · Esc back",
  confirm: "←/→ choose · Enter confirm · Esc back",
  "confirm-back": "←/→ choose · Enter confirm · Esc back",
  text: "",
};
const KEY_HELP_MARKER = "\u001fkey-help:";

function withKeyHelp(message: string, help: PromptKeyHelp): string {
  const keyHelp = PROMPT_KEY_HELP[help];
  return keyHelp ? `${message}\n${KEY_HELP_MARKER}${keyHelp}` : message;
}

async function checkSourceSkillsReady(root: string): Promise<void> {
  await withSpinner(
    "Checking ./.agents/skills",
    () => assertSourceSkillsReady(root),
    "Source skills found"
  );
}

async function scanRepoWithFeedback(
  root: string,
  title: string
): Promise<TuiScanResult> {
  const scan = spinner();
  scan.start(title);

  try {
    scan.message("Reading source skill inventory");
    const sourceInventory = await runSourceInventoryCheck(root);
    scan.message("Reading ./.agents/skills");
    const state = await scanRepo(root);
    scan.message("Validating SKILL.md records");
    const diagnostics = createSkillScanDiagnostics({
      skills: state.graph.skills,
      sourceInventory,
    });
    const errorCount = diagnostics.issues.filter(
      (issue) => issue.severity === "error"
    ).length;
    const warningCount = diagnostics.issues.filter(
      (issue) => issue.severity === "warning"
    ).length;

    scan.stop(
      errorCount > 0 || warningCount > 0
        ? `Scanned ${state.graph.skills.length} skills with ${errorCount} errors and ${warningCount} warnings`
        : `Scanned and validated ${state.graph.skills.length} skills`
    );

    return { state, diagnostics };
  } catch (error) {
    scan.error("Scan failed");
    throw error;
  }
}

async function withSpinner<T>(
  startMessage: string,
  run: () => Promise<T>,
  successMessage: string
): Promise<T> {
  const indicator = spinner();
  indicator.start(startMessage);
  try {
    const result = await run();
    indicator.stop(successMessage);
    return result;
  } catch (error) {
    indicator.error(startMessage);
    throw error;
  }
}

function hasStartupIssues(diagnostics: SkillScanDiagnostics): boolean {
  return diagnostics.issues.length > 0;
}

function formatStartupValidationSummary(
  diagnostics: SkillScanDiagnostics
): string {
  const errorCount = diagnostics.issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  const warningCount = diagnostics.issues.filter(
    (issue) => issue.severity === "warning"
  ).length;

  return formatSummaryField(
    "Validation",
    `${formatCount(diagnostics.skills.length, "skill")}, ${formatCount(errorCount, "error")}, ${formatCount(warningCount, "warning")}`,
    10,
    errorCount > 0 ? "red" : warningCount > 0 ? "yellow" : "green"
  );
}

async function runStartupIssueReview(
  state: WorkspaceState,
  diagnostics: SkillScanDiagnostics,
  options: { force?: boolean } = {}
): Promise<TuiScanResult> {
  let currentState = state;
  let currentDiagnostics = diagnostics;

  while (true) {
    const legacyInspection = await inspectLegacyHarnessEntries(currentState, {
      includeManagedTargets: true,
    });
    const legacyIssueCount = countLegacyReviewItems(legacyInspection);
    if (
      !options.force &&
      !hasStartupIssues(currentDiagnostics) &&
      legacyIssueCount === 0
    ) {
      break;
    }

    const action = await select<StartupIssueAction>({
      message: withKeyHelp("Startup issues found", "select"),
      options: [
        {
          value: "review",
          label: "Review issues",
          hint: formatIssueCountHint(currentDiagnostics, legacyInspection),
        },
        ...(legacyIssueCount > 0
          ? [
              {
                value: "normalize-targets" as const,
                label: "Normalize existing target skills",
                hint: `${formatCount(legacyIssueCount, "target issue")}`,
              },
            ]
          : []),
        {
          value: "validate",
          label: "Validate again",
        },
        {
          value: "dismiss",
          label: "Do not show skill issues on startup again",
          hint: "You can still use Validate skills or --no-startup-review",
        },
        {
          value: "continue",
          label: "Continue",
        },
      ],
    });

    if (isCancel(action) || action === "continue") {
      return { state: currentState, diagnostics: currentDiagnostics };
    }

    if (action === "dismiss") {
      currentState = await saveStartupReviewPreference(currentState, {
        offer: "dismissed",
      });
      note(
        "Startup issue review will stay hidden for this repo. Use Validate skills from More options when you want to review skill issues.",
        "Startup review hidden",
        { format: identityFormat }
      );
      return { state: currentState, diagnostics: currentDiagnostics };
    }

    if (action === "review") {
      showScanDiagnostics(currentDiagnostics, "Skill issues");
      if (legacyIssueCount > 0) {
        note(
          formatLegacyImportWarningSummary(legacyInspection),
          "Target issues",
          {
            format: identityFormat,
          }
        );
      }
      if (!options.force) {
        continue;
      }
    }

    if (action === "normalize-targets") {
      currentState = await runLegacyHarnessImport(currentState, {
        includeManagedTargets: true,
        forceReview: true,
      });
      options.force = false;
      continue;
    }

    if (action === "validate") {
      const result = await scanRepoWithFeedback(
        currentState.paths.root,
        "Validating skills"
      );
      currentState = result.state;
      currentDiagnostics = result.diagnostics;
      if (!hasStartupIssues(currentDiagnostics)) {
        log.success("Validation clean.");
        return { state: currentState, diagnostics: currentDiagnostics };
      }
    }

    if (options.force && action === "review") {
      options.force = false;
    }
  }

  return { state: currentState, diagnostics: currentDiagnostics };
}

async function saveStartupReviewPreference(
  state: WorkspaceState,
  startupReview: WorkspaceState["preferences"]["startup_review"]
): Promise<WorkspaceState> {
  const preferences = {
    ...state.preferences,
    startup_review: startupReview,
  };
  await withSpinner(
    "Saving startup review preference",
    () => savePreferences(state.paths, preferences),
    "Startup review preference saved"
  );
  return { ...state, preferences };
}

function formatIssueCountHint(
  diagnostics: SkillScanDiagnostics,
  legacyInspection?: LegacyHarnessInspection
): string {
  const errorCount = diagnostics.issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  const warningCount = diagnostics.issues.filter(
    (issue) => issue.severity === "warning"
  ).length;
  const legacyCount = legacyInspection
    ? countLegacyReviewItems(legacyInspection)
    : 0;
  return [
    formatCount(errorCount, "error"),
    formatCount(warningCount, "warning"),
    legacyCount > 0 ? formatCount(legacyCount, "target issue") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function showScanDiagnostics(
  diagnostics: SkillScanDiagnostics,
  title: string
): void {
  if (hasBlockingSkillIssues(diagnostics)) {
    note(formatTuiSkillScanDiagnostics(diagnostics), title, {
      format: identityFormat,
    });
    log.warn("Fix skill errors before relying on this harness view.");
    return;
  }

  if (
    diagnostics.issues.length > 0 ||
    diagnostics.sourceInventory.status !== "ok"
  ) {
    note(formatTuiSkillScanDiagnostics(diagnostics), title, {
      format: identityFormat,
    });
    return;
  }

  log.success(
    `Validated ${formatCount(diagnostics.skills.length, "skill")}. No skill issues found.`
  );
}

function formatStartupDiagnostics(diagnostics: SkillScanDiagnostics): string {
  const errorCount = diagnostics.issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  const warningCount = diagnostics.issues.filter(
    (issue) => issue.severity === "warning"
  ).length;

  if (errorCount === 0 && warningCount === 0) {
    return formatTuiSkillScanDiagnostics(diagnostics, {
      cleanLabel: "Validation clean",
      sourceInventoryLabel: "Source inventory",
    });
  }

  return formatTuiSkillScanDiagnostics(diagnostics);
}

function formatTuiSkillScanDiagnostics(
  diagnostics: SkillScanDiagnostics,
  options: {
    cleanLabel?: string;
    sourceInventoryLabel?: string;
    maxIssues?: number;
  } = {}
): string {
  const errorCount = diagnostics.issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  const warningCount = diagnostics.issues.filter(
    (issue) => issue.severity === "warning"
  ).length;
  const lines = [
    formatSummaryField(
      options.sourceInventoryLabel ?? "Source inventory",
      diagnostics.sourceInventory.message,
      19
    ),
    formatSummaryField(
      options.cleanLabel ?? "Validation",
      `${formatCount(diagnostics.skills.length, "skill")}, ${formatCount(errorCount, "error")}, ${formatCount(warningCount, "warning")}`,
      19
    ),
  ];

  if (diagnostics.issues.length > 0) {
    const maxIssues = options.maxIssues ?? 6;
    lines.push(
      "",
      ...diagnostics.issues.slice(0, maxIssues).map(formatTuiScanIssue)
    );

    if (diagnostics.issues.length > maxIssues) {
      lines.push(`... ${diagnostics.issues.length - maxIssues} more issues`);
    }
  }

  return lines.join("\n");
}

function formatTuiScanIssue(
  issue: SkillScanDiagnostics["issues"][number]
): string {
  const marker = issue.severity === "error" ? "error" : "warn";
  const subject = issue.skillId ? `${issue.skillId}: ` : "";
  const detail = issue.detail ? ` (${issue.detail})` : "";
  return `${marker}: ${subject}${issue.message}${detail}`;
}

function formatInitializedSummary(
  graph: SkillsGraph,
  diagnostics: SkillScanDiagnostics
): string {
  const groupedSkillIds = new Set(graph.kits.flatMap((kit) => kit.skill_ids));
  const needsReviewCount = graph.skills.filter(
    (skill) => !skill.last_reviewed_at
  ).length;
  const errorCount = diagnostics.issues.filter(
    (issue) => issue.severity === "error"
  ).length;
  const warningCount = diagnostics.issues.filter(
    (issue) => issue.severity === "warning"
  ).length;
  const environmentNotices = formatInitializedEnvironmentNotices(diagnostics);
  const lines = [
    paintDiff("blue", "Inventory"),
    formatSummaryField("Skills", graph.skills.length, 14),
    formatSummaryField("Kits", graph.kits.length, 14),
    formatSummaryField("Grouped", groupedSkillIds.size, 14),
    formatSummaryField(
      "Ungrouped",
      graph.skills.length - groupedSkillIds.size,
      14
    ),
    formatSummaryField("Needs review", needsReviewCount, 14),
    "",
    paintDiff("blue", "Rules"),
    "- Source library: ./.agents/skills",
    "- Metadata: ./.agents/skills-kit",
    "- Harness targets change only after preview",
    "",
    paintDiff("blue", "Validation"),
    formatSummaryField("Skills", diagnostics.skills.length, 10),
    formatValidationCount("Errors", errorCount, "red"),
    formatValidationCount("Warnings", warningCount, "yellow"),
  ];

  if (environmentNotices.length > 0) {
    lines.push(
      "",
      paintDiff("yellow", "Environment notices"),
      ...environmentNotices.map((notice) => paintDiff("yellow", notice))
    );
  }

  return lines.join("\n");
}

function formatValidationCount(
  label: string,
  count: number,
  tone: "red" | "yellow"
): string {
  return formatSummaryField(label, count, 10, count > 0 ? tone : undefined);
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatSummaryField(
  label: string,
  value: string | number,
  labelWidth = 12,
  tone?: "blue" | "default" | "green" | "muted" | "orange" | "red" | "yellow"
): string {
  return `${padVisible(formatSummaryLabel(label, tone), labelWidth)} ${value}`;
}

function formatSummaryLabel(
  label: string,
  tone?: "blue" | "default" | "green" | "muted" | "orange" | "red" | "yellow"
): string {
  const value =
    process.stdout.isTTY && !process.env.NO_COLOR
      ? styleText(["bold", "underline"], `${label}:`)
      : `${label}:`;
  return tone ? paintDiff(tone, value) : value;
}

function padVisible(value: string, width: number): string {
  const visibleLength = value.replace(ANSI_PATTERN, "").length;
  return `${value}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function formatInitializedEnvironmentNotices(
  diagnostics: SkillScanDiagnostics
): string[] {
  const notices: string[] = [];

  if (diagnostics.sourceInventory.status === "warning") {
    notices.push(`- ${diagnostics.sourceInventory.message}`);
  }

  return notices;
}

function formatTuiRepoStatus(graph: SkillsGraph): string {
  const groupedSkillIds = new Set(graph.kits.flatMap((kit) => kit.skill_ids));
  const staleReviewCount = graph.skills.filter(
    (skill) => !skill.last_reviewed_at
  ).length;

  return [
    formatSummaryField("Skills", graph.skills.length, 14),
    formatSummaryField("Kits", graph.kits.length, 14),
    formatSummaryField("Grouped", groupedSkillIds.size, 14),
    formatSummaryField(
      "Ungrouped",
      graph.skills.length - groupedSkillIds.size,
      14
    ),
    formatSummaryField("Needs review", staleReviewCount, 14),
  ].join("\n");
}

function formatTuiHealthCheck(
  state: WorkspaceState,
  diagnostics: SkillScanDiagnostics,
  harnessReport: Awaited<ReturnType<typeof inspectHarnessHealth>>,
  packageStatus?: PackageJsonIntegrationStatus
): string {
  const lines = [
    paintDiff("blue", "Repo"),
    formatSummaryField("Skills", state.graph.skills.length, 16),
    formatSummaryField("Kits", state.graph.kits.length, 16),
    "",
    paintDiff("blue", "Validation"),
    formatTuiSkillScanDiagnostics(diagnostics),
    "",
    paintDiff("blue", "Harnesses"),
    ...formatToolTargetLines(state),
    "",
    paintDiff("blue", "Package script"),
    packageStatus
      ? formatSummaryField(
          "Status",
          packageStatus.hasDependency && packageStatus.hasScript
            ? packageStatus.runScriptCommand
            : "not configured",
          16
        )
      : formatSummaryField("Status", "could not inspect package.json", 16),
  ];

  if (harnessReport.issues.length > 0) {
    lines.push(
      "",
      paintDiff("yellow", "Harness issues"),
      formatHarnessHealthReport(harnessReport)
    );
  }

  lines.push(
    "",
    harnessReport.issues.length === 0 && !hasBlockingSkillIssues(diagnostics)
      ? paintDiff("green", "Result: clean")
      : paintDiff("yellow", "Result: needs review")
  );

  return lines.join("\n");
}

function formatToolTargetsStatus(
  state: WorkspaceState,
  activations: TuiHarnessActivation[]
): string {
  return [
    paintDiff("blue", "Configured harnesses"),
    ...formatToolTargetLines(state, activations),
  ].join("\n");
}

function formatToolTargetLines(
  state: WorkspaceState,
  activations?: TuiHarnessActivation[]
): string[] {
  const defaults = new Set(
    getDefaultHarnessTargets(state).map((target) => target.target_path)
  );
  const activeByPath = new Map(
    (activations ?? []).map((activation) => [
      activation.target.target_path,
      activation,
    ])
  );

  return getHarnessTargets(state).map((target) => {
    const activation = activeByPath.get(target.target_path);
    const parts = [
      labelForHarness(target),
      target.target_path,
      defaults.has(target.target_path) ? "default" : "supported",
      formatCount(activation?.managedSkillIds.length ?? 0, "active skill"),
    ];
    return `- ${parts.join(" - ")}`;
  });
}

function hasUninstallChanges(plan: UninstallPlan): boolean {
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

function buildHarnessSupportOptions(
  detectedHarnessNames: HarnessName[]
): Record<string, Array<{ value: HarnessName; label: string }>> {
  const detected = new Set(detectedHarnessNames);
  const groups: Record<
    string,
    Array<{ value: HarnessName; label: string }>
  > = {};
  const detectedOptions = HARNESS_OPTIONS.filter((option) =>
    detected.has(option.value)
  ).map(formatHarnessSupportOption);
  const availableOptions = HARNESS_OPTIONS.filter(
    (option) => !detected.has(option.value)
  ).map(formatHarnessSupportOption);

  if (detectedOptions.length > 0) {
    groups.Detected = detectedOptions;
  }
  if (availableOptions.length > 0) {
    groups.Available = availableOptions;
  }

  return groups;
}

function formatHarnessSupportOption(option: {
  value: HarnessName;
  label: string;
  detail: string;
}): { value: HarnessName; label: string } {
  return {
    value: option.value,
    label: option.label,
  };
}

function formatHarnessTargetOptionLabel(target: HarnessTargetRecord): string {
  return `${labelForHarness(target).padEnd(11)}${target.target_path}`;
}

function harnessGroupMultiselect(input: {
  message: string;
  options: Record<string, Array<{ value: HarnessName; label: string }>>;
  initialValues: HarnessName[];
  required?: boolean;
  selectableGroups?: boolean;
  groupSpacing?: number;
}): Promise<HarnessName[] | symbol | undefined> {
  const labelByValue = new Map(
    Object.values(input.options)
      .flat()
      .map((option) => [option.value, option.label])
  );
  const prompt = new GroupMultiSelectPrompt<{
    value: HarnessName;
    label: string;
  }>({
    options: input.options,
    initialValues: input.initialValues,
    required: input.required,
    selectableGroups: input.selectableGroups,
    validate(value) {
      if (input.required && (!value || value.length === 0)) {
        return "Select at least one harness.";
      }
      return undefined;
    },
    render() {
      const withGuide = settings.withGuide;
      const guideTone = this.state === "error" ? "yellow" : "cyan";
      const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
      const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
      const header = formatPromptHeader(this.state, input.message, guide);

      if (this.state === "submit") {
        return `${header}\n${guide}${formatSubmittedChoiceSummary(
          this.value ?? [],
          labelByValue
        )}`;
      }

      if (this.state === "cancel") {
        return `${header}\n${guide}${formatBackSummary()}`;
      }

      const lines = [header];
      if (this.state === "error") {
        lines.push(`${guide}${styleText("yellow", this.error)}`);
      }

      let previousGroup: string | boolean | undefined;
      this.options.forEach((option, index) => {
        if (
          input.groupSpacing &&
          index > 0 &&
          option.group !== previousGroup &&
          option.group !== true
        ) {
          lines.push(guide);
        }
        previousGroup = option.group;

        if (option.group === true) {
          lines.push(guide);
          lines.push(
            `${guide}  ${styleText(["bold", "underline"], String(option.label))}`
          );
          return;
        }

        const selected = (this.value ?? []).includes(option.value);
        const checkbox = selected
          ? styleText("green", S_CHECKBOX_SELECTED)
          : S_CHECKBOX_INACTIVE;
        const prefix = formatCursorMarker(index === this.cursor);
        lines.push(`${guide}${prefix}${checkbox} ${option.label}`);
      });
      lines.push(...formatPromptFooter(input.message, guide), endGuide);
      return lines.join("\n");
    },
  });

  attachCtrlCExit(prompt);
  return prompt.prompt();
}

function harnessTargetMultiselect(input: {
  message: string;
  options: Array<{ value: string; label: string }>;
  initialValues: string[];
  required?: boolean;
}): Promise<string[] | symbol | undefined> {
  const labelByValue = new Map(
    input.options.map((option) => [option.value, option.label])
  );
  const prompt = new MultiSelectPrompt<{ value: string; label: string }>({
    options: input.options,
    initialValues: input.initialValues,
    required: input.required,
    validate(value) {
      if (input.required && (!value || value.length === 0)) {
        return "Select at least one default harness.";
      }
      return undefined;
    },
    render() {
      const withGuide = settings.withGuide;
      const guideTone = this.state === "error" ? "yellow" : "cyan";
      const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
      const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
      const header = formatPromptHeader(this.state, input.message, guide);

      if (this.state === "submit") {
        return `${header}\n${guide}${formatSubmittedChoiceSummary(
          this.value ?? [],
          labelByValue
        )}`;
      }

      if (this.state === "cancel") {
        return `${header}\n${guide}${formatBackSummary()}`;
      }

      const lines = [header];
      if (this.state === "error") {
        lines.push(`${guide}${styleText("yellow", this.error)}`);
      }

      for (const [index, option] of this.options.entries()) {
        const selected = (this.value ?? []).includes(option.value);
        const checkbox = selected
          ? styleText("green", S_CHECKBOX_SELECTED)
          : S_CHECKBOX_INACTIVE;
        const prefix = formatCursorMarker(index === this.cursor);
        lines.push(`${guide}${prefix}${checkbox} ${option.label}`);
      }
      lines.push(...formatPromptFooter(input.message, guide), endGuide);
      return lines.join("\n");
    },
  });

  attachCtrlCExit(prompt);
  return prompt.prompt();
}

function formatCursorMarker(active: boolean): string {
  return active ? `${styleText("cyan", "›")} ` : "  ";
}

function formatSubmittedChoiceSummary<T>(
  values: T[],
  labelByValue: Map<T, string>
): string {
  const labels = values
    .map((value) => labelByValue.get(value))
    .filter((label): label is string => Boolean(label));
  if (labels.length === 0) {
    return formatBackSummary("No selection");
  }
  return labels.map(formatSelectedSummary).join(", ");
}

function formatSelectedSummary(value: string): string {
  return paintDiff("green", value);
}

function formatBackSummary(value = "Back"): string {
  return paintDiff("yellow", value);
}

function shouldSuppressSubmittedSummary(label: string): boolean {
  return [
    "Back",
    "Continue",
    "Quit",
    "Exit",
    "Cancel",
    "Skip for now",
    "Not now",
    "No changes made",
    "Keep going for now",
  ].includes(label);
}

function confirm(input: {
  message: string;
  active: string;
  inactive: string;
  initialValue?: boolean;
  cancelLabel?: string;
}): Promise<boolean | symbol> {
  const prompt = new ConfirmPrompt({
    active: input.active,
    inactive: input.inactive,
    initialValue: input.initialValue,
    render() {
      const withGuide = settings.withGuide;
      const guideTone = this.state === "error" ? "yellow" : "cyan";
      const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
      const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
      const header = formatPromptHeader(this.state, input.message, guide);
      const selectedLabel = this.value ? input.active : input.inactive;

      if (this.state === "submit") {
        if (shouldSuppressSubmittedSummary(selectedLabel)) {
          return header;
        }
        return `${header}\n${guide}${formatSelectedSummary(selectedLabel)}`;
      }

      if (this.state === "cancel") {
        return `${header}\n${guide}${formatBackSummary(input.cancelLabel)}`;
      }

      const activeRadio = this.value
        ? styleText("green", S_RADIO_ACTIVE)
        : S_RADIO_INACTIVE;
      const inactiveRadio = this.value
        ? S_RADIO_INACTIVE
        : styleText("green", S_RADIO_ACTIVE);
      const activeLabel = this.value
        ? input.active
        : styleText("gray", input.active);
      const inactiveLabel = this.value
        ? styleText("gray", input.inactive)
        : input.inactive;

      return [
        header,
        `${guide}${activeRadio} ${activeLabel} / ${inactiveRadio} ${inactiveLabel}`,
        ...formatPromptFooter(input.message, guide),
        endGuide,
      ].join("\n");
    },
  });

  attachCtrlCExit(prompt);
  return prompt.prompt() as Promise<boolean | symbol>;
}

function select<T>(input: {
  message: string;
  options: Array<{
    value: T;
    label: string;
    hint?: string;
    disabled?: boolean;
  }>;
  initialValue?: T;
  cancelLabel?: string;
}): Promise<T | symbol> {
  const labelByValue = new Map(
    input.options.map((option) => [option.value, option.label])
  );
  const prompt = new SelectPrompt<{
    value: T;
    label: string;
    hint?: string;
    disabled?: boolean;
  }>({
    options: input.options,
    initialValue: input.initialValue,
    render() {
      const withGuide = settings.withGuide;
      const guide = withGuide ? `${styleText("cyan", S_BAR)}  ` : "";
      const endGuide = withGuide ? styleText("cyan", S_BAR_END) : "";
      const header = formatPromptHeader(this.state, input.message, guide);

      if (this.state === "submit") {
        const label = labelByValue.get(this.value as T) ?? "";
        if (shouldSuppressSubmittedSummary(label)) {
          return header;
        }
        return `${header}\n${guide}${formatSelectedSummary(label)}`;
      }

      if (this.state === "cancel") {
        return `${header}\n${guide}${formatBackSummary(input.cancelLabel)}`;
      }

      const lines = [header];
      for (const [index, option] of this.options.entries()) {
        const active = index === this.cursor;
        const radio = active
          ? styleText("green", S_RADIO_ACTIVE)
          : S_RADIO_INACTIVE;
        const cursor = formatCursorMarker(active);
        const label = option.disabled
          ? styleText(["strikethrough", "gray"], option.label)
          : formatPromptMessage(option.label);
        const hint = option.hint ? styleText("gray", ` (${option.hint})`) : "";
        lines.push(`${guide}${cursor}${radio} ${label}${hint}`);
      }
      lines.push(...formatPromptFooter(input.message, guide), endGuide);
      return lines.join("\n");
    },
  });

  attachCtrlCExit(prompt);
  return prompt.prompt() as Promise<T | symbol>;
}

function multiselect<T>(input: {
  message: string;
  options: Array<{
    value: T;
    label: string;
    hint?: string;
    disabled?: boolean;
  }>;
  initialValues?: T[];
  required?: boolean;
  cancelLabel?: string;
}): Promise<T[] | symbol> {
  const labelByValue = new Map(
    input.options.map((option) => [option.value, option.label])
  );
  const prompt = new MultiSelectPrompt<{
    value: T;
    label: string;
    hint?: string;
    disabled?: boolean;
  }>({
    options: input.options,
    initialValues: input.initialValues ?? [],
    required: input.required,
    validate(value) {
      if (input.required && (!value || value.length === 0)) {
        return "Select at least one option.";
      }
      return undefined;
    },
    render() {
      const withGuide = settings.withGuide;
      const guideTone = this.state === "error" ? "yellow" : "cyan";
      const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
      const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
      const header = formatPromptHeader(this.state, input.message, guide);

      if (this.state === "submit") {
        return `${header}\n${guide}${formatSubmittedChoiceSummary(
          this.value ?? [],
          labelByValue
        )}`;
      }

      if (this.state === "cancel") {
        return `${header}\n${guide}${formatBackSummary(input.cancelLabel)}`;
      }

      const lines = [header];
      if (this.state === "error") {
        lines.push(`${guide}${styleText("yellow", this.error)}`);
      }

      for (const [index, option] of this.options.entries()) {
        const selected = (this.value ?? []).includes(option.value);
        const checkbox = selected
          ? styleText("green", S_CHECKBOX_SELECTED)
          : S_CHECKBOX_INACTIVE;
        const cursor = formatCursorMarker(index === this.cursor);
        const label = option.disabled
          ? styleText(["strikethrough", "gray"], option.label)
          : formatPromptMessage(option.label);
        const hint = option.hint ? styleText("gray", ` (${option.hint})`) : "";
        lines.push(`${guide}${cursor}${checkbox} ${label}${hint}`);
      }
      lines.push(...formatPromptFooter(input.message, guide), endGuide);
      return lines.join("\n");
    },
  });

  attachCtrlCExit(prompt);
  return prompt.prompt() as Promise<T[] | symbol>;
}

function formatPromptMessage(message: string): string {
  return message.replaceAll(/\s+\([^)]*\)/g, (match) =>
    styleText("gray", match)
  );
}

function formatPromptHeader(
  state: Parameters<typeof symbol>[0],
  message: string,
  guide: string
): string {
  const { lines } = parsePromptMessage(message);
  const messageLines = lines.map(formatPromptMessage);
  return [
    ...(settings.withGuide ? [styleText("gray", S_BAR)] : []),
    `${symbol(state)}  ${messageLines[0] ?? ""}`,
    ...messageLines.slice(1).map((line) => `${guide}${line}`),
  ].join("\n");
}

function formatPromptFooter(message: string, guide: string): string[] {
  const { keyHelp } = parsePromptMessage(message);
  return keyHelp ? [`${guide}${styleText("gray", keyHelp)}`] : [];
}

function parsePromptMessage(message: string): {
  lines: string[];
  keyHelp?: string;
} {
  const lines = message.split("\n");
  const keyHelpLine = lines.find((line) => line.startsWith(KEY_HELP_MARKER));
  return {
    lines: lines.filter((line) => !line.startsWith(KEY_HELP_MARKER)),
    keyHelp: keyHelpLine?.slice(KEY_HELP_MARKER.length),
  };
}

function attachCtrlCExit<T>(prompt: Prompt<T>): void {
  prompt.on("key", (_key, info) => {
    if (info?.sequence === "\x03") {
      process.stdout.write("\n");
      process.exit(130);
    }
  });
}

async function getNavigationActivationSummary(state: WorkspaceState): Promise<{
  activeManagedSkillCount: number;
  activeKitCount: number;
  activeHarnessCount: number;
  activeHarnessLabel?: string;
}> {
  const activations = await getHarnessActivations(state);
  const activeHarnesses = activations.filter(
    (activation) => activation.managedSkillIds.length > 0
  );
  const activeKitIds = new Set(
    activeHarnesses.flatMap((activation) => activation.activeKitIds)
  );

  return {
    activeManagedSkillCount: activeHarnesses.reduce(
      (total, activation) => total + activation.managedSkillIds.length,
      0
    ),
    activeKitCount: activeKitIds.size,
    activeHarnessCount: activeHarnesses.length,
    activeHarnessLabel:
      activeHarnesses.length === 1
        ? labelForHarness(activeHarnesses[0].target)
        : undefined,
  };
}

async function getHarnessActivations(
  state: WorkspaceState
): Promise<TuiHarnessActivation[]> {
  return Promise.all(
    getHarnessTargets(state).map(async (target) => {
      const activation = await getCurrentActivation(state, target.target_path);
      return {
        target,
        managedSkillIds: activation.managedSkillIds,
        activeKitIds: activation.activeKitIds,
        activeSkillIds: activation.activeSkillIds,
      };
    })
  );
}

function getHarnessTargets(state: WorkspaceState): HarnessTargetRecord[] {
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

export async function runTui(
  root = process.cwd(),
  options: TuiRunOptions = {}
): Promise<void> {
  console.log(formatSplash());
  const startupReview = options.startupReview !== false;
  await checkSourceSkillsReady(root);

  const initialized = await isWorkspaceInitialized(root);
  let initialScan: TuiScanResult | undefined;
  let state: WorkspaceState | undefined;
  const canGoBackToSetup = !initialized;

  if (initialized) {
    initialScan = await scanRepoWithFeedback(root, "Loading repo skills");
    state = initialScan.state;
  } else {
    state = await runFirstRunSetup(root);
    if (state) {
      initialScan = await scanRepoWithFeedback(root, "Loading repo skills");
      state = initialScan.state;
    }
  }

  if (!state) {
    outro("skills-kit setup is required for the guided switchboard.");
    return;
  }

  state = await runLegacyHarnessImport(state);
  state = await runHarnessConfigCheck(state);
  let sessionBaseline: SessionBaseline = {
    initializedAtStart: initialized,
    state,
    activationSummary: await getNavigationActivationSummary(state),
    packageStatus: await getSafePackageJsonIntegrationStatus(state),
  };

  const initialActivation = await getCurrentActivation(state);
  const initialHarnessActivations = await getHarnessActivations(state);
  let startupDiagnostics =
    initialScan?.diagnostics ??
    createSkillScanDiagnostics({
      skills: state.graph.skills,
      sourceInventory: await runSourceInventoryCheck(root),
    });
  note(
    [
      formatWorkspaceSnapshot({
        state,
        activeLinks: initialActivation.managedSkillIds.length,
        targetDir: initialActivation.targetDir,
        targetStatuses: formatSnapshotTargetStatuses(
          state,
          initialHarnessActivations
        ),
      }),
      "",
      formatStartupValidationSummary(startupDiagnostics),
    ].join("\n"),
    "Current repo",
    { format: identityFormat }
  );
  if (
    startupReview &&
    state.preferences.startup_review.offer !== "dismissed" &&
    (hasStartupIssues(startupDiagnostics) ||
      countLegacyReviewItems(
        await inspectLegacyHarnessEntries(state, {
          includeManagedTargets: true,
        })
      ) > 0)
  ) {
    const reviewed = await runStartupIssueReview(state, startupDiagnostics);
    state = reviewed.state;
    startupDiagnostics = reviewed.diagnostics;
  }
  if (initialized) {
    state = await runPackageJsonStartupOffer(state);
    if (!state) {
      return;
    }
    sessionBaseline = {
      ...sessionBaseline,
      state: sessionBaseline.state,
    };
  }

  let running = true;
  while (running) {
    const activationSummary = await getNavigationActivationSummary(state);
    const legacyInspection = await inspectLegacyHarnessEntries(state, {
      includeManagedTargets: true,
    });
    const action = await select<MenuAction>({
      message: withKeyHelp(
        formatMenuTitle({
          kitCount: state.graph.kits.length,
          skillCount: state.graph.skills.length,
          activeLinkCount: activationSummary.activeManagedSkillCount,
        }),
        canGoBackToSetup ? "root-back-select" : "root-select"
      ),
      options: buildMainMenuOptions({
        kitCount: state.graph.kits.length,
        skillCount: state.graph.skills.length,
        activeManagedSkillCount: activationSummary.activeManagedSkillCount,
        activeKitCount: activationSummary.activeKitCount,
        activeHarnessCount: activationSummary.activeHarnessCount,
        activeHarnessLabel: activationSummary.activeHarnessLabel,
        defaultTargetPath: state.preferences.harness.target_path,
        issueCount:
          startupDiagnostics.issues.length +
          countLegacyReviewItems(legacyInspection),
      }),
      cancelLabel: canGoBackToSetup ? "Back" : "Quit",
    });

    if (isCancel(action)) {
      if (canGoBackToSetup) {
        const setupResult = await runPostSetupFlow(state);
        if (setupResult.outcome === "back") {
          await rollbackFreshSetup(setupResult.value);
          state = await runFirstRunSetup(root);
          if (!state) {
            outro("No changes made");
            return;
          }
        } else {
          state = setupResult.value;
        }
        continue;
      }
      running = false;
      continue;
    }

    if (action === "quit") {
      running = false;
      continue;
    }
    if (action === "issues") {
      const reviewed = await runStartupIssueReview(state, startupDiagnostics, {
        force: true,
      });
      state = reviewed.state;
      startupDiagnostics = reviewed.diagnostics;
      continue;
    }
    if (action === "status") {
      note(formatTuiRepoStatus(state.graph), "Repo status", {
        format: identityFormat,
      });
      continue;
    }
    if (action === "managed-kits") {
      state = await runManagedKitsMenu(state);
      continue;
    }
    if (action === "more") {
      const utilityState = await runUtilityMenu(state);
      if (!utilityState) {
        return;
      }
      state = utilityState;
    }
  }

  await showSessionSummary(sessionBaseline, state);
  outro("Done");
}

function formatSnapshotTargetStatuses(
  state: WorkspaceState,
  activations: TuiHarnessActivation[]
): string[] {
  const defaultPaths = new Set(
    getDefaultHarnessTargets(state).map((target) => target.target_path)
  );

  return activations.map((activation) => {
    const parts = [
      labelForHarness(activation.target),
      defaultPaths.has(activation.target.target_path) ? "default" : "supported",
      formatCount(activation.managedSkillIds.length, "active skill"),
    ];
    if (activation.activeKitIds.length > 0) {
      parts.push(formatCount(activation.activeKitIds.length, "active kit"));
    }
    return parts.join(" - ");
  });
}

async function showSessionSummary(
  baseline: SessionBaseline,
  state: WorkspaceState
): Promise<void> {
  const finalActivationSummary = await getNavigationActivationSummary(state);
  const finalPackageStatus = await getSafePackageJsonIntegrationStatus(state);
  note(
    formatSessionSummary({
      baseline,
      state,
      finalActivationSummary,
      finalPackageStatus,
    }),
    "Session summary",
    { format: identityFormat }
  );
}

async function runLegacyHarnessImport(
  state: WorkspaceState,
  options: { includeManagedTargets?: boolean; forceReview?: boolean } = {}
): Promise<WorkspaceState> {
  const inspection = await withSpinner(
    "Checking existing target skills",
    () =>
      inspectLegacyHarnessEntries(state, {
        includeManagedTargets: options.includeManagedTargets,
      }),
    "Existing targets checked"
  );

  if (inspection.compatible.length === 0 && inspection.warnings.length === 0) {
    return state;
  }

  const copiedMatches = inspection.compatible.filter(
    (entry) => entry.kind !== "source-symlink"
  );
  let normalizeCopies = false;

  if (
    options.forceReview ||
    inspection.warnings.length > 0 ||
    copiedMatches.length > 0
  ) {
    note(
      formatLegacyImportWarningSummary(inspection),
      "Existing target skills",
      {
        format: identityFormat,
      }
    );
  }

  if (copiedMatches.length > 0) {
    const shouldNormalize = await confirm({
      message: withKeyHelp(
        "Normalize or migrate existing target skills?",
        "confirm"
      ),
      active: "Normalize/migrate",
      inactive: "Keep for now",
      initialValue: true,
    });
    normalizeCopies = shouldNormalize === true;
  }

  const importable = inspection.compatible.filter(
    (entry) => entry.kind === "source-symlink" || normalizeCopies
  );
  if (importable.length === 0) {
    return state;
  }

  note(
    formatLegacyImportPreview(inspection, importable, {
      normalizeCopies,
    }),
    "Legacy import preview",
    { format: identityFormat }
  );

  const result = await withSpinner(
    "Importing existing target skills",
    () =>
      importLegacyHarnessEntries(state, importable, {
        normalizeCopies,
        mergeExistingActivation: options.includeManagedTargets,
      }),
    "Legacy target state imported"
  );
  note(formatLegacyImportResult(result), "Legacy kits created", {
    format: identityFormat,
  });

  return { ...state, graph: result.graph };
}

function formatSessionSummary(input: {
  baseline: SessionBaseline;
  state: WorkspaceState;
  finalActivationSummary: Awaited<
    ReturnType<typeof getNavigationActivationSummary>
  >;
  finalPackageStatus?: PackageJsonIntegrationStatus;
}): string {
  const changes = formatSessionChanges(input);
  const currentState = [
    paintDiff("blue", "Current repo"),
    formatSummaryField(
      "Source skills",
      input.state.graph.skills.length,
      15,
      "blue"
    ),
    formatSummaryField("Kits", input.state.graph.kits.length, 15, "blue"),
    formatSummaryField(
      "Active skills",
      input.finalActivationSummary.activeManagedSkillCount,
      15,
      input.finalActivationSummary.activeManagedSkillCount > 0
        ? "green"
        : "muted"
    ),
    formatSummaryField(
      "Default",
      formatDefaultHarnessSummary(input.state),
      15,
      "blue"
    ),
  ];

  return [...changes, "", ...currentState].join("\n");
}

function formatSessionChanges(input: {
  baseline: SessionBaseline;
  state: WorkspaceState;
  finalActivationSummary: Awaited<
    ReturnType<typeof getNavigationActivationSummary>
  >;
  finalPackageStatus?: PackageJsonIntegrationStatus;
}): string[] {
  const lines = [paintDiff("blue", "Changes")];

  if (!input.baseline.initializedAtStart) {
    lines.push(paintDiff("green", "- Set up skills-kit metadata"));
  }

  const previousKits = new Map(
    input.baseline.state.graph.kits.map((kit) => [kit.id, kit])
  );
  const createdKits = input.state.graph.kits.filter(
    (kit) => !previousKits.has(kit.id)
  );
  const updatedKits = input.state.graph.kits.filter((kit) => {
    const previous = previousKits.get(kit.id);
    return (
      previous &&
      (previous.name !== kit.name ||
        previous.description !== kit.description ||
        previous.skill_ids.join("\0") !== kit.skill_ids.join("\0"))
    );
  });

  for (const kit of createdKits) {
    lines.push(
      paintDiff(
        "green",
        `- Created kit: ${kit.name} (${formatCount(kit.skill_ids.length, "skill")})`
      )
    );
  }
  for (const kit of updatedKits) {
    lines.push(
      paintDiff(
        "green",
        `- Updated kit: ${kit.name} (${formatCount(kit.skill_ids.length, "skill")})`
      )
    );
  }

  if (didHarnessPreferencesChange(input.baseline.state, input.state)) {
    lines.push(
      paintDiff(
        "green",
        `- Updated harnesses: ${formatDefaultHarnessSummary(input.state)}`
      )
    );
  }

  if (
    input.baseline.activationSummary.activeManagedSkillCount !==
    input.finalActivationSummary.activeManagedSkillCount
  ) {
    lines.push(
      paintDiff(
        "green",
        `- Active skills: ${input.baseline.activationSummary.activeManagedSkillCount} -> ${input.finalActivationSummary.activeManagedSkillCount}`
      )
    );
  }

  if (
    didPackageShortcutChange(
      input.baseline.packageStatus,
      input.finalPackageStatus
    )
  ) {
    const command = input.finalPackageStatus?.runScriptCommand;
    lines.push(
      paintDiff(
        "green",
        `- Added package script${command ? `: ${command}` : ""}`
      )
    );
  }

  if (lines.length === 1) {
    lines.push(paintDiff("muted", "- No changes made"));
  }

  return lines;
}

function didHarnessPreferencesChange(
  initial: WorkspaceState,
  current: WorkspaceState
): boolean {
  return (
    formatHarnessPreferenceKey(initial) !== formatHarnessPreferenceKey(current)
  );
}

function formatHarnessPreferenceKey(state: WorkspaceState): string {
  return JSON.stringify({
    supported: state.preferences.supported_harnesses.map((target) => [
      target.name,
      target.target_path,
    ]),
    defaults: state.preferences.default_harnesses.map((target) => [
      target.name,
      target.target_path,
    ]),
    primary: [
      state.preferences.harness.name,
      state.preferences.harness.target_path,
    ],
  });
}

function didPackageShortcutChange(
  initial?: PackageJsonIntegrationStatus,
  current?: PackageJsonIntegrationStatus
): boolean {
  return Boolean(
    current?.hasDependency &&
      current.hasScript &&
      (!initial?.hasDependency || !initial.hasScript)
  );
}

function formatDefaultHarnessSummary(state: WorkspaceState): string {
  const targets = state.preferences.default_harnesses.length
    ? state.preferences.default_harnesses
    : [state.preferences.harness];
  return targets.map(formatHarnessTargetOptionLabel).join(", ");
}

async function runHarnessConfigCheck(
  state: WorkspaceState
): Promise<WorkspaceState> {
  const report = await withSpinner(
    "Checking configured harness views",
    () => inspectHarnessHealth(state),
    "Harness config checked"
  );

  if (report.issues.length === 0) {
    return state;
  }

  const reapplicableIssues = report.issues.filter(canReapplyHarnessIssue);
  const activeIssues = report.issues.filter(hasActiveHarnessIssue);

  note(
    [
      "Configured harness targets need review.",
      "",
      formatHarnessHealthReport(report),
    ].join("\n"),
    "Harness config needs review",
    { format: identityFormat }
  );

  const action = await select<HarnessRecoveryAction>({
    message: withKeyHelp("How should skills-kit fix this?", "select"),
    options: [
      ...(reapplicableIssues.length > 0
        ? [
            {
              value: "reapply" as const,
              label: "Restore active skills",
              hint: "Recreate missing managed symlinks from saved kits/skills",
            },
          ]
        : []),
      {
        value: "preferences",
        label: "Choose harnesses again",
      },
      ...(activeIssues.length > 0
        ? [
            {
              value: "forget" as const,
              label: "Forget saved active skills",
              hint: "Stop showing saved managed links as active",
            },
          ]
        : []),
      {
        value: "continue",
        label: "Keep going for now",
        hint: "Leave config unchanged",
      },
    ],
  });

  if (isCancel(action) || action === "continue") {
    return state;
  }

  if (action === "preferences") {
    return runPreferences(state, {
      title: "Which targets should stay supported?",
    });
  }

  if (action === "forget") {
    return clearSavedHarnessState(state, activeIssues);
  }

  return reapplySavedHarnessViews(state, reapplicableIssues);
}

async function reapplySavedHarnessViews(
  state: WorkspaceState,
  issues: HarnessHealthIssue[]
): Promise<WorkspaceState> {
  let graph = state.graph;
  const results: string[] = [];

  for (const issue of issues) {
    const result = await applySelection(
      { ...state, graph },
      {
        kitIds: issue.manifest.active_kit_ids,
        skillIds: getRepairSkillIds(issue),
        targetPath: issue.target.target_path,
        query: "startup repair: reapply harness view",
      }
    );
    graph = result.graph;
    results.push(
      `${issue.target.target_path}: created ${result.created}, removed ${result.removed}, kept ${result.kept}`
    );
  }

  note(results.join("\n"), "Reapplied saved harness views", {
    format: identityFormat,
  });
  return { ...state, graph };
}

async function clearSavedHarnessState(
  state: WorkspaceState,
  issues: HarnessHealthIssue[]
): Promise<WorkspaceState> {
  let graph = state.graph;
  const results: string[] = [];

  for (const issue of issues) {
    const canRemoveManagedLinks =
      issue.targetExists &&
      !issue.planError &&
      (issue.plan?.conflicts.length ?? 0) === 0;

    if (canRemoveManagedLinks) {
      const result = await deactivateSelection(
        { ...state, graph },
        {
          all: true,
          targetPath: issue.target.target_path,
          query: "startup repair: clear saved active state",
        }
      );
      graph = result.graph;
      results.push(
        `${issue.target.target_path}: removed ${result.removed}, kept ${result.kept}`
      );
      continue;
    }

    const result = await forgetActivationState(
      { ...state, graph },
      issue.target.target_path
    );
    results.push(`${result.targetDir}: forgot saved active state`);
  }

  note(
    [...results, "", "Source skills were not changed."].join("\n"),
    "Saved harness state cleared",
    { format: identityFormat }
  );
  return { ...state, graph };
}

function getRepairSkillIds(issue: HarnessHealthIssue): string[] {
  if (issue.manifest.active_skill_ids.length > 0) {
    return issue.manifest.active_skill_ids;
  }

  if (issue.manifest.active_kit_ids.length > 0) {
    return [];
  }

  return issue.manifest.managed_skill_ids;
}

async function runUtilityMenu(
  state: WorkspaceState
): Promise<WorkspaceState | undefined> {
  let currentState = state;

  while (true) {
    const action = await select<UtilityAction>({
      message: withKeyHelp("More options", "select"),
      options: buildUtilityMenuOptions({
        packageManager: (
          await getSafePackageJsonIntegrationStatus(currentState)
        )?.packageManager,
      }),
    });

    if (isCancel(action) || action === "back") {
      return currentState;
    }

    if (action === "toggle-skills") {
      currentState = await runApplyIndividualSkills(currentState);
      continue;
    }

    if (action === "restore-legacy") {
      currentState =
        (await runRestoreLegacySetup(currentState)) ?? currentState;
      continue;
    }

    if (action === "scan") {
      const result = await scanRepoWithFeedback(
        currentState.paths.root,
        "Rescanning repo skills"
      );
      showScanDiagnostics(result.diagnostics, "Scan complete");
      currentState = result.state;
      continue;
    }

    if (action === "doctor") {
      await runTuiHealthCheck(currentState);
      continue;
    }

    if (action === "targets") {
      currentState = await runManageHarnesses(currentState);
      continue;
    }

    if (action === "preferences") {
      currentState = await runPreferences(currentState);
      continue;
    }

    if (action === "package-json") {
      currentState = await runPackageJsonSettings(currentState);
      continue;
    }

    if (action === "uninstall") {
      const result = await runTuiUninstall(currentState);
      if (result === "uninstalled") {
        outro("Done");
        return undefined;
      }
    }
  }
}

async function runManagedKitsMenu(
  state: WorkspaceState
): Promise<WorkspaceState> {
  let currentState = state;

  while (true) {
    const activationSummary =
      await getNavigationActivationSummary(currentState);
    const action = await select<ManagedKitsAction>({
      message: withKeyHelp("Manage kits", "select"),
      options: buildManagedKitsMenuOptions({
        kitCount: currentState.graph.kits.length,
        skillCount: currentState.graph.skills.length,
        activeManagedSkillCount: activationSummary.activeManagedSkillCount,
        activeKitCount: activationSummary.activeKitCount,
        activeHarnessCount: activationSummary.activeHarnessCount,
        activeHarnessLabel: activationSummary.activeHarnessLabel,
        defaultTargetPath: currentState.preferences.harness.target_path,
      }),
    });

    if (isCancel(action) || action === "back") {
      return currentState;
    }

    if (action === "kit") {
      currentState = await runKitEditor(currentState, "choose");
      continue;
    }

    if (action === "apply-kits") {
      currentState = await runApplyKit(currentState);
      continue;
    }

    if (action === "clear-links") {
      currentState = await runClearManagedLinks(currentState);
      continue;
    }

    if (action === "active-kits") {
      await runActiveKitsStatus(currentState);
      continue;
    }

    if (action === "active-skills") {
      await runActiveSkillsStatus(currentState);
    }
  }
}

async function runTuiHealthCheck(state: WorkspaceState): Promise<void> {
  const { diagnostics, harnessReport, packageStatus } = await withSpinner(
    "Running health check",
    async () => {
      const sourceInventory = await runSourceInventoryCheck(state.paths.root);
      return {
        diagnostics: createSkillScanDiagnostics({
          skills: state.graph.skills,
          sourceInventory,
        }),
        harnessReport: await inspectHarnessHealth(state),
        packageStatus: await getSafePackageJsonIntegrationStatus(state),
      };
    },
    "Health check complete"
  );

  note(
    formatTuiHealthCheck(state, diagnostics, harnessReport, packageStatus),
    "Health check",
    { format: identityFormat }
  );
}

async function runToolTargetsStatus(state: WorkspaceState): Promise<void> {
  const activations = await getHarnessActivations(state);
  note(formatToolTargetsStatus(state, activations), "Harnesses", {
    format: identityFormat,
  });
}

async function runManageHarnesses(
  state: WorkspaceState
): Promise<WorkspaceState> {
  let currentState = state;

  while (true) {
    await runToolTargetsStatus(currentState);
    const action = await select<ManageHarnessesAction>({
      message: withKeyHelp("Manage Harnesses", "select"),
      options: [
        { value: "edit", label: "Edit Harnesses" },
        { value: "back", label: "Back" },
      ],
    });

    if (isCancel(action) || action === "back") {
      return currentState;
    }

    currentState = await runPreferences(currentState, {
      title: "Which harnesses should skills-kit support?",
    });
  }
}

async function runRestoreLegacySetup(
  state: WorkspaceState,
  options: { disconnectAfter?: boolean; title?: string } = {}
): Promise<WorkspaceState | undefined> {
  const plan = await withSpinner(
    "Preparing legacy restore preview",
    () =>
      planLegacyRestore(state, {
        disconnectAfter: options.disconnectAfter,
      }),
    "Legacy restore preview ready"
  );
  note(
    formatLegacyRestorePlan(plan),
    options.title ?? "Revert to legacy setup",
    {
      format: identityFormat,
    }
  );

  if (!hasLegacyRestoreChanges(plan)) {
    return state;
  }

  const shouldRestore = await confirm({
    message: withKeyHelp("Apply this legacy setup?", "confirm"),
    active: "Restore legacy setup",
    inactive: "Back",
    initialValue: true,
  });
  if (shouldRestore !== true) {
    return undefined;
  }

  const result = await withSpinner(
    "Restoring legacy setup",
    () =>
      restoreLegacySetup(state, {
        disconnectAfter: options.disconnectAfter,
      }),
    "Legacy setup restored"
  );
  note(formatLegacyRestoreResult(result), "Legacy setup restored", {
    format: identityFormat,
  });
  return { ...state, graph: result.graph };
}

async function runTuiUninstall(
  state: WorkspaceState
): Promise<"cancelled" | "uninstalled"> {
  const scopeChoice = await select<TuiUninstallAction>({
    message: withKeyHelp("What should be removed?", "select"),
    options: [
      {
        value: "restore-legacy-and-uninstall",
        label: "Revert to legacy setup and uninstall",
        hint: "Restore legacy kit links, then remove settings",
      },
      {
        value: "settings",
        label: "Settings only",
      },
      {
        value: "harnesses",
        label: "Disconnect harnesses",
      },
      {
        value: "all",
        label: "Remove both",
      },
      { value: "back", label: "Back" },
    ],
  });

  if (isCancel(scopeChoice) || scopeChoice === "back") {
    return "cancelled";
  }

  if (scopeChoice === "restore-legacy-and-uninstall") {
    const restored = await runRestoreLegacySetup(state, {
      disconnectAfter: true,
      title: "Revert to legacy setup before uninstall",
    });
    if (!restored) {
      return "cancelled";
    }
    const plan = await withSpinner(
      "Preparing uninstall preview",
      () => planUninstall(restored.paths.root, { scope: "settings" }),
      "Uninstall preview ready"
    );
    note(formatUninstallPlan(plan), "Uninstall skills-kit", {
      format: identityFormat,
    });
    if (!hasUninstallChanges(plan)) {
      return "cancelled";
    }
    const confirmation = await textInput({
      message: "Confirm uninstall:",
      placeholder: "delete",
      validate(value) {
        if (value?.trim() === "delete") {
          return undefined;
        }
        return 'Type "delete" to confirm.';
      },
    });
    if (isCancel(confirmation)) {
      note("Uninstall cancelled. Nothing was removed.", "Uninstall cancelled", {
        format: identityFormat,
      });
      return "cancelled";
    }
    const result = await withSpinner(
      "Uninstalling skills-kit",
      () => uninstallSkillsKit(restored.paths.root, { scope: "settings" }),
      "Uninstall complete"
    );
    note(formatUninstallResult(result), "Uninstall complete", {
      format: identityFormat,
    });
    return "uninstalled";
  }

  const scope: UninstallScope = scopeChoice;
  const plan = await withSpinner(
    "Preparing uninstall preview",
    () => planUninstall(state.paths.root, { scope }),
    "Uninstall preview ready"
  );
  note(formatUninstallPlan(plan), "Uninstall skills-kit", {
    format: identityFormat,
  });

  if (!hasUninstallChanges(plan)) {
    return "cancelled";
  }

  const confirmation = await textInput({
    message: "Confirm uninstall:",
    placeholder: "delete",
    validate(value) {
      if (value?.trim() === "delete") {
        return undefined;
      }
      return 'Type "delete" to confirm.';
    },
  });

  if (isCancel(confirmation)) {
    note("Uninstall cancelled. Nothing was removed.", "Uninstall cancelled", {
      format: identityFormat,
    });
    return "cancelled";
  }

  const result = await withSpinner(
    "Uninstalling skills-kit",
    () => uninstallSkillsKit(state.paths.root, { scope }),
    "Uninstall complete"
  );
  note(formatUninstallResult(result), "Uninstall complete", {
    format: identityFormat,
  });
  return "uninstalled";
}

async function runPackageJsonStartupOffer(
  state: WorkspaceState
): Promise<WorkspaceState | undefined> {
  const status = await getSafePackageJsonIntegrationStatus(state);

  if (!status?.hasPackageJson) {
    return state;
  }

  if (status.hasDependency && status.hasScript) {
    if (state.preferences.package_json.offer === "configured") {
      return state;
    }
    return savePackageJsonPreference(state, {
      ...state.preferences.package_json,
      offer: "configured",
    });
  }

  if (state.preferences.package_json.offer !== "ask") {
    return state;
  }

  const scriptName =
    state.preferences.package_json.script_name || DEFAULT_PACKAGE_SCRIPT_NAME;
  const runCommand = formatPackageScriptCommand(
    status.packageManager,
    scriptName
  );
  note(
    [
      `Package manager: ${status.packageManager}`,
      "",
      `${status.packageManager} script`,
      `- Dev dependency: ${SKILLS_KIT_PACKAGE_LABEL}@${state.preferences.package_json.dependency_spec || DEFAULT_PACKAGE_DEPENDENCY_SPEC}`,
      `- Script: "${scriptName}": "${state.preferences.package_json.script_command || DEFAULT_PACKAGE_SCRIPT_COMMAND}"`,
      `- Run with: ${runCommand}`,
      "",
      paintDiff("green", "No package.json changes unless you choose Add."),
    ].join("\n"),
    "Optional package script",
    { format: identityFormat }
  );

  const action = await select<PackageJsonStartupAction>({
    message: withKeyHelp("What should skills-kit do?", "root-select"),
    options: [
      {
        value: "add",
        label: `Add ${status.packageManager} script`,
        hint: runCommand,
      },
      {
        value: "customize",
        label: "Custom",
        hint: `example: ${formatPackageScriptCommand(status.packageManager, "skills-kit")}`,
      },
      {
        value: "skip",
        label: "Skip for now",
        hint: "Ask again next time",
      },
      {
        value: "dismiss",
        label: "Do not ask again",
      },
    ],
    cancelLabel: "Quit",
  });

  if (isCancel(action)) {
    outro("Done");
    return undefined;
  }

  if (action === "skip") {
    return state;
  }

  if (action === "dismiss") {
    return savePackageJsonPreference(state, {
      ...state.preferences.package_json,
      offer: "dismissed",
    });
  }

  if (action === "customize") {
    const scriptName = await promptPackageScriptName(
      state.preferences.package_json.script_name,
      status.packageManager
    );
    return scriptName ? applyPackageJsonShortcut(state, scriptName) : state;
  }

  return applyPackageJsonShortcut(
    state,
    state.preferences.package_json.script_name || DEFAULT_PACKAGE_SCRIPT_NAME
  );
}

async function runPackageJsonSettings(
  state: WorkspaceState
): Promise<WorkspaceState> {
  const status = await getSafePackageJsonIntegrationStatus(state);

  if (!status) {
    note(
      paintDiff(
        "red",
        "Fix package.json so skills-kit can inspect it, then come back here."
      ),
      "Package script",
      { format: identityFormat }
    );
    return state;
  }

  if (!status.hasPackageJson) {
    note(
      paintDiff(
        "default",
        "No package.json was found in this repo. Create one first, then come back here."
      ),
      "Package script",
      { format: identityFormat }
    );
    return state;
  }

  note(
    formatPackageJsonShortcutStatus(state.preferences.package_json, status),
    "Package script",
    { format: identityFormat }
  );

  const action = await select<PackageJsonAction>({
    message: withKeyHelp("Package script settings", "select"),
    options: [
      {
        value: "add",
        label:
          status.hasDependency && status.hasScript
            ? `Reapply ${status.packageManager} script`
            : `Add ${status.packageManager} script`,
        hint: status.runScriptCommand,
      },
      {
        value: "customize",
        label: "Custom",
        hint: `example: ${formatPackageScriptCommand(status.packageManager, "skills-kit")}`,
      },
      ...(status.hasDependency || status.hasScript
        ? [
            {
              value: "remove" as const,
              label: "Remove package script",
              hint: "Remove skills-kit script and dependency traces",
            },
          ]
        : []),
      {
        value: "ask",
        label: "Show this offer on startup",
        hint: "Re-enable the startup offer",
      },
      {
        value: "dismiss",
        label: "Keep this offer hidden",
      },
      { value: "back", label: "Back" },
    ],
  });

  if (isCancel(action) || action === "back") {
    return state;
  }

  if (action === "ask") {
    return savePackageJsonPreference(state, {
      ...state.preferences.package_json,
      offer: "ask",
    });
  }

  if (action === "dismiss") {
    return savePackageJsonPreference(state, {
      ...state.preferences.package_json,
      offer: "dismissed",
    });
  }

  if (action === "remove") {
    return removePackageJsonShortcut(state);
  }

  if (action === "customize") {
    const scriptName = await promptPackageScriptName(
      state.preferences.package_json.script_name,
      status.packageManager
    );
    return scriptName ? applyPackageJsonShortcut(state, scriptName) : state;
  }

  return applyPackageJsonShortcut(
    state,
    state.preferences.package_json.script_name || DEFAULT_PACKAGE_SCRIPT_NAME
  );
}

async function getSafePackageJsonIntegrationStatus(
  state: WorkspaceState
): Promise<PackageJsonIntegrationStatus | undefined> {
  try {
    return await getPackageJsonIntegrationStatus(
      state.paths.root,
      state.preferences.package_json
    );
  } catch (error) {
    log.warn(
      `Could not inspect package.json script: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

async function promptPackageScriptName(
  initialValue: string,
  packageManager: PackageManagerName
): Promise<string | undefined> {
  const currentValue = initialValue || DEFAULT_PACKAGE_SCRIPT_NAME;
  while (true) {
    const choice = await select<PackageScriptChoice>({
      message: withKeyHelp("What command should start skills-kit?", "select"),
      options: [
        {
          value: "skills",
          label: "skills",
          hint: formatPackageScriptCommand(packageManager, "skills"),
        },
        {
          value: "skills:kit",
          label: "skills:kit",
          hint: formatPackageScriptCommand(packageManager, "skills:kit"),
        },
        {
          value: "skills-kit",
          label: "skills-kit",
          hint: formatPackageScriptCommand(packageManager, "skills-kit"),
        },
        {
          value: "custom",
          label: "Custom",
          hint: PACKAGE_SCRIPT_PRESETS.has(currentValue as PackageScriptChoice)
            ? `example: ${formatPackageScriptCommand(packageManager, "skills-kit")}`
            : `current: ${currentValue}`,
        },
      ],
    });

    if (isCancel(choice)) {
      return undefined;
    }

    if (choice !== "custom") {
      return choice;
    }

    const scriptName = await textInput({
      message: "Script name:",
      placeholder: DEFAULT_PACKAGE_SCRIPT_NAME,
      initialValue: currentValue,
      validate(value) {
        const trimmed = value?.trim();
        if (!trimmed) {
          return "A script name is required.";
        }
        if (trimmed.length > 64 || !/^[a-zA-Z0-9:_-]+$/.test(trimmed)) {
          return "Use letters, numbers, dashes, underscores, or colons.";
        }
        return undefined;
      },
    });

    if (typeof scriptName === "string") {
      return scriptName.trim();
    }
  }
}

async function applyPackageJsonShortcut(
  state: WorkspaceState,
  scriptName: string
): Promise<WorkspaceState> {
  const packageJson = normalizePackageJsonPreference({
    ...state.preferences.package_json,
    offer: "configured",
    script_name: scriptName,
  });

  try {
    const result = await withSpinner(
      "Updating package.json",
      () =>
        applyPackageJsonIntegration(state.paths.root, {
          scriptName: packageJson.script_name,
          scriptCommand: packageJson.script_command,
          dependencySpec: packageJson.dependency_spec,
        }),
      "package.json updated"
    );
    const nextState = await savePackageJsonPreference(state, packageJson);
    note(
      [
        formatSummaryField(
          "devDependency",
          `${result.addedDependency ? "added" : "already present"} ${SKILLS_KIT_PACKAGE_LABEL}`,
          16
        ),
        formatSummaryField(
          "script",
          `${result.runScriptCommand} -> ${result.scriptCommand}`,
          16
        ),
        formatSummaryField(
          "script status",
          result.addedScript ? "added" : "already present",
          16
        ),
      ].join("\n"),
      "Package script saved",
      { format: identityFormat }
    );
    return nextState;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return state;
  }
}

async function removePackageJsonShortcut(
  state: WorkspaceState
): Promise<WorkspaceState> {
  try {
    const result = await withSpinner(
      "Removing package script",
      () => removePackageJsonIntegration(state.paths.root),
      "Package script removed"
    );
    const nextState = await savePackageJsonPreference(state, {
      ...state.preferences.package_json,
      offer: "dismissed",
    });
    note(
      [
        formatSummaryField("scripts", result.removedScripts, 16),
        formatSummaryField("dependencies", result.removedDependencies, 16),
      ].join("\n"),
      "Package script removed",
      { format: identityFormat }
    );
    return nextState;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return state;
  }
}

async function savePackageJsonPreference(
  state: WorkspaceState,
  packageJson: PackageJsonPreferences
): Promise<WorkspaceState> {
  const preferences = {
    ...state.preferences,
    package_json: normalizePackageJsonPreference(packageJson),
  };
  await withSpinner(
    "Saving package script preference",
    () => savePreferences(state.paths, preferences),
    "Package script preference saved"
  );
  return { ...state, preferences };
}

function normalizePackageJsonPreference(
  preference: PackageJsonPreferences
): PackageJsonPreferences {
  return {
    offer: preference.offer,
    script_name: preference.script_name.trim() || DEFAULT_PACKAGE_SCRIPT_NAME,
    script_command:
      preference.script_command.trim() || DEFAULT_PACKAGE_SCRIPT_COMMAND,
    dependency_spec:
      preference.dependency_spec.trim() || DEFAULT_PACKAGE_DEPENDENCY_SPEC,
  };
}

function formatPackageJsonShortcutStatus(
  preference: PackageJsonPreferences,
  status: PackageJsonIntegrationStatus
): string {
  return [
    formatSummaryField("File", status.packageJsonPath, 17),
    formatSummaryField("package manager", status.packageManager, 17),
    formatSummaryField(
      "devDependency",
      `${status.hasDependency ? "present" : "missing"} ${SKILLS_KIT_PACKAGE_LABEL}`,
      17
    ),
    formatSummaryField(
      "script",
      `${status.runScriptCommand} -> ${status.scriptCommand}`,
      17
    ),
    formatSummaryField(
      "script status",
      formatPackageJsonScriptStatus(status),
      17
    ),
    formatSummaryField("startup offer", preference.offer, 17),
  ].join("\n");
}

function formatPackageJsonScriptStatus(
  status: PackageJsonIntegrationStatus
): string {
  if (status.hasScript) {
    return "present";
  }
  if (status.scriptConflict) {
    return `conflicts with "${status.scriptConflict}"`;
  }
  return "missing";
}

async function runFirstRunSetup(
  root: string
): Promise<WorkspaceState | undefined> {
  while (true) {
    note(
      [
        "No ./.agents/skills-kit metadata was found in this repo.",
        "Setup creates local skills-kit config only.",
        paintDiff("green", "Source skills stay untouched."),
        paintDiff("green", "Harness links change only after preview."),
      ].join("\n"),
      "First run",
      { format: identityFormat }
    );
    const shouldInit = await confirm({
      message: withKeyHelp("Set up skills-kit for this repo?", "confirm"),
      active: "Set up now",
      inactive: "Not now",
      initialValue: true,
      cancelLabel: "Cancel",
    });

    if (isCancel(shouldInit) || !shouldInit) {
      note(
        "The guided switchboard needs ./.agents/skills-kit metadata. No files were changed.",
        "Setup skipped",
        { format: identityFormat }
      );
      return undefined;
    }

    const scanResult = await scanRepoWithFeedback(
      root,
      "Creating local skill map"
    );
    const state = scanResult.state;
    note(
      formatInitializedSummary(state.graph, scanResult.diagnostics),
      "Initialized ./.agents/skills-kit",
      { format: identityFormat }
    );
    const setupResult = await runPostSetupFlow(state);
    if (setupResult.outcome === "back") {
      await rollbackFreshSetup(setupResult.value);
      continue;
    }
    return setupResult.value;
  }
}

async function runPostSetupFlow(
  state: WorkspaceState
): Promise<NavigationResult<WorkspaceState>> {
  let currentState = state;

  while (true) {
    const preferenceResult = await runPreferencesFlow(currentState, {
      title: "Choose harnesses",
    });
    if (preferenceResult.outcome === "back") {
      return { outcome: "back", value: currentState };
    }
    currentState = preferenceResult.value;

    const packageState = await runPackageJsonStartupOffer(currentState);
    if (!packageState) {
      return { outcome: "saved", value: currentState };
    }
    currentState = packageState;

    if (currentState.graph.kits.length === 0) {
      const shouldCreateKit = await confirm({
        message: withKeyHelp("Create your first kit now?", "confirm-back"),
        active: "Create kit",
        inactive: "Not now",
        initialValue: true,
      });
      if (isCancel(shouldCreateKit)) {
        continue;
      }
      if (shouldCreateKit) {
        currentState = await runKitEditor(currentState, "new");
      }
    }

    return { outcome: "saved", value: currentState };
  }
}

async function rollbackFreshSetup(state: WorkspaceState): Promise<void> {
  await withSpinner(
    "Going back",
    () => rm(state.paths.kitDir, { recursive: true, force: true }),
    "Back to setup"
  );
}

async function runKitEditor(
  state: WorkspaceState,
  mode: KitEditorMode
): Promise<WorkspaceState> {
  if (state.graph.skills.length === 0) {
    log.warn("No skills found in ./.agents/skills.");
    return state;
  }

  const existingKit =
    mode === "new"
      ? "__new__"
      : await select<string>({
          message: withKeyHelp("Which kit do you want to edit?", "select"),
          options: [
            { value: "__new__", label: "Create a new kit" },
            ...state.graph.kits.map((kit) => ({
              value: kit.id,
              label: kit.name,
              hint: formatCount(kit.skill_ids.length, "skill"),
            })),
          ],
        });

  if (isCancel(existingKit)) {
    return state;
  }

  const currentKit = state.graph.kits.find((kit) => kit.id === existingKit);
  if (currentKit) {
    return runExistingKitEditor(state, currentKit);
  }

  return runNewKitEditor(state);
}

async function runNewKitEditor(state: WorkspaceState): Promise<WorkspaceState> {
  const kitName = await textInput({
    message: "Kit name:",
    placeholder: "ui-design",
    validate(value) {
      return value?.trim() ? undefined : "A kit name is required.";
    },
  });

  if (isCancel(kitName) || !kitName) {
    return state;
  }

  const description = await textInput({
    message: "Description:",
    placeholder: "Frontend UI polish",
  });

  if (isCancel(description)) {
    return state;
  }

  const selectedSkillIds = await promptSkillCheckboxes({
    message: "Select skills in this kit",
    skills: state.graph.skills,
    initialSkillIds: [],
  });

  if (!selectedSkillIds) {
    return state;
  }

  const graph = await withSpinner(
    "Saving kit",
    () =>
      createOrUpdateKit(state, {
        name: kitName,
        description,
        skillIds: selectedSkillIds,
      }),
    `Saved ${String(kitName).trim()}`
  );
  const nextState = { ...state, graph };
  const savedKit = graph.kits.find(
    (kit) => kit.name === String(kitName).trim()
  );
  note(
    await formatKitSavedSummary(nextState, selectedSkillIds.length),
    `Saved ${String(kitName).trim()}`,
    { format: identityFormat }
  );

  if (!savedKit) {
    return nextState;
  }

  const action = await select<KitCreatedAction>({
    message: withKeyHelp(`Kit created: ${savedKit.name}`, "select"),
    options: [
      { value: "activate", label: `Activate ${savedKit.name}` },
      { value: "new", label: "Create new kit" },
      { value: "manage", label: "Manage kits" },
      { value: "main", label: "Main menu" },
    ],
  });

  if (isCancel(action) || action === "main") {
    return nextState;
  }

  if (action === "activate") {
    return runActivateSingleKit(nextState, savedKit.id);
  }

  return runKitEditor(nextState, action === "new" ? "new" : "choose");
}

async function runExistingKitEditor(
  state: WorkspaceState,
  kit: SkillKitRecord
): Promise<WorkspaceState> {
  const action = await select<KitEditAction>({
    message: withKeyHelp(`Edit kit: ${kit.name}`, "select"),
    options: [
      { value: "info", label: "Edit info", hint: kit.description || undefined },
      {
        value: "skills",
        label: "Skill selection",
        hint: formatCount(kit.skill_ids.length, "skill"),
      },
      { value: "delete", label: "Delete kit", hint: "Type delete to confirm" },
      { value: "back", label: "Back" },
    ],
  });

  if (isCancel(action) || action === "back") {
    return state;
  }

  if (action === "delete") {
    return runDeleteKitFlow(state, kit);
  }

  if (action === "info") {
    return runEditKitInfo(state, kit);
  }

  return runEditKitSkills(state, kit);
}

async function runEditKitInfo(
  state: WorkspaceState,
  kit: SkillKitRecord
): Promise<WorkspaceState> {
  const kitName = await textInput({
    message: "Kit name:",
    placeholder: kit.name,
    initialValue: kit.name,
    validate(value) {
      return value?.trim() ? undefined : "A kit name is required.";
    },
  });
  if (isCancel(kitName) || !kitName) {
    return state;
  }

  const description = await textInput({
    message: "Description:",
    placeholder: "Frontend UI polish",
    initialValue: kit.description,
  });
  if (isCancel(description)) {
    return state;
  }

  const graph = await withSpinner(
    "Saving kit info",
    async () => {
      const nextName = String(kitName).trim();
      const renamedGraph =
        nextName !== kit.name
          ? await renameKit(state, kit.id, nextName)
          : state.graph;
      return createOrUpdateKit(
        { ...state, graph: renamedGraph },
        {
          name: nextName,
          description,
          skillIds: kit.skill_ids,
        }
      );
    },
    "Kit info saved"
  );
  const nextState = { ...state, graph };
  const savedKit = graph.kits.find(
    (candidate) => candidate.name === String(kitName).trim()
  );
  const syncedState =
    savedKit && savedKit.id !== kit.id
      ? await resyncTargetsAfterKitRename(nextState, kit.id, savedKit.id)
      : nextState;
  note(
    await formatKitSavedSummary(syncedState, kit.skill_ids.length),
    `Saved ${String(kitName).trim()}`,
    { format: identityFormat }
  );
  return syncedState;
}

async function runEditKitSkills(
  state: WorkspaceState,
  kit: SkillKitRecord
): Promise<WorkspaceState> {
  const selectedSkillIds = await promptSkillCheckboxes({
    message: `Select skills in ${kit.name}`,
    skills: state.graph.skills,
    initialSkillIds: kit.skill_ids,
  });
  if (!selectedSkillIds) {
    return state;
  }

  const graph = await withSpinner(
    "Saving kit skills",
    () =>
      createOrUpdateKit(state, {
        name: kit.name,
        description: kit.description,
        skillIds: selectedSkillIds,
      }),
    "Kit skills saved"
  );
  const nextState = { ...state, graph };
  note(
    await formatKitSavedSummary(nextState, selectedSkillIds.length),
    `Saved ${kit.name}`,
    { format: identityFormat }
  );
  return nextState;
}

async function runDeleteKitFlow(
  state: WorkspaceState,
  kit: SkillKitRecord
): Promise<WorkspaceState> {
  note(
    [
      formatSummaryField("Kit", kit.name, 12),
      formatSummaryField("Skills", kit.skill_ids.length, 12),
      "",
      "Deleting the kit removes the kit record. Source skills stay untouched.",
      "Active targets are resynced so skills remain active when another active kit still includes them.",
    ].join("\n"),
    "Delete kit",
    { format: identityFormat }
  );

  const confirmation = await textInput({
    message: `Confirm deleting ${kit.name}:`,
    placeholder: "delete",
    validate(value) {
      if (value?.trim() === "delete") {
        return undefined;
      }
      return 'Type "delete" to confirm.';
    },
  });

  if (isCancel(confirmation)) {
    return state;
  }

  const graph = await withSpinner(
    "Deleting kit",
    () => deleteKit(state, kit.id),
    "Kit deleted"
  );
  const nextState = await resyncTargetsAfterKitDelete(
    { ...state, graph },
    kit.id
  );
  note(
    [
      formatSummaryField("Deleted", kit.name, 10, "green"),
      "Source skills were not changed.",
    ].join("\n"),
    "Kit deleted",
    { format: identityFormat }
  );
  return nextState;
}

async function resyncTargetsAfterKitDelete(
  state: WorkspaceState,
  deletedKitId: string
): Promise<WorkspaceState> {
  const activations = await getHarnessActivations(state);
  let graph = state.graph;
  const results = [];

  for (const activation of activations) {
    if (!activation.activeKitIds.includes(deletedKitId)) {
      continue;
    }
    const result = await applySelection(
      { ...state, graph },
      {
        kitIds: activation.activeKitIds.filter(
          (kitId) => kitId !== deletedKitId
        ),
        skillIds: activation.activeSkillIds,
        targetPath: activation.target.target_path,
        mode: "update",
        query: `tui delete kit: ${deletedKitId}`,
      }
    );
    graph = result.graph;
    results.push(result);
  }

  if (results.length > 0) {
    note(formatHarnessUpdateResults(results), "Targets resynced", {
      format: identityFormat,
    });
  }

  return { ...state, graph };
}

async function resyncTargetsAfterKitRename(
  state: WorkspaceState,
  previousKitId: string,
  nextKitId: string
): Promise<WorkspaceState> {
  const activations = await getHarnessActivations(state);
  let graph = state.graph;
  const results = [];

  for (const activation of activations) {
    if (!activation.activeKitIds.includes(previousKitId)) {
      continue;
    }
    const result = await applySelection(
      { ...state, graph },
      {
        kitIds: activation.activeKitIds.map((kitId) =>
          kitId === previousKitId ? nextKitId : kitId
        ),
        skillIds: activation.activeSkillIds,
        targetPath: activation.target.target_path,
        mode: "update",
        query: `tui rename kit: ${previousKitId} -> ${nextKitId}`,
      }
    );
    graph = result.graph;
    results.push(result);
  }

  if (results.length > 0) {
    note(formatHarnessUpdateResults(results), "Targets resynced", {
      format: identityFormat,
    });
  }

  return { ...state, graph };
}

async function formatKitSavedSummary(
  state: WorkspaceState,
  selectedSkillCount: number
): Promise<string> {
  const groupedSkillIds = new Set(
    state.graph.kits.flatMap((kit) => kit.skill_ids)
  );
  const ungroupedCount = state.graph.skills.length - groupedSkillIds.size;
  const activationSummary = await getNavigationActivationSummary(state);

  return [
    formatSummaryField("Kit skills", selectedSkillCount, 14, "green"),
    formatSummaryField("Kits", state.graph.kits.length, 14, "blue"),
    formatSummaryField(
      "Active kits",
      activationSummary.activeKitCount,
      14,
      "blue"
    ),
    formatSummaryField("Ungrouped", ungroupedCount, 14, "yellow"),
  ].join("\n");
}

async function runActivateSingleKit(
  state: WorkspaceState,
  kitId: string
): Promise<WorkspaceState> {
  const targetPaths = await chooseHarnessTargets(
    state,
    "Where should this kit be active?"
  );
  if (targetPaths.length === 0) {
    return state;
  }

  const plans = await withSpinner(
    "Building kit plan",
    () =>
      Promise.all(
        targetPaths.map((targetPath) =>
          planSelection(state, {
            kitIds: [kitId],
            targetPath,
            mode: "update",
            query: `tui activate kit: ${kitId}`,
          })
        )
      ),
    "Kit plan ready"
  );
  const approved = await reviewSymlinkPlans({
    title:
      targetPaths.length === 1
        ? `Activate ${kitId} in ${targetPaths[0]}`
        : `Activate ${kitId} in ${targetPaths.length} harnesses`,
    plans,
    applyLabel: `Activate ${kitId}`,
  });

  if (!approved) {
    return state;
  }

  let graph = state.graph;
  const results = [];
  for (const targetPath of targetPaths) {
    const result = await applySelection(
      { ...state, graph },
      {
        kitIds: [kitId],
        targetPath,
        mode: "update",
        query: `tui activate kit: ${kitId}`,
      }
    );
    graph = result.graph;
    results.push(result);
  }

  note(formatHarnessUpdateResults(results), "Active skills updated", {
    format: identityFormat,
  });
  return { ...state, graph };
}

async function runApplyKit(state: WorkspaceState): Promise<WorkspaceState> {
  if (state.graph.kits.length === 0) {
    log.warn("Create a kit before applying one.");
    return runKitEditor(state, "new");
  }

  while (true) {
    const targetPaths = await chooseHarnessTargets(
      state,
      "Edit active kits for which targets?"
    );
    if (targetPaths.length === 0) {
      return state;
    }

    const activations = await Promise.all(
      targetPaths.map((targetPath) => getCurrentActivation(state, targetPath))
    );
    const kitSelection = await promptKitTargetSelection({
      message: withKeyHelp("Which kits should be active?", "multiselect"),
      kits: state.graph.kits,
      activations,
      targetPaths,
    });

    if (!kitSelection) {
      continue;
    }

    const selectedKitIds = [
      ...new Set(kitSelection.flatMap((entry) => entry.kitIds)),
    ];
    const selectedSkillIds = resolveSkillIdsFromKits(
      state.graph,
      selectedKitIds
    );
    if (selectedKitIds.length > 0 && selectedSkillIds.length === 0) {
      log.warn("Selected kits do not include any skills. Edit a kit first.");
      continue;
    }

    const plan = await withSpinner(
      "Building kit plan",
      () =>
        buildMultiHarnessKitPlans(state, {
          targetSelections: kitSelection,
          query: `tui edit active kits: ${selectedKitIds.join(", ") || "none"}`,
        }),
      "Kit plan ready"
    );

    const approved = await reviewSymlinkPlans({
      title: formatEditActiveKitsTitle(targetPaths),
      plans: plan.map((entry) => entry.plan),
      applyLabel: "Apply changes",
    });

    if (!approved) {
      continue;
    }

    const result = await withSpinner(
      "Applying changes",
      () =>
        applyMultiHarnessKitChange(state, {
          targetSelections: kitSelection,
          query: `tui edit active kits: ${selectedKitIds.join(", ") || "none"}`,
        }),
      "Active skills updated"
    );
    note(formatHarnessUpdateResults(result.results), "Active skills updated", {
      format: identityFormat,
    });

    return { ...state, graph: result.graph };
  }
}

async function runClearManagedLinks(
  state: WorkspaceState
): Promise<WorkspaceState> {
  const targetPath = await chooseActiveHarnessTarget(
    state,
    "Turn off active skills in which tool?"
  );
  if (!targetPath) {
    return state;
  }

  const current = await getCurrentActivation(state, targetPath);
  if (current.managedSkillIds.length === 0) {
    log.warn(`No managed skills are active in ${targetPath}.`);
    return state;
  }

  while (true) {
    const action =
      current.activeKitIds.length === 0
        ? "all"
        : await select<"kits" | "all">({
            message: withKeyHelp("What should be turned off?", "select"),
            options: [
              {
                value: "kits",
                label: "Selected active kits",
                hint: "Only skills from those kits",
              },
              {
                value: "all",
                label: "All active skills here",
                hint: "Everything skills-kit manages here",
              },
            ],
          });

    if (isCancel(action)) {
      return state;
    }

    const kitIds =
      action === "all"
        ? []
        : await multiselect<string>({
            message: withKeyHelp(
              "Which active kits should be turned off?",
              "multiselect"
            ),
            options: state.graph.kits
              .filter((kit) => current.activeKitIds.includes(kit.id))
              .map((kit) => ({
                value: kit.id,
                label: kit.name,
                hint: formatCount(kit.skill_ids.length, "skill"),
              })),
            required: true,
          });

    if (isCancel(kitIds)) {
      continue;
    }

    const query =
      action === "all"
        ? "tui clear managed links"
        : `tui clear kits: ${kitIds.join(", ")}`;
    const plan = await withSpinner(
      "Building clear plan",
      () =>
        planDeactivation(state, {
          kitIds,
          all: action === "all",
          targetPath,
          query,
        }),
      "Clear plan ready"
    );

    const approved = await reviewSymlinkPlans({
      title:
        action === "all"
          ? `Turn off active skills in ${targetPath}`
          : `Turn off selected kits in ${targetPath}`,
      plans: [plan],
      applyLabel:
        action === "all" ? "Turn off active skills" : "Turn off selected kits",
    });

    if (!approved) {
      continue;
    }

    const result = await withSpinner(
      "Turning off active skills",
      () =>
        deactivateSelection(state, {
          kitIds,
          all: action === "all",
          targetPath,
          query,
        }),
      "Active skills updated"
    );
    note(formatHarnessUpdateResults([result]), "Active skills updated", {
      format: identityFormat,
    });

    return { ...state, graph: result.graph };
  }
}

async function promptKitTargetSelection(input: {
  message: string;
  kits: SkillKitRecord[];
  activations: Array<Awaited<ReturnType<typeof getCurrentActivation>>>;
  targetPaths: string[];
}): Promise<Array<{ targetPath: string; kitIds: string[] }> | undefined> {
  const activeByTarget = new Map(
    input.activations.map((activation) => [
      activation.targetDir,
      new Set(activation.activeKitIds),
    ])
  );
  const targetDirByPath = new Map(
    input.activations.map((activation, index) => [
      input.targetPaths[index],
      activation.targetDir,
    ])
  );
  const states = new Map<string, KitTargetSelectionState>();
  const mixedKitIds = new Set<string>();

  for (const kit of input.kits) {
    const activeCount = input.activations.filter((activation) =>
      activation.activeKitIds.includes(kit.id)
    ).length;
    if (activeCount > 0 && activeCount < input.activations.length) {
      mixedKitIds.add(kit.id);
    }
    states.set(
      kit.id,
      activeCount === 0
        ? "off"
        : activeCount === input.activations.length
          ? "on"
          : "keep"
    );
  }

  const result = await kitTargetStatePrompt({
    message: input.message,
    kits: input.kits,
    states,
    activeCounts: new Map(
      input.kits.map((kit) => [
        kit.id,
        input.activations.filter((activation) =>
          activation.activeKitIds.includes(kit.id)
        ).length,
      ])
    ),
    targetCount: input.activations.length,
    mixedKitIds,
    activeTargetLabels: new Map(
      input.kits.map((kit) => [
        kit.id,
        input.activations
          .filter((activation) => activation.activeKitIds.includes(kit.id))
          .map((activation, index) =>
            labelForTargetPath(input.targetPaths[index], activation.targetDir)
          ),
      ])
    ),
  });

  if (!result || isCancel(result)) {
    return undefined;
  }

  return input.targetPaths.map((targetPath) => {
    const targetDir = targetDirByPath.get(targetPath);
    const activeKitIds = targetDir ? activeByTarget.get(targetDir) : undefined;
    return {
      targetPath,
      kitIds: input.kits
        .filter((kit) => {
          const state = result.get(kit.id) ?? "off";
          if (state === "on") {
            return true;
          }
          if (state === "off") {
            return false;
          }
          return activeKitIds?.has(kit.id) ?? false;
        })
        .map((kit) => kit.id),
    };
  });
}

function kitTargetStatePrompt(input: {
  message: string;
  kits: SkillKitRecord[];
  states: Map<string, KitTargetSelectionState>;
  activeCounts: Map<string, number>;
  targetCount: number;
  mixedKitIds: Set<string>;
  activeTargetLabels: Map<string, string[]>;
}): Promise<Map<string, KitTargetSelectionState> | symbol | undefined> {
  let cursor = 0;
  const states = new Map(input.states);
  const touchedKitIds = new Set<string>();
  const cycleFocused = (
    prompt: Prompt<Map<string, KitTargetSelectionState>>
  ) => {
    const kit = input.kits[cursor];
    if (!kit) {
      return;
    }
    const wasTouched = touchedKitIds.has(kit.id);
    states.set(
      kit.id,
      nextKitTargetSelectionState(
        states.get(kit.id) ?? "off",
        input.mixedKitIds.has(kit.id) && !wasTouched
      )
    );
    touchedKitIds.add(kit.id);
    prompt.value = new Map(states);
  };

  let prompt: Prompt<Map<string, KitTargetSelectionState>>;
  prompt = new Prompt<Map<string, KitTargetSelectionState>>(
    {
      render() {
        const withGuide = settings.withGuide;
        const guideTone = this.state === "error" ? "yellow" : "cyan";
        const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
        const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
        const header = formatPromptHeader(this.state, input.message, guide);

        if (this.state === "submit") {
          return `${header}\n${guide}${formatSelectedSummary("Active kit selection saved")}`;
        }

        if (this.state === "cancel") {
          return `${header}\n${guide}${formatBackSummary()}`;
        }

        const optionLines = limitOptions({
          cursor,
          options: input.kits,
          style: (kit, active) =>
            formatKitTargetStateOption({
              kit,
              active,
              state: states.get(kit.id) ?? "off",
              activeCount: input.activeCounts.get(kit.id) ?? 0,
              targetCount: input.targetCount,
              activeTargetLabels: input.activeTargetLabels.get(kit.id) ?? [],
            }),
          maxItems: 18,
          output: process.stdout,
          rowPadding: header.split("\n").length + 2,
        });

        return [
          header,
          ...optionLines.map((line) => `${guide}${line}`),
          `${guide}${styleText("gray", "Mixed kits start as keep current; after editing they toggle on/off · Enter confirm · Esc back")}`,
          endGuide,
        ].join("\n");
      },
    },
    false
  );
  attachCtrlCExit(prompt);
  prompt.value = new Map(states);
  prompt.on("cursor", (action) => {
    if (action === "up" || action === "left") {
      cursor = cyclePromptCursor(cursor, -1, input.kits);
      return;
    }
    if (action === "down" || action === "right") {
      cursor = cyclePromptCursor(cursor, 1, input.kits);
      return;
    }
    if (action === "space") {
      cycleFocused(prompt);
    }
  });
  prompt.on("key", (_key, info) => {
    if (info?.name === "tab") {
      cycleFocused(prompt);
    }
  });

  return prompt.prompt();
}

function nextKitTargetSelectionState(
  state: KitTargetSelectionState,
  canKeep: boolean
): KitTargetSelectionState {
  if (state === "keep") {
    return "on";
  }
  if (state === "on") {
    return "off";
  }
  if (canKeep) {
    return "keep";
  }
  return "on";
}

function formatKitTargetStateOption(input: {
  kit: SkillKitRecord;
  active: boolean;
  state: KitTargetSelectionState;
  activeCount: number;
  targetCount: number;
  activeTargetLabels: string[];
}): string {
  const cursor = formatCursorMarker(input.active);
  const marker =
    input.state === "keep"
      ? styleText("yellow", "◩")
      : input.state === "on"
        ? styleText("green", S_CHECKBOX_SELECTED)
        : S_CHECKBOX_INACTIVE;
  const targetHint =
    input.state === "keep"
      ? `; keep current in ${formatTargetLabelList(input.activeTargetLabels)}`
      : "";
  return `${cursor}${marker} ${input.kit.name} (${formatCount(input.kit.skill_ids.length, "skill")}${targetHint})`;
}

function formatTargetLabelList(labels: string[]): string {
  if (labels.length === 0) {
    return "no targets";
  }
  if (labels.length <= 2) {
    return labels.join(", ");
  }
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function labelForTargetPath(targetPath: string, targetDir: string): string {
  const normalizedPath = targetPath.split(/[\\/]+/).join("/");
  const normalizedDir = targetDir.split(path.sep).join("/");
  if (
    normalizedPath === "./.codex/skills" ||
    normalizedDir.endsWith("/.codex/skills")
  ) {
    return "Codex";
  }
  if (
    normalizedPath === "./.claude/skills" ||
    normalizedDir.endsWith("/.claude/skills")
  ) {
    return "Claude";
  }
  if (
    normalizedPath === "./.gemini/skills" ||
    normalizedDir.endsWith("/.gemini/skills")
  ) {
    return "Gemini CLI";
  }
  if (
    normalizedPath === "./.cursor/skills" ||
    normalizedDir.endsWith("/.cursor/skills")
  ) {
    return "Cursor";
  }
  return path.basename(path.dirname(normalizedDir)) || "Custom";
}

async function runApplyIndividualSkills(
  state: WorkspaceState
): Promise<WorkspaceState> {
  const targetPath = await chooseHarnessTarget(
    state,
    "Use one-off skills in which tool?"
  );
  if (!targetPath) {
    return state;
  }

  const currentActivation = await getCurrentActivation(state, targetPath);
  const selectedSkillIds = await promptSkillCheckboxes({
    message: `Choose specific skills for ${targetPath}`,
    skills: state.graph.skills,
    initialSkillIds: currentActivation.managedSkillIds,
  });

  if (!selectedSkillIds) {
    return state;
  }

  const plan = await withSpinner(
    "Building one-off skill plan",
    () =>
      planSelection(state, {
        skillIds: selectedSkillIds,
        targetPath,
        query: "tui one-off skill selection",
      }),
    "One-off plan ready"
  );

  const approved = await reviewSymlinkPlans({
    title: `This will replace the managed skills in ${targetPath}`,
    plans: [plan],
    applyLabel: "Use selected skills",
  });

  if (!approved) {
    return state;
  }

  const result = await withSpinner(
    "Applying selected skills",
    () =>
      applySelection(state, {
        skillIds: selectedSkillIds,
        targetPath,
        query: "tui one-off skill selection",
      }),
    "Active skills updated"
  );
  note(formatHarnessUpdateResults([result]), "Active skills updated", {
    format: identityFormat,
  });

  return { ...state, graph: result.graph };
}

async function runEnableAllSkills(
  state: WorkspaceState
): Promise<WorkspaceState> {
  const targetPaths = await chooseHarnessTargets(
    state,
    "Turn on all skills in which targets?"
  );
  if (targetPaths.length === 0) {
    return state;
  }

  const skillIds = getApplicableSkillIds(state);
  const plan = await withSpinner(
    "Building all-skills plan",
    () =>
      Promise.all(
        targetPaths.map((targetPath) =>
          planSelection(state, {
            skillIds,
            targetPath,
            query: "tui enable all skills",
          })
        )
      ),
    "All-skills plan ready"
  );

  const approved = await reviewSymlinkPlans({
    title:
      targetPaths.length === 1
        ? `Turn on all skills in ${targetPaths[0]}`
        : `Turn on all skills in ${targetPaths.length} targets`,
    plans: plan,
    applyLabel: "Turn on all skills",
  });

  if (!approved) {
    return state;
  }

  let graph = state.graph;
  const results = [];
  for (const targetPath of targetPaths) {
    const result = await applySelection(
      { ...state, graph },
      {
        skillIds,
        targetPath,
        query: "tui enable all skills",
      }
    );
    graph = result.graph;
    results.push(result);
  }

  note(formatHarnessUpdateResults(results), "All skills enabled", {
    format: identityFormat,
  });

  return { ...state, graph };
}

async function runActiveKitsStatus(state: WorkspaceState): Promise<void> {
  const targetPath = await chooseActiveHarnessTarget(
    state,
    "Show active kits for which target?"
  );
  if (!targetPath) {
    return;
  }

  const current = await getCurrentActivation(state, targetPath);
  const activeKitLines = current.activeKitIds.map((kitId) => {
    const kit = state.graph.kits.find((candidate) => candidate.id === kitId);
    const name = kit?.name ?? kitId;
    const skillCount = kit?.skill_ids.length ?? 0;
    return `${name} (${formatCount(skillCount, "skill")})`;
  });

  note(
    [
      formatSummaryField(
        "Target",
        formatTargetPathLabel(state, targetPath),
        14
      ),
      formatSummaryField("Active kits", current.activeKitIds.length, 14),
      "",
      formatColumnList(activeKitLines, { emptyLabel: "- none" }),
    ].join("\n"),
    "Active kits",
    { format: identityFormat }
  );
}

async function runActiveSkillsStatus(state: WorkspaceState): Promise<void> {
  const targetPath = await chooseActiveHarnessTarget(
    state,
    "Show active skills for which target?"
  );
  if (!targetPath) {
    return;
  }

  const current = await getCurrentActivation(state, targetPath);
  const activeSkillLines = current.managedSkillIds.map((skillId) => {
    const skill = state.graph.skills.find(
      (candidate) => candidate.id === skillId
    );
    return skill?.name ?? skillId;
  });

  note(
    [
      formatSummaryField(
        "Target",
        formatTargetPathLabel(state, targetPath),
        14
      ),
      formatSummaryField("Active kits", current.activeKitIds.length, 14),
      formatSummaryField("Active skills", current.managedSkillIds.length, 14),
      "",
      formatColumnList(activeSkillLines, { emptyLabel: "- none" }),
    ].join("\n"),
    "Active skills",
    { format: identityFormat }
  );
}

function formatTargetPathLabel(
  state: WorkspaceState,
  targetPath: string
): string {
  const target = getHarnessTargets(state).find(
    (candidate) => candidate.target_path === targetPath
  );
  return target ? labelForHarness(target) : targetPath;
}

function formatColumnList(
  items: string[],
  options: { emptyLabel: string; threshold?: number } = { emptyLabel: "- none" }
): string {
  if (items.length === 0) {
    return options.emptyLabel;
  }

  const threshold = options.threshold ?? 12;
  if (items.length < threshold) {
    return items.map((item) => `- ${item}`).join("\n");
  }

  const availableWidth = Math.max(
    40,
    Math.min(process.stdout.columns ?? 88, 96) - 8
  );
  let columnCount = Math.max(
    2,
    Math.min(3, items.length, Math.floor(availableWidth / 24))
  );
  let columnWidth = Math.floor(availableWidth / columnCount);
  while (columnCount > 2 && columnWidth < 24) {
    columnCount -= 1;
    columnWidth = Math.floor(availableWidth / columnCount);
  }
  const itemWidth = Math.max(10, columnWidth - 4);
  const rowCount = Math.ceil(items.length / columnCount);
  const rows: string[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      const item = items[row + column * rowCount];
      if (!item) {
        continue;
      }
      const text = `- ${truncateVisible(item, itemWidth)}`;
      cells.push(padVisible(text, columnWidth));
    }
    rows.push(cells.join("").trimEnd());
  }

  return rows.join("\n");
}

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

function truncateVisible(value: string, width: number): string {
  if (visibleLength(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

async function runPreferences(
  state: WorkspaceState,
  options: { title?: string } = {}
): Promise<WorkspaceState> {
  return (await runPreferencesFlow(state, options)).value;
}

async function runPreferencesFlow(
  state: WorkspaceState,
  options: { title?: string } = {}
): Promise<NavigationResult<WorkspaceState>> {
  const detectedHarnesses = await detectExistingHarnessTargets(
    state.paths.root
  );
  const detectedHarnessNames = detectedHarnesses.map((target) => target.name);
  const configuredHarnessNames = state.preferences.supported_harnesses.map(
    (harness) => harness.name
  );
  const initialValues =
    configuredHarnessNames.length > 0 || detectedHarnessNames.length > 0
      ? [...new Set([...configuredHarnessNames, ...detectedHarnessNames])]
      : [state.preferences.harness.name];

  while (true) {
    const harnesses = await harnessGroupMultiselect({
      message: withKeyHelp(
        options.title ?? "Which targets should skills-kit support?",
        "harness-multiselect"
      ),
      options: buildHarnessSupportOptions(detectedHarnessNames),
      initialValues,
      required: true,
      selectableGroups: false,
      groupSpacing: 1,
    });

    if (!harnesses || isCancel(harnesses)) {
      return { outcome: "back", value: state };
    }

    const supportedHarnesses: HarnessTargetRecord[] = [];
    let shouldRechooseHarnesses = false;
    for (const harness of harnesses) {
      if (harness === "custom") {
        let addMoreCustom = true;
        let initialCustomPath =
          state.preferences.supported_harnesses.find(
            (target) => target.name === "custom"
          )?.target_path ?? defaultTargetPathForHarness("custom");
        while (addMoreCustom) {
          const customPath = await textInput({
            message: "Custom harness path:",
            placeholder: "./.my-agent/skills",
            initialValue: initialCustomPath,
          });

          if (isCancel(customPath) || customPath === undefined) {
            shouldRechooseHarnesses = true;
            break;
          }

          supportedHarnesses.push({
            name: "custom",
            target_path: customPath,
          });
          initialCustomPath = "./.my-agent/skills";

          const addAnother = await confirm({
            message: withKeyHelp("Add another custom harness?", "confirm-back"),
            active: "Add another",
            inactive: "Continue",
            initialValue: false,
          });
          if (isCancel(addAnother)) {
            shouldRechooseHarnesses = true;
            break;
          }
          addMoreCustom = addAnother;
        }
        continue;
      }

      supportedHarnesses.push({
        name: harness,
        target_path: defaultTargetPathForHarness(harness),
      });
    }

    if (shouldRechooseHarnesses) {
      continue;
    }

    const currentDefaultPaths = new Set(
      state.preferences.default_harnesses.map((target) => target.target_path)
    );
    const defaultHarnesses =
      supportedHarnesses.filter((target) =>
        currentDefaultPaths.has(target.target_path)
      ).length > 0
        ? supportedHarnesses.filter((target) =>
            currentDefaultPaths.has(target.target_path)
          )
        : supportedHarnesses.slice(0, 1);
    const primary = defaultHarnesses[0] ?? supportedHarnesses[0];
    const preferences = {
      ...state.preferences,
      harness: {
        ...state.preferences.harness,
        name: primary.name,
        target_path: primary.target_path,
        selection_mode: "symlink" as const,
        managed_symlinks: true,
      },
      default_harnesses: defaultHarnesses,
      supported_harnesses: supportedHarnesses,
    };
    const targetReport = await inspectHarnessHealth({
      ...state,
      preferences,
    });
    const invalidTargetIssues = targetReport.issues.filter(
      hasInvalidConfiguredTargetIssue
    );
    if (invalidTargetIssues.length > 0) {
      note(
        [
          "One or more selected harness targets cannot be managed yet.",
          "",
          formatHarnessHealthReport({ issues: invalidTargetIssues }),
          "",
          "Choose a different target or replace the target path with a real directory, then try again.",
        ].join("\n"),
        "Harness target needs review",
        { format: identityFormat }
      );
      continue;
    }

    await withSpinner(
      "Saving harness preferences",
      () => savePreferences(state.paths, preferences),
      "Preferences saved"
    );
    note(
      [
        formatSummaryLabel("Harnesses"),
        ...supportedHarnesses.map(
          (target) => `- ${formatHarnessTargetOptionLabel(target)}`
        ),
        "",
        formatSummaryLabel("Direct command defaults"),
        ...defaultHarnesses.map(
          (target) => `- ${formatHarnessTargetOptionLabel(target)}`
        ),
      ].join("\n"),
      "Harnesses saved",
      { format: identityFormat }
    );

    return {
      outcome: "saved",
      value: {
        ...state,
        preferences,
      },
    };
  }
}

async function chooseHarnessTarget(
  state: WorkspaceState,
  message: string
): Promise<string | undefined> {
  const targets = getHarnessTargets(state);

  if (targets.length === 1) {
    return targets[0].target_path;
  }

  const target = await select<HarnessTargetRecord>({
    message: withKeyHelp(message, "select"),
    options: targets.map((candidate) => ({
      value: candidate,
      label: labelForHarness(candidate),
      hint: candidate.target_path,
    })),
  });

  if (isCancel(target)) {
    return undefined;
  }

  return target.target_path;
}

async function chooseHarnessTargets(
  state: WorkspaceState,
  message: string
): Promise<string[]> {
  const targets = getHarnessTargets(state);
  const defaultPaths = new Set(
    getDefaultHarnessTargets(state).map((target) => target.target_path)
  );

  if (targets.length === 1) {
    return [targets[0].target_path];
  }

  const selectedTargets = await multiselect<string>({
    message: withKeyHelp(message, "multiselect"),
    options: targets.map((candidate) => ({
      value: candidate.target_path,
      label: labelForHarness(candidate),
      hint: defaultPaths.has(candidate.target_path)
        ? `${candidate.target_path} - direct-command default`
        : candidate.target_path,
    })),
    initialValues: getDefaultHarnessTargets(state).map(
      (target) => target.target_path
    ),
    required: true,
  });

  if (isCancel(selectedTargets)) {
    return [];
  }

  return selectedTargets;
}

function getApplicableSkillIds(state: WorkspaceState): string[] {
  return state.graph.skills
    .filter((skill) => skill.status !== "missing_skill_md")
    .map((skill) => skill.id)
    .toSorted();
}

function getDefaultHarnessTargets(
  state: WorkspaceState
): HarnessTargetRecord[] {
  const targets = getHarnessTargets(state);
  const defaultPaths = new Set(
    state.preferences.default_harnesses.length > 0
      ? state.preferences.default_harnesses.map((target) => target.target_path)
      : [state.preferences.harness.target_path]
  );
  const defaults = targets.filter((target) =>
    defaultPaths.has(target.target_path)
  );

  return defaults.length > 0 ? defaults : targets.slice(0, 1);
}

async function buildMultiHarnessKitPlans(
  state: WorkspaceState,
  input: {
    targetSelections: Array<{ targetPath: string; kitIds: string[] }>;
    query: string;
  }
): Promise<
  Array<{ targetPath: string; plan: Awaited<ReturnType<typeof planSelection>> }>
> {
  return Promise.all(
    input.targetSelections.map(async ({ targetPath, kitIds }) => ({
      targetPath,
      plan: await planSelection(state, {
        kitIds,
        targetPath,
        mode: "update",
        query: input.query,
      }),
    }))
  );
}

async function applyMultiHarnessKitChange(
  state: WorkspaceState,
  input: {
    targetSelections: Array<{ targetPath: string; kitIds: string[] }>;
    query: string;
  }
): Promise<{
  graph: WorkspaceState["graph"];
  results: Array<{
    created: number;
    removed: number;
    kept: number;
    targetDir: string;
  }>;
}> {
  let graph = state.graph;
  const results: Array<{
    created: number;
    removed: number;
    kept: number;
    targetDir: string;
  }> = [];

  for (const { targetPath, kitIds } of input.targetSelections) {
    const nextState = { ...state, graph };
    const result = await applySelection(nextState, {
      kitIds,
      targetPath,
      mode: "update",
      query: input.query,
    });
    graph = result.graph;
    results.push(result);
  }

  return { graph, results };
}

function formatHarnessUpdateResults(
  results: Array<{
    created: number;
    removed: number;
    kept: number;
    targetDir: string;
  }>
): string {
  return results
    .map((entry) =>
      [
        formatSummaryField("Target", entry.targetDir, 9),
        formatSummaryField("Created", entry.created, 9),
        formatSummaryField("Removed", entry.removed, 9),
        formatSummaryField("Kept", entry.kept, 9),
      ].join("\n")
    )
    .join("\n\n");
}

function formatEditActiveKitsTitle(targetPaths: string[]): string {
  const targetLabel =
    targetPaths.length === 1 ? targetPaths[0] : `${targetPaths.length} targets`;
  return `Edit active kits in ${targetLabel}`;
}

async function reviewSymlinkPlans(input: {
  title: string;
  plans: SymlinkApplyPlan[];
  applyLabel: string;
}): Promise<boolean> {
  note(formatSymlinkPlanSummary(input.plans), input.title, {
    format: identityFormat,
  });

  if (input.plans.some((plan) => plan.conflicts.length > 0)) {
    note(formatSymlinkPlanDiff(input.plans), "Conflicts in planned changes", {
      format: identityFormat,
    });
    log.error("Resolve conflicts before applying.");
    return false;
  }

  while (true) {
    const action = await select<PlanReviewAction>({
      message: withKeyHelp("Review changes before applying", "select"),
      options: [
        {
          value: "apply",
          label: input.applyLabel,
          hint: formatPlanTotalHint(input.plans),
        },
        {
          value: "diff",
          label: "Review every link change",
          hint: "Show the full diff",
        },
        { value: "back", label: "Back" },
      ],
    });

    if (isCancel(action) || action === "back") {
      return false;
    }

    if (action === "diff") {
      note(formatSymlinkPlanDiff(input.plans), "Full link diff", {
        format: identityFormat,
      });
      continue;
    }

    return true;
  }
}

function formatSymlinkPlanSummary(plans: SymlinkApplyPlan[]): string {
  const totals = summarizePlans(plans);
  const lines = [
    plans.length === 1
      ? formatSummaryField(
          "Target",
          formatPlanTargetLabel(plans[0]),
          16,
          "blue"
        )
      : formatSummaryField("Targets", `${plans.length} targets`, 16, "blue"),
    formatSelectedPlanCount(plans, totals.selected),
    formatSummaryField(
      "Create",
      paintDiff("green", String(totals.create)),
      16,
      "green"
    ),
    formatSummaryField(
      "Remove",
      paintDiff("red", String(totals.remove)),
      16,
      "red"
    ),
    formatSummaryField(
      "Keep",
      paintDiff("muted", String(totals.keep)),
      16,
      "muted"
    ),
    formatSummaryField(
      "Conflicts",
      paintDiff(
        totals.conflicts > 0 ? "red" : "muted",
        String(totals.conflicts)
      ),
      16,
      totals.conflicts > 0 ? "red" : "muted"
    ),
  ];

  if (plans.length > 1) {
    lines.push(
      "",
      formatSummaryLabel("Per target"),
      ...plans.map(
        (plan) =>
          `- ${formatPlanTargetLabel(plan)}: create ${plan.create.length}, remove ${plan.remove.length}, keep ${plan.keep.length}`
      )
    );
  }

  if (totals.conflicts > 0) {
    lines.push(
      "",
      paintDiff("red", "Conflicts must be resolved before applying.")
    );
  }
  if (totals.remove > 0) {
    lines.push(
      "",
      paintDiff(
        "yellow",
        "Only links skills-kit created are removed. Source skills stay untouched."
      )
    );
  } else {
    lines.push(
      "",
      paintDiff("green", "Source skills in ./.agents/skills stay untouched.")
    );
  }

  lines.push(
    "",
    paintDiff("default", "Full skill names are available in the diff.")
  );
  return lines.join("\n");
}

function formatSelectedPlanCount(
  plans: SymlinkApplyPlan[],
  totalSelected: number
): string {
  if (plans.length === 1) {
    return formatSummaryField(
      "Skills selected",
      plans[0].selected_skill_ids.length,
      16,
      "blue"
    );
  }

  const selectedCounts = new Set(
    plans.map((plan) => plan.selected_skill_ids.length)
  );
  if (selectedCounts.size === 1) {
    return formatSummaryField(
      "Skills selected",
      `${plans[0].selected_skill_ids.length} per target`,
      16,
      "blue"
    );
  }

  return formatSummaryField(
    "Skills selected",
    `${totalSelected} total across targets`,
    16,
    "blue"
  );
}

function formatSymlinkPlanDiff(plans: SymlinkApplyPlan[]): string {
  return plans.map(formatSingleSymlinkPlanDiff).join("\n\n---\n\n");
}

function formatSingleSymlinkPlanDiff(plan: SymlinkApplyPlan): string {
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
    formatSummaryField("Target", formatPlanTargetLabel(plan), 10),
    formatSummaryField("Selected", plan.selected_skill_ids.length, 10),
    "",
    `${paintDiff("blue", "Current managed links".padEnd(leftWidth))}   ${paintDiff("blue", "Next managed links")}`,
    `${paintDiff("muted", "─".repeat(leftWidth))}   ${paintDiff("muted", "─".repeat(rightWidth))}`,
  ];

  if (
    plan.create.length === 0 &&
    plan.remove.length === 0 &&
    plan.keep.length === 0 &&
    plan.conflicts.length === 0
  ) {
    lines.push(paintDiff("muted", "No managed symlink changes."));
    return lines.join("\n");
  }

  for (const skillId of allIds) {
    const isCurrent = current.has(skillId);
    const isNext = next.has(skillId);
    const leftTone =
      isCurrent && !isNext ? "red" : isCurrent ? "muted" : "muted";
    const rightTone =
      !isCurrent && isNext ? "green" : isNext ? "default" : "muted";
    const leftText = isCurrent ? `${isNext ? " " : "-"} ${skillId}` : "";
    const rightText = isNext ? `${isCurrent ? " " : "+"} ${skillId}` : "";

    lines.push(
      `${paintDiff(leftTone, truncateDiffCell(leftText, leftWidth).padEnd(leftWidth))}   ${paintDiff(rightTone, truncateDiffCell(rightText, rightWidth))}`
    );
  }

  if (plan.conflicts.length > 0) {
    lines.push(
      "",
      paintDiff("red", "Conflicts"),
      ...plan.conflicts.map((conflict) =>
        paintDiff("red", `! ${conflict.skill_id}: ${conflict.reason}`)
      )
    );
  }

  return lines.join("\n");
}

function formatPlanTargetLabel(plan: SymlinkApplyPlan): string {
  const normalized = plan.target_dir.split(path.sep).join("/");
  if (normalized.endsWith("/.codex/skills")) {
    return "Codex";
  }
  if (normalized.endsWith("/.claude/skills")) {
    return "Claude";
  }
  if (normalized.endsWith("/.gemini/skills")) {
    return "Gemini CLI";
  }
  if (normalized.endsWith("/.cursor/skills")) {
    return "Cursor";
  }
  return path.basename(path.dirname(normalized)) || "Custom";
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

function truncateDiffCell(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function summarizePlans(plans: SymlinkApplyPlan[]): {
  selected: number;
  create: number;
  remove: number;
  keep: number;
  conflicts: number;
} {
  return plans.reduce(
    (totals, plan) => ({
      selected: totals.selected + plan.selected_skill_ids.length,
      create: totals.create + plan.create.length,
      remove: totals.remove + plan.remove.length,
      keep: totals.keep + plan.keep.length,
      conflicts: totals.conflicts + plan.conflicts.length,
    }),
    { selected: 0, create: 0, remove: 0, keep: 0, conflicts: 0 }
  );
}

function formatPlanTotalHint(plans: SymlinkApplyPlan[]): string {
  const totals = summarizePlans(plans);
  return `create ${totals.create}, remove ${totals.remove}, keep ${totals.keep}`;
}

function identityFormat(line: string): string {
  return line;
}

function paintDiff(
  tone: "blue" | "default" | "green" | "muted" | "orange" | "red" | "yellow",
  value: string
): string {
  const forceColor =
    Boolean(process.env.FORCE_COLOR) && process.env.FORCE_COLOR !== "0";
  if (
    tone === "default" ||
    (process.env.NO_COLOR && !forceColor) ||
    (!process.stdout.isTTY && !forceColor)
  ) {
    return value;
  }

  const ansi = {
    blue: "\x1b[38;5;39m",
    green: "\x1b[38;5;48m",
    muted: "\x1b[38;5;244m",
    orange: "\x1b[38;5;208m",
    red: "\x1b[38;5;203m",
    yellow: "\x1b[38;5;226m",
    reset: "\x1b[0m",
  };
  return `${ansi[tone]}${value}${ansi.reset}`;
}

async function chooseActiveHarnessTarget(
  state: WorkspaceState,
  message: string
): Promise<string | undefined> {
  const activeTargets = (await getHarnessActivations(state)).filter(
    (activation) => activation.managedSkillIds.length > 0
  );

  if (activeTargets.length === 0) {
    log.warn("No managed skills are active in any configured harness.");
    return undefined;
  }

  if (activeTargets.length === 1) {
    return activeTargets[0].target.target_path;
  }

  const target = await select<TuiHarnessActivation>({
    message: withKeyHelp(message, "select"),
    options: activeTargets.map((activation) => ({
      value: activation,
      label: labelForHarness(activation.target),
      hint: `${formatCount(activation.managedSkillIds.length, "active skill")} managed by skills-kit`,
    })),
  });

  if (isCancel(target)) {
    return undefined;
  }

  return target.target.target_path;
}

async function promptSkillCheckboxes(input: {
  message: string;
  skills: SkillRecord[];
  initialSkillIds: string[];
}): Promise<string[] | undefined> {
  const selected = await skillAutocompleteMultiselect({
    message: input.message,
    placeholder: "Type to filter skills",
    maxItems: 12,
    options: input.skills.toSorted(compareSkillsForPrompt).map((skill) => ({
      value: skill.id,
      label: skill.name,
      hint: formatSkillPromptHint(skill),
      disabled: skill.status === "missing_skill_md",
    })),
    initialValues: input.initialSkillIds,
    required: false,
  });

  if (isCancel(selected)) {
    return undefined;
  }

  return selected;
}

function textInput(input: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}): Promise<string | symbol | undefined> {
  const prompt = new TextPrompt({
    placeholder: input.placeholder,
    initialValue: input.initialValue,
    validate: input.validate,
    render() {
      const withGuide = settings.withGuide;
      const guideTone = this.state === "error" ? "yellow" : "cyan";
      const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
      const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
      const header = formatPromptHeader(this.state, input.message, guide);

      if (this.state === "submit") {
        return `${header}\n${guide}${formatSelectedSummary(
          this.value ?? this.userInput ?? ""
        )}`;
      }

      if (this.state === "cancel") {
        return `${header}\n${guide}${formatBackSummary()}`;
      }

      const value =
        this.userInput === "" && input.placeholder
          ? styleText("gray", input.placeholder)
          : this.userInputWithCursor;
      const lines = [header, `${guide}${value}`, endGuide];
      if (this.state === "error") {
        lines.splice(2, 0, `${guide}${styleText("yellow", this.error)}`);
      }
      return lines.join("\n");
    },
  });

  attachCtrlCExit(prompt);
  return prompt.prompt();
}

function skillAutocompleteMultiselect(input: {
  message: string;
  placeholder?: string;
  maxItems?: number;
  options: SkillPromptOption[];
  initialValues: string[];
  required?: boolean;
}): Promise<string[] | symbol | undefined> {
  let cursor = 0;
  let search = "";
  let selectedValues = [...input.initialValues];
  let filteredOptions = filterSkillOptions(input.options, search);
  const focusedValue = () => filteredOptions[cursor]?.value;
  const syncCursor = () => {
    if (filteredOptions.length === 0) {
      cursor = 0;
      return;
    }
    cursor = Math.max(0, Math.min(cursor, filteredOptions.length - 1));
  };
  const syncValue = (activePrompt: Prompt<string[]>) => {
    activePrompt.value = selectedValues;
  };
  const updateSearch = (nextSearch: string) => {
    const previousFocusedValue = focusedValue();
    search = nextSearch;
    filteredOptions = filterSkillOptions(input.options, search);
    const nextCursor = filteredOptions.findIndex(
      (option) => option.value === previousFocusedValue
    );
    cursor = nextCursor === -1 ? 0 : nextCursor;
    syncCursor();
  };
  const toggleFocused = (activePrompt: Prompt<string[]>) => {
    const option = filteredOptions[cursor];
    if (!option || option.disabled) {
      return;
    }
    selectedValues = selectedValues.includes(option.value)
      ? selectedValues.filter((value) => value !== option.value)
      : [...selectedValues, option.value];
    syncValue(activePrompt);
  };

  let prompt: Prompt<string[]>;
  prompt = new Prompt<string[]>(
    {
      validate() {
        if (input.required && selectedValues.length === 0) {
          return "Select at least one skill.";
        }
        return undefined;
      },
      render() {
        const withGuide = settings.withGuide;
        const guideTone = this.state === "error" ? "yellow" : "cyan";
        const guide = withGuide ? `${styleText(guideTone, S_BAR)}  ` : "";
        const endGuide = withGuide ? styleText(guideTone, S_BAR_END) : "";
        const header = formatPromptHeader(
          this.state,
          withKeyHelp(input.message, "search-multiselect"),
          guide
        );

        if (this.state === "submit") {
          return `${header}\n${guide}${formatSelectedSummary(
            `${formatCount(selectedValues.length, "skill")} selected`
          )}`;
        }

        if (this.state === "cancel") {
          return `${header}\n${guide}${formatBackSummary()}`;
        }

        const searchText = formatSearchInput(
          search,
          input.placeholder ?? "Type to filter skills"
        );
        const matchCount =
          filteredOptions.length !== input.options.length
            ? styleText(
                "yellow",
                ` (${filteredOptions.length} match${filteredOptions.length === 1 ? "" : "es"})`
              )
            : "";
        const headerLines = [
          ...header.split("\n"),
          `${guide}Search: ${searchText}${matchCount}`,
        ];
        if (this.state === "error") {
          headerLines.push(`${guide}${styleText("yellow", this.error)}`);
        }

        const footerLines = [
          ...formatPromptFooter(
            withKeyHelp(input.message, "search-multiselect"),
            guide
          ),
          endGuide,
        ];
        const optionLines =
          filteredOptions.length === 0
            ? [styleText("yellow", "No matching skills")]
            : limitOptions({
                cursor,
                options: filteredOptions,
                style: (option, active) =>
                  formatSkillPromptOption(
                    option,
                    active,
                    selectedValues,
                    focusedValue()
                  ),
                maxItems: input.maxItems,
                output: process.stdout,
                rowPadding: headerLines.length + footerLines.length,
              });

        return [
          ...headerLines,
          ...optionLines.map((line) => `${guide}${line}`),
          ...footerLines,
        ].join("\n");
      },
    },
    false
  );
  attachCtrlCExit(prompt);
  syncValue(prompt);
  prompt.on("cursor", (action) => {
    if (action === "up" || action === "left") {
      cursor = cyclePromptCursor(cursor, -1, filteredOptions);
      return;
    }
    if (action === "down" || action === "right") {
      cursor = cyclePromptCursor(cursor, 1, filteredOptions);
      return;
    }
    if (action === "space") {
      toggleFocused(prompt);
    }
  });
  prompt.on("key", (key, info) => {
    if (info?.name === "tab") {
      toggleFocused(prompt);
      return;
    }
    if (info?.name === "backspace" || info?.sequence === "\x7F") {
      updateSearch(search.slice(0, -1));
      return;
    }
    if (info?.name === "delete") {
      updateSearch("");
      return;
    }
    if (isSearchCharacter(key, info?.name)) {
      updateSearch(`${search}${key}`);
    }
  });

  return prompt.prompt();
}

function filterSkillOptions(
  options: SkillPromptOption[],
  search: string
): SkillPromptOption[] {
  return options.filter((option) => filterSkillPromptOption(search, option));
}

function cyclePromptCursor<T>(
  current: number,
  step: number,
  options: T[]
): number {
  if (options.length === 0) {
    return 0;
  }
  let next = current;
  for (let attempts = 0; attempts < options.length; attempts += 1) {
    next = (next + step + options.length) % options.length;
    const option = options[next] as { disabled?: boolean } | undefined;
    if (!option?.disabled) {
      return next;
    }
  }
  return current;
}

function formatSearchInput(search: string, placeholder: string): string {
  if (!search) {
    return styleText("gray", placeholder);
  }
  return `${search}█`;
}

function isSearchCharacter(
  key: string | undefined,
  keyName: string | undefined
): key is string {
  if (!key || key.length !== 1) {
    return false;
  }
  if (key === " " || key === "\t" || key === "\r" || key === "\n") {
    return false;
  }
  return !keyName || keyName.length === 1;
}

function filterSkillPromptOption(
  search: string,
  option: SkillPromptOption
): boolean {
  if (!search) {
    return true;
  }
  const term = search.toLowerCase();
  return [option.label, option.hint, option.value].some((value) =>
    value?.toLowerCase().includes(term)
  );
}

function formatSkillPromptOption(
  option: SkillPromptOption,
  active: boolean,
  selectedValues: string[],
  focusedValue: string | undefined
): string {
  const selected = selectedValues.includes(option.value);
  const checkbox = selected
    ? styleText("green", S_CHECKBOX_SELECTED)
    : S_CHECKBOX_INACTIVE;
  const hint =
    option.hint && option.value === focusedValue
      ? styleText("yellow", ` (${option.hint})`)
      : "";
  const prefix = formatCursorMarker(active);

  if (option.disabled) {
    return `${prefix}${styleText("gray", S_CHECKBOX_INACTIVE)} ${styleText(["strikethrough", "gray"], option.label)}`;
  }

  return `${prefix}${checkbox} ${option.label}${hint}`;
}

function compareSkillsForPrompt(left: SkillRecord, right: SkillRecord): number {
  return (
    skillPromptGroupWeight(left) - skillPromptGroupWeight(right) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

function skillPromptGroupWeight(skill: SkillRecord): number {
  if (skill.status === "missing_skill_md") {
    return 0;
  }
  if (skill.status === "missing_description") {
    return 1;
  }
  if (skill.kit_ids.length === 0) {
    return 2;
  }
  return 3;
}

function formatSkillPromptHint(skill: SkillRecord): string {
  if (skill.status === "missing_skill_md") {
    return "error - missing SKILL.md";
  }
  if (skill.status === "missing_description") {
    return "warning - missing description";
  }
  if (skill.kit_ids.length > 0) {
    return `in: ${skill.kit_ids.join(", ")}`;
  }
  return "";
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
