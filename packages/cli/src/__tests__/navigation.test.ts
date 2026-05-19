import { describe, expect, it } from "vitest";

import {
  buildManagedKitsMenuOptions,
  buildMainMenuOptions,
  buildUtilityMenuOptions,
  filterActiveKitInitialValues,
} from "../ui/navigation";

describe("switchboard navigation", () => {
  it("shows first-kit setup only when no kits exist", () => {
    const options = buildMainMenuOptions({
      kitCount: 0,
      skillCount: 12,
      activeManagedSkillCount: 0,
      activeKitCount: 0,
      activeHarnessCount: 0,
      defaultTargetPath: "./.codex/skills",
    });

    expect(labels(options)).toEqual([
      "Show Status",
      "Create your first kit",
      "More options",
      "Quit",
    ]);
    expect(labels(options)).not.toContain("Choose active kits");
    expect(labels(options)).not.toContain("Turn off managed kits");
  });

  it("puts startup issue handling above More options", () => {
    const options = buildMainMenuOptions({
      kitCount: 1,
      skillCount: 12,
      activeManagedSkillCount: 0,
      activeKitCount: 0,
      activeHarnessCount: 0,
      defaultTargetPath: "./.codex/skills",
      issueCount: 2,
    });

    expect(labels(options)).toEqual([
      "Show Status",
      "Manage kits",
      "Handle errors and warnings",
      "More options",
      "Quit",
    ]);
    expect(options[2]?.hint).toBe("2 issues");
  });

  it("shows a managed kits area when kits exist", () => {
    const options = buildMainMenuOptions({
      kitCount: 2,
      skillCount: 12,
      activeManagedSkillCount: 0,
      activeKitCount: 0,
      activeHarnessCount: 0,
      defaultTargetPath: "./.codex/skills",
    });

    expect(labels(options)).toEqual([
      "Show Status",
      "Manage kits",
      "More options",
      "Quit",
    ]);
    expect(options[1]?.hint).toBe("2 saved kits");
  });

  it("puts active kit actions in the managed kits area", () => {
    const options = buildManagedKitsMenuOptions({
      kitCount: 2,
      skillCount: 12,
      activeManagedSkillCount: 5,
      activeKitCount: 1,
      activeHarnessCount: 1,
      activeHarnessLabel: "Codex",
      defaultTargetPath: "./.codex/skills",
    });

    expect(labels(options)).toEqual([
      "Show active kits",
      "Show active skills",
      "Edit active kits",
      "Create or edit kits",
      "Back",
    ]);
    expect(options[1]?.hint).toBe("5 skills active in Codex");
    expect(options[1]?.hint).toBe("5 skills active in Codex");
  });

  it("summarizes active kits on the root menu", () => {
    const options = buildMainMenuOptions({
      kitCount: 2,
      skillCount: 12,
      activeManagedSkillCount: 5,
      activeKitCount: 1,
      activeHarnessCount: 1,
      activeHarnessLabel: "Codex",
      defaultTargetPath: "./.codex/skills",
    });

    expect(labels(options)).toEqual([
      "Show Status",
      "Manage kits",
      "More options",
      "Quit",
    ]);
    expect(options[1]?.hint).toBe("5 skills active in Codex");
  });

  it("shows clear links for one-off active skills in managed kits", () => {
    const options = buildManagedKitsMenuOptions({
      kitCount: 2,
      skillCount: 12,
      activeManagedSkillCount: 3,
      activeKitCount: 0,
      activeHarnessCount: 1,
      activeHarnessLabel: "Codex",
      defaultTargetPath: "./.codex/skills",
    });

    expect(labels(options)).toContain("Choose active kits");
    expect(labels(options)).not.toContain("Edit active kits");
    expect(labels(options)).toContain("Clear managed links");
    expect(labels(options)).not.toContain("Turn off managed kits");
  });

  it("summarizes active links across multiple harnesses", () => {
    const options = buildMainMenuOptions({
      kitCount: 2,
      skillCount: 12,
      activeManagedSkillCount: 8,
      activeKitCount: 2,
      activeHarnessCount: 2,
      defaultTargetPath: "./.codex/skills",
    });

    expect(options[1]?.hint).toBe("8 skills active across 2 targets");
  });

  it("preselects only active kits that still exist", () => {
    expect(
      filterActiveKitInitialValues({
        activeKitIds: ["ui", "missing", "review"],
        availableKitIds: ["ui", "review"],
      })
    ).toEqual(["ui", "review"]);
  });

  it("keeps the package script in More options", () => {
    expect(
      labels(buildUtilityMenuOptions({ packageManager: "pnpm" }))
    ).toContain("Add pnpm script");
    expect(labels(buildUtilityMenuOptions("./.codex/skills"))).toContain(
      "Add package script"
    );
  });

  it("includes health, target, and uninstall actions in More options", () => {
    expect(labels(buildUtilityMenuOptions("./.codex/skills"))).toEqual([
      "Apply individual skill",
      "Revert to legacy skill setup",
      "Validate skills",
      "Run health check",
      "Manage Harnesses",
      "Add package script",
      "Uninstall skills-kit",
      "Back",
    ]);
  });
});

function labels<T extends string>(options: Array<{ label: string }>): string[] {
  return options.map((option) => option.label);
}
