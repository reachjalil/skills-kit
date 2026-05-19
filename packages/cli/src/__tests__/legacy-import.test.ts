import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applySelection,
  createOrUpdateKit,
  getCurrentActivation,
  scanRepo,
} from "../core/commands";
import {
  countLegacyReviewItems,
  importLegacyHarnessEntries,
  inspectLegacyHarnessEntries,
} from "../services/harnesses/legacy-import";
import { savePreferences } from "../config/preferences";
import type { WorkspaceState } from "../core/workspace";

describe("legacy harness import", () => {
  it("creates legacy kits for pre-existing source symlinks by target membership", async () => {
    const root = await createFixtureRepo(["shared", "codex-only"]);
    const state = await createTwoTargetState(root);
    await linkHarnessSkill(root, ".codex/skills", "shared");
    await linkHarnessSkill(root, ".claude/skills", "shared");
    await linkHarnessSkill(root, ".codex/skills", "codex-only");

    const inspection = await inspectLegacyHarnessEntries(state);
    const result = await importLegacyHarnessEntries(
      state,
      inspection.compatible
    );

    expect(inspection.warnings).toEqual([]);
    expect(result.createdKitIds).toEqual([
      "legacy-kit-claude-codex",
      "legacy-kit-codex-only",
    ]);
    expect(
      result.graph.kits.find((kit) => kit.id === "legacy-kit-claude-codex")
        ?.skill_ids
    ).toEqual(["shared"]);
    expect(
      result.graph.kits.find((kit) => kit.id === "legacy-kit-codex-only")
        ?.skill_ids
    ).toEqual(["codex-only"]);

    const updatedState = { ...state, graph: result.graph };
    await expectActivation(updatedState, "./.codex/skills", {
      kitIds: ["legacy-kit-claude-codex", "legacy-kit-codex-only"],
      skillIds: ["codex-only", "shared"],
    });
    await expectActivation(updatedState, "./.claude/skills", {
      kitIds: ["legacy-kit-claude-codex"],
      skillIds: ["shared"],
    });
  });

  it("normalizes copied target skills when they match the source exactly", async () => {
    const root = await createFixtureRepo(["copied-skill"]);
    const state = await createTwoTargetState(root);
    await writeTargetSkill(root, ".codex/skills", "copied-skill", {
      description: "Use when testing copied-skill.",
    });

    const inspection = await inspectLegacyHarnessEntries(state);
    const result = await importLegacyHarnessEntries(
      state,
      inspection.compatible,
      { normalizeCopies: true }
    );

    const target = path.join(root, ".codex/skills/copied-skill");
    expect(inspection.warnings).toEqual([]);
    expect(inspection.compatible).toMatchObject([
      { skillId: "copied-skill", kind: "identical-copy" },
    ]);
    expect(result.normalized).toBe(1);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toContain(".agents/skills/copied-skill");
  });

  it("normalizes external symlinks only when they match the source exactly", async () => {
    const root = await createFixtureRepo(["external-skill"]);
    const state = await createTwoTargetState(root);
    const externalRoot = path.join(root, "external-skills");
    await writeSkill(externalRoot, "external-skill", {
      description: "Use when testing external-skill.",
    });
    await linkTargetToExternalSkill(root, ".codex/skills", externalRoot, {
      skillId: "external-skill",
    });

    const inspection = await inspectLegacyHarnessEntries(state);
    const result = await importLegacyHarnessEntries(
      state,
      inspection.compatible,
      { normalizeCopies: true }
    );

    const target = path.join(root, ".codex/skills/external-skill");
    expect(inspection.compatible).toMatchObject([
      { skillId: "external-skill", kind: "external-identical-symlink" },
    ]);
    expect(inspection.warnings).toEqual([]);
    expect(result.normalized).toBe(1);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toContain(".agents/skills/external-skill");
  });

  it("warns instead of replacing external symlinks with local differences", async () => {
    const root = await createFixtureRepo(["external-changed"]);
    const state = await createTwoTargetState(root);
    const externalRoot = path.join(root, "external-skills");
    await writeSkill(externalRoot, "external-changed", {
      description: "Use when testing external-changed.",
      body: "# external-changed\n\nExternal edit.\n",
    });
    await linkTargetToExternalSkill(root, ".codex/skills", externalRoot, {
      skillId: "external-changed",
    });

    const inspection = await inspectLegacyHarnessEntries(state);

    expect(inspection.compatible).toEqual([]);
    expect(inspection.warnings).toMatchObject([
      {
        name: "external-changed",
        reason:
          "symlink points outside ./.agents/skills and differs from the source skill (../../external-skills/external-changed)",
      },
    ]);
  });

  it("migrates valid target skill folders that are not yet in source skills", async () => {
    const root = await createFixtureRepo(["known-skill"]);
    const state = await createTwoTargetState(root);
    await writeTargetSkill(root, ".codex/skills", "target-only", {
      description: "Use when testing target-only.",
    });

    const inspection = await inspectLegacyHarnessEntries(state);
    const result = await importLegacyHarnessEntries(
      state,
      inspection.compatible,
      { normalizeCopies: true }
    );

    const source = path.join(root, ".agents/skills/target-only/SKILL.md");
    const target = path.join(root, ".codex/skills/target-only");
    expect(inspection.compatible).toMatchObject([
      { skillId: "target-only", kind: "migrate-directory" },
    ]);
    expect(await readFile(source, "utf8")).toContain("target-only");
    expect(result.migrated).toBe(1);
    expect(
      result.graph.kits.find((kit) => kit.id === "legacy-kit-codex-only")
        ?.skill_ids
    ).toEqual(["target-only"]);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toContain(".agents/skills/target-only");
  });

  it("warns instead of replacing copied target skills with local differences", async () => {
    const root = await createFixtureRepo(["changed-skill"]);
    const state = await createTwoTargetState(root);
    await writeTargetSkill(root, ".codex/skills", "changed-skill", {
      description: "Use when testing changed skills.",
      body: "# changed-skill\n\nLocal target edit.\n",
    });

    const inspection = await inspectLegacyHarnessEntries(state);

    expect(inspection.compatible).toEqual([]);
    expect(inspection.warnings).toMatchObject([
      {
        name: "changed-skill",
        reason:
          "directory differs from the matching source skill; skills-kit cannot replace it safely",
      },
    ]);
  });

  it("does not normalize a copied target skill that changes after review", async () => {
    const root = await createFixtureRepo(["copied-race"]);
    const state = await createTwoTargetState(root);
    await writeTargetSkill(root, ".codex/skills", "copied-race", {
      description: "Use when testing copied-race.",
    });

    const inspection = await inspectLegacyHarnessEntries(state);
    await writeFile(
      path.join(root, ".codex/skills/copied-race/SKILL.md"),
      `---
name: copied-race
description: "Use when testing copied-race."
---

# copied-race

Local edit after preview.
`,
      "utf8"
    );

    await expect(
      importLegacyHarnessEntries(state, inspection.compatible, {
        normalizeCopies: true,
      })
    ).rejects.toThrow(/changed after review/i);

    const target = path.join(root, ".codex/skills/copied-race");
    expect((await lstat(target)).isDirectory()).toBe(true);
    await expect(
      readFile(path.join(target, "SKILL.md"), "utf8")
    ).resolves.toContain("Local edit after preview.");
  });

  it("does not migrate a target-only skill if the source appears after review", async () => {
    const root = await createFixtureRepo(["known-skill"]);
    const state = await createTwoTargetState(root);
    await writeTargetSkill(root, ".codex/skills", "target-race", {
      description: "Use when testing target-race.",
    });

    const inspection = await inspectLegacyHarnessEntries(state);
    await writeSourceSkill(root, "target-race", {
      description: "Use when testing target-race source collision.",
    });

    await expect(
      importLegacyHarnessEntries(state, inspection.compatible, {
        normalizeCopies: true,
      })
    ).rejects.toThrow(/already exists/i);

    expect(
      (await lstat(path.join(root, ".codex/skills/target-race"))).isDirectory()
    ).toBe(true);
    await expect(
      readFile(path.join(root, ".agents/skills/target-race/SKILL.md"), "utf8")
    ).resolves.toContain("source collision");
  });

  it("does not normalize an external symlink that changes after review", async () => {
    const root = await createFixtureRepo(["external-race"]);
    const state = await createTwoTargetState(root);
    const firstExternalRoot = path.join(root, "external-skills");
    const secondExternalRoot = path.join(root, "other-external-skills");
    await writeSkill(firstExternalRoot, "external-race", {
      description: "Use when testing external-race.",
    });
    await writeSkill(secondExternalRoot, "external-race", {
      description: "Use when testing external-race.",
      body: "# external-race\n\nChanged external target.\n",
    });
    await linkTargetToExternalSkill(root, ".codex/skills", firstExternalRoot, {
      skillId: "external-race",
    });

    const inspection = await inspectLegacyHarnessEntries(state);
    const target = path.join(root, ".codex/skills/external-race");
    await rm(target);
    await linkTargetToExternalSkill(root, ".codex/skills", secondExternalRoot, {
      skillId: "external-race",
    });

    await expect(
      importLegacyHarnessEntries(state, inspection.compatible, {
        normalizeCopies: true,
      })
    ).rejects.toThrow(/changed after review/i);

    expect(await readlink(target)).toContain("other-external-skills");
  });

  it("keeps existing active kits when importing extra entries in a managed target", async () => {
    const root = await createFixtureRepo(["existing-skill", "extra-skill"]);
    const state = await createTwoTargetState(root);
    const graph = await createOrUpdateKit(state, {
      name: "existing",
      skillIds: ["existing-skill"],
    });
    const applied = await applySelection(
      { ...state, graph },
      {
        kitIds: ["existing"],
        targetPath: "./.codex/skills",
      }
    );
    const activeState = { ...state, graph: applied.graph };
    await linkHarnessSkill(root, ".codex/skills", "extra-skill");

    const inspection = await inspectLegacyHarnessEntries(activeState, {
      includeManagedTargets: true,
    });
    const result = await importLegacyHarnessEntries(
      activeState,
      inspection.compatible,
      { mergeExistingActivation: true }
    );

    expect(countLegacyReviewItems(inspection)).toBe(1);
    await expectActivation(
      { ...activeState, graph: result.graph },
      "./.codex/skills",
      {
        kitIds: ["existing", "legacy-kit-codex-only"],
        skillIds: ["existing-skill", "extra-skill"],
      }
    );
  });
});

