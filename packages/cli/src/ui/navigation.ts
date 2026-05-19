export type MenuAction = "status" | "issues" | "managed-kits" | "more" | "quit";

export type ManagedKitsAction =
  | "apply-kits"
  | "active-kits"
  | "active-skills"
  | "kit"
  | "clear-links"
  | "back";

export type UtilityAction =
  | "toggle-skills"
  | "restore-legacy"
  | "scan"
  | "doctor"
  | "targets"
  | "preferences"
  | "package-json"
  | "uninstall"
  | "back";

export interface PromptOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface MainMenuNavigationInput {
  kitCount: number;
  skillCount: number;
  activeManagedSkillCount: number;
  activeKitCount: number;
  activeHarnessCount: number;
  activeHarnessLabel?: string;
  defaultTargetPath: string;
  issueCount?: number;
}

export function buildMainMenuOptions(
  input: MainMenuNavigationInput
): Array<PromptOption<MenuAction>> {
  if (input.kitCount === 0) {
    return [
      {
        value: "status",
        label: "Show Status",
      },
      {
        value: "managed-kits",
        label: "Create your first kit",
      },
      ...buildIssueOptions(input.issueCount),
      {
        value: "more",
        label: "More options",
      },
      { value: "quit", label: "Quit" },
    ];
  }

  const hasActiveLinks = input.activeManagedSkillCount > 0;
  const hasActiveKits = input.activeKitCount > 0;
  const options: Array<PromptOption<MenuAction>> = [
    {
      value: "status",
      label: "Show Status",
    },
    {
      value: "managed-kits",
      label: "Manage kits",
      hint: hasActiveKits
        ? formatActiveHarnessHint(input)
        : formatSavedKitCount(input.kitCount),
    },
    ...buildIssueOptions(input.issueCount),
    {
      value: "more",
      label: "More options",
    },
    { value: "quit", label: "Quit" },
  ];

  return options;
}

export function buildManagedKitsMenuOptions(
  input: MainMenuNavigationInput
): Array<PromptOption<ManagedKitsAction>> {
  const hasActiveLinks = input.activeManagedSkillCount > 0;
  const hasActiveKits = input.activeKitCount > 0;
  const options: Array<PromptOption<ManagedKitsAction>> = [];

  if (hasActiveLinks) {
    options.push({
      value: "active-kits",
      label: "Show active kits",
      hint: formatActiveHarnessHint(input),
    });
    options.push({
      value: "active-skills",
      label: "Show active skills",
      hint: formatActiveHarnessHint(input),
    });
  }

  options.push({
    value: "apply-kits",
    label: hasActiveKits ? "Edit active kits" : "Choose active kits",
    hint: hasActiveKits
      ? formatActiveHarnessHint(input)
      : "Choose where they appear; preview changes first",
  });

  options.push({
    value: "kit",
    label: "Create or edit kits",
    hint: formatSavedKitCount(input.kitCount),
  });

  if (hasActiveLinks && !hasActiveKits) {
    options.push({
      value: "clear-links",
      label: "Clear managed links",
      hint: "Only removes links skills-kit created",
    });
  }

  options.push({
    value: "back",
    label: "Back",
  });

  return options;
}

export function buildUtilityMenuOptions(
  input: string | { packageManager?: string }
): Array<PromptOption<UtilityAction>> {
  const packageManager =
    typeof input === "string" ? undefined : input.packageManager;
  const packageScriptLabel = packageManager
    ? `Add ${packageManager} script`
    : "Add package script";

  return [
    {
      value: "toggle-skills",
      label: "Apply individual skill",
    },
    {
      value: "restore-legacy",
      label: "Revert to legacy skill setup",
      hint: "Use legacy kits to restore old target state",
    },
    {
      value: "scan",
      label: "Validate skills",
    },
    {
      value: "doctor",
      label: "Run health check",
    },
    {
      value: "targets",
      label: "Manage Harnesses",
    },
    {
      value: "package-json",
      label: packageScriptLabel,
    },
    {
      value: "uninstall",
      label: "Uninstall skills-kit",
    },
    { value: "back", label: "Back" },
  ];
}

export function filterActiveKitInitialValues(input: {
  activeKitIds: string[];
  availableKitIds: string[];
}): string[] {
  const available = new Set(input.availableKitIds);
  return input.activeKitIds.filter((kitId) => available.has(kitId));
}

function formatSavedKitCount(count: number): string {
  return `${count} saved ${count === 1 ? "kit" : "kits"}`;
}

function buildIssueOptions(issueCount = 0): Array<PromptOption<MenuAction>> {
  if (issueCount === 0) {
    return [];
  }
  return [
    {
      value: "issues",
      label: "Handle errors and warnings",
      hint: `${issueCount} ${issueCount === 1 ? "issue" : "issues"}`,
    },
  ];
}

function formatActiveHarnessHint(input: MainMenuNavigationInput): string {
  if (input.activeHarnessCount > 1) {
    return `${formatCount(input.activeManagedSkillCount, "skill")} active across ${input.activeHarnessCount} targets`;
  }

  const target = input.activeHarnessLabel ?? input.defaultTargetPath;
  return `${formatCount(input.activeManagedSkillCount, "skill")} active in ${target}`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
