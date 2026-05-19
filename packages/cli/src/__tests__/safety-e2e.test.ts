import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applySelection,
  createOrUpdateKit,
  deactivateSelection,
  getCurrentActivation,
  planSelection,
  scanRepo,
} from "../core/commands";
import { applySymlinkPlan } from "../services/harnesses/symlinks";
import type { SkillsGraph } from "../types";
import type { WorkspaceState } from "../core/workspace";

describe("safety end-to-end workflow", () => {
  it("applies, changes, and clears focused kits without touching source skills", async () => {
    const root = await createFixtureRepo();
    const sourceBefore = await readSourceFiles(root);
    const state = await scanRepo(root);
    const graph = await createKits(state);

    const focused = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui", "review"],
        targetPath: "./.codex/skills",
      }
    );

    await expectSymlinkToSource(root, "frontend-design");
    await expectSymlinkToSource(root, "webapp-testing");
    await expectMissing(path.join(root, ".codex/skills/release-manager"));
    expect(focused.created).toBe(2);
    expect(await readSourceFiles(root)).toEqual(sourceBefore);

    const active = await getCurrentActivation(
      { ...state, graph: focused.graph },
      "./.codex/skills"
    );
    expect(active.activeKitIds).toEqual(["review", "ui"]);
    expect(active.managedSkillIds).toEqual([
      "frontend-design",
      "webapp-testing",
    ]);

    const releaseOnly = await applySelection(
      { ...state, graph: focused.graph },
      {
        kitIds: ["release"],
        targetPath: "./.codex/skills",
      }
    );

    await expectMissing(path.join(root, ".codex/skills/frontend-design"));
    await expectMissing(path.join(root, ".codex/skills/webapp-testing"));
    await expectSymlinkToSource(root, "release-manager");
    expect(releaseOnly.created).toBe(1);
    expect(releaseOnly.removed).toBe(2);
    expect(await readSourceFiles(root)).toEqual(sourceBefore);

    const cleared = await deactivateSelection(
      { ...state, graph: releaseOnly.graph },
      {
        all: true,
        targetPath: "./.codex/skills",
      }
    );

    await expectMissing(path.join(root, ".codex/skills/release-manager"));
    expect(cleared.removed).toBe(1);
    expect(await readSourceFiles(root)).toEqual(sourceBefore);

    const finalActive = await getCurrentActivation(
      { ...state, graph: cleared.graph },
      "./.codex/skills"
    );
    expect(finalActive.activeKitIds).toEqual([]);
    expect(finalActive.managedSkillIds).toEqual([]);
  });

  it("does not partially apply a stale plan when the target changes after preview", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createKits(state);
    const focused = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );
    const nextState = { ...state, graph: focused.graph };
    const releasePlan = await planSelection(nextState, {
      kitIds: ["release"],
      targetPath: "./.codex/skills",
    });

    await mkdir(path.join(root, ".codex/skills/release-manager"), {
      recursive: true,
    });

    await expect(
      applySymlinkPlan(
        {
          root: nextState.paths.root,
          graph: nextState.graph,
          preferences: nextState.preferences,
          skillIds: releasePlan.selected_skill_ids,
          activeSkillIds: releasePlan.active_skill_ids,
          kitIds: releasePlan.active_kit_ids,
          targetPath: "./.codex/skills",
        },
        releasePlan
      )
    ).rejects.toThrow(/changed after planning/i);

    await expectSymlinkToSource(root, "frontend-design");
    const blockedTarget = await lstat(
      path.join(root, ".codex/skills/release-manager")
    );
    expect(blockedTarget.isDirectory()).toBe(true);
  });
});

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-e2e-"));
  await writeSkill(root, "frontend-design", "Use when building frontend UI.");
  await writeSkill(root, "webapp-testing", "Use when testing web apps.");
  await writeSkill(root, "release-manager", "Use when preparing releases.");
  return root;
}

async function createKits(state: WorkspaceState): Promise<SkillsGraph> {
  const withUi = await createOrUpdateKit(state, {
    name: "ui",
    skillIds: ["frontend-design"],
  });
  const withReview = await createOrUpdateKit(
    { ...state, graph: withUi },
    {
      name: "review",
      skillIds: ["frontend-design", "webapp-testing"],
    }
  );
  return createOrUpdateKit(
    { ...state, graph: withReview },
    {
      name: "release",
      skillIds: ["release-manager"],
    }
  );
}

async function writeSkill(
  root: string,
  id: string,
  description: string
): Promise<void> {
  const dir = path.join(root, ".agents/skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${id}
description: "${description}"
---

# ${id}
`,
    "utf8"
  );
}

async function readSourceFiles(root: string): Promise<Record<string, string>> {
  const skillIds = ["frontend-design", "release-manager", "webapp-testing"];
  const entries = await Promise.all(
    skillIds.map(async (skillId) => [
      skillId,
      await readFile(
        path.join(root, ".agents/skills", skillId, "SKILL.md"),
        "utf8"
      ),
    ])
  );
  return Object.fromEntries(entries);
}

async function expectSymlinkToSource(
  root: string,
  skillId: string
): Promise<void> {
  const targetPath = path.join(root, ".codex/skills", skillId);
  expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
  expect(await readlink(targetPath)).toContain(`.agents/skills/${skillId}`);
}

async function expectMissing(targetPath: string): Promise<void> {
  await expect(lstat(targetPath)).rejects.toThrow();
}