async function createFixtureRepo(skillIds: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-legacy-"));
  for (const skillId of skillIds) {
    await writeSourceSkill(root, skillId, {
      description: `Use when testing ${skillId}.`,
    });
  }
  return root;
}

async function createTwoTargetState(root: string): Promise<WorkspaceState> {
  const state = await scanRepo(root);
  const preferences = {
    ...state.preferences,
    harness: {
      ...state.preferences.harness,
      name: "codex" as const,
      target_path: "./.codex/skills",
    },
    default_harnesses: [
      { name: "codex" as const, target_path: "./.codex/skills" },
      { name: "claude" as const, target_path: "./.claude/skills" },
    ],
    supported_harnesses: [
      { name: "codex" as const, target_path: "./.codex/skills" },
      { name: "claude" as const, target_path: "./.claude/skills" },
    ],
  };
  await savePreferences(state.paths, preferences);
  return { ...state, preferences };
}

async function expectActivation(
  state: WorkspaceState,
  targetPath: string,
  expected: { kitIds: string[]; skillIds: string[] }
): Promise<void> {
  const activation = await getCurrentActivation(state, targetPath);
  expect(activation.activeKitIds).toEqual(expected.kitIds);
  expect(activation.managedSkillIds).toEqual(expected.skillIds);
}

