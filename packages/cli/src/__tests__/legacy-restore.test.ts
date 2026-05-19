import { lstat, mkdtemp, writeFile } from "node:fs/promises";
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
  planLegacyRestore,
  restoreLegacySetup,
} from "../services/harnesses/legacy-restore";

describe("legacy setup restore", () => {
  it("restores configured targets from legacy kits", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const withLegacy = await createOrUpdateKit(state, {
      name: "legacy-kit-codex-only",
      skillIds: ["frontend-design"],
    });
    const graph = await createOrUpdateKit(
      { ...state, graph: withLegacy },
      {
        name: "current",
        skillIds: ["release-manager"],
      }
    );
    const active = await applySelection(
      { ...state, graph },
      {
        kitIds: ["current"],
        targetPath: "./.codex/skills",
      }
    );

    const plan = await planLegacyRestore({
      ...state,
      graph: active.graph,
    });
    const result = await restoreLegacySetup({
      ...state,
      graph: active.graph,
    });

    expect(plan.targets[0]?.legacyKitIds).toEqual(["legacy-kit-codex-only"]);
    expect(result).toMatchObject({
      restoredTargets: 1,
      created: 1,
      removed: 1,
    });
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);
    await expect(
      lstat(path.join(root, ".codex/skills/release-manager"))
    ).rejects.toThrow();
  });

  it("can disconnect manifests after restoring links", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "legacy-kit-codex-only",
      skillIds: ["frontend-design"],
    });

    const result = await restoreLegacySetup(
      { ...state, graph },
      { disconnectAfter: true }
    );
    const activation = await getCurrentActivation(
      { ...state, graph: result.graph },
      "./.codex/skills"
    );

    expect(result.disconnectedTargets).toBe(1);
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);
    expect(activation.managedSkillIds).toEqual([]);
    expect(activation.activeKitIds).toEqual([]);
  });

  it("reports conflicts and leaves target entries untouched", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "legacy-kit-codex-only",
      skillIds: ["frontend-design"],
    });
    const blockedTarget = path.join(root, ".codex/skills/frontend-design");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(blockedTarget, { recursive: true })
    );

    const plan = await planLegacyRestore({ ...state, graph });

    expect(plan.targets[0]?.plan?.conflicts).toMatchObject([
      {
        skill_id: "frontend-design",
        reason: "target exists and is not a symlink",
      },
    ]);
    await expect(restoreLegacySetup({ ...state, graph })).rejects.toThrow(
      /conflicts/i
    );
    expect((await lstat(blockedTarget)).isDirectory()).toBe(true);
  });
});

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-restore-"));
  await writeSkill(root, "frontend-design", "Use when building frontend UI.");
  await writeSkill(root, "release-manager", "Use when preparing releases.");
  return root;
}

async function writeSkill(
  root: string,
  id: string,
  description: string
): Promise<void> {
  const dir = path.join(root, ".agents/skills", id);
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(dir, { recursive: true })
  );
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