async function linkHarnessSkill(
  root: string,
  targetDir: string,
  skillId: string
): Promise<void> {
  const target = path.join(root, targetDir, skillId);
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(
    path.relative(
      path.dirname(target),
      path.join(root, ".agents/skills", skillId)
    ),
    target,
    "dir"
  );
}

async function linkTargetToExternalSkill(
  root: string,
  targetDir: string,
  externalRoot: string,
  options: { skillId: string }
): Promise<void> {
  const target = path.join(root, targetDir, options.skillId);
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(
    path.relative(
      path.dirname(target),
      path.join(externalRoot, options.skillId)
    ),
    target,
    "dir"
  );
}

async function writeSourceSkill(
  root: string,
  skillId: string,
  options: { description: string; body?: string }
): Promise<void> {
  await writeSkill(path.join(root, ".agents/skills"), skillId, options);
}

async function writeTargetSkill(
  root: string,
  targetDir: string,
  skillId: string,
  options: { description: string; body?: string }
): Promise<void> {
  await writeSkill(path.join(root, targetDir), skillId, options);
}

async function writeSkill(
  skillsRoot: string,
  skillId: string,
  options: { description: string; body?: string }
): Promise<void> {
  const dir = path.join(skillsRoot, skillId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${skillId}
description: "${options.description}"
---

${options.body ?? `# ${skillId}\n`}
`,
    "utf8"
  );
}
