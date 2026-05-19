import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applySelection, createOrUpdateKit, scanRepo } from "../core/commands";
import {
  formatUninstallPlan,
  planUninstall,
  uninstallSkillsKit,
} from "../services/lifecycle/uninstall";

describe("skills-kit uninstall", () => {
  it("removes managed links, metadata, and exact package.json traces", async () => {
    const root = await createFixtureRepo();
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "example",
          scripts: {
            test: "vitest",
            skills: "skills-kit",
            other: "echo keep",
          },
          devDependencies: {
            "@skills-kit/cli": "^1.0.0",
            vitest: "^4.0.0",
          },
        },
        null,
        2
      )}\n`
    );

    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const plan = await planUninstall(root);
    expect(plan.manifests).toHaveLength(1);
    expect(plan.manifests[0]?.removeSymlinks).toHaveLength(1);
    expect(plan.packageJson?.removeScripts).toEqual(["skills"]);
    expect(plan.packageJson?.removeDependencySections).toEqual([
      "devDependencies",
    ]);

    const result = await uninstallSkillsKit(root);
    expect(result).toMatchObject({
      scope: "all",
      removedSymlinks: 1,
      skipped: 0,
      clearedManifests: 1,
      removedMetadata: true,
      removedPackageScripts: 1,
      removedPackageDependencies: 1,
    });

    await expect(
      lstat(path.join(root, ".codex/skills/frontend-design"))
    ).rejects.toThrow();
    await expect(
      lstat(path.join(root, ".agents/skills-kit"))
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(root, ".agents/skills/frontend-design/SKILL.md"),
        "utf8"
      )
    ).resolves.toContain("frontend-design");

    const packageJson = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8")
    ) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.scripts).toEqual({
      test: "vitest",
      other: "echo keep",
    });
    expect(packageJson.devDependencies).toEqual({
      vitest: "^4.0.0",
    });
  });

  it("can remove settings without disconnecting harness links", async () => {
    const root = await createFixtureRepo();
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "example",
          scripts: { skills: "skills-kit" },
          devDependencies: { "@skills-kit/cli": "^1.0.0" },
        },
        null,
        2
      )}\n`
    );
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const result = await uninstallSkillsKit(root, { scope: "settings" });

    expect(result).toMatchObject({
      scope: "settings",
      removedSymlinks: 0,
      removedMetadata: true,
      removedPackageScripts: 1,
      removedPackageDependencies: 1,
    });
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);
    await expect(
      lstat(path.join(root, ".agents/skills-kit"))
    ).rejects.toThrow();
  });

  it("can disconnect harnesses without removing settings", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const plan = await planUninstall(root, { scope: "harnesses" });
    const preview = formatUninstallPlan(plan);
    const result = await uninstallSkillsKit(root, { scope: "harnesses" });

    expect(preview).toContain("disconnect harnesses");
    expect(preview).toContain("Managed links:");
    expect(preview).not.toContain("frontend-design");
    expect(result).toMatchObject({
      scope: "harnesses",
      removedSymlinks: 1,
      clearedManifests: 1,
      removedMetadata: false,
    });
    await expect(
      lstat(path.join(root, ".codex/skills/frontend-design"))
    ).rejects.toThrow();
    expect(
      (await lstat(path.join(root, ".agents/skills-kit"))).isDirectory()
    ).toBe(true);
  });

  it("does not remove unmanaged real harness entries", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const target = path.join(root, ".codex/skills/frontend-design");
    await import("node:fs/promises").then(({ rm }) =>
      rm(target, { force: true })
    );
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "note.txt"), "keep", "utf8");

    const result = await uninstallSkillsKit(root);
    expect(result.removedSymlinks).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it("does not remove managed entries that were retargeted by someone else", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const target = path.join(root, ".codex/skills/frontend-design");
    await import("node:fs/promises").then(({ rm }) => rm(target));
    await symlink("../../external/frontend-design", target, "dir");

    const plan = await planUninstall(root, { scope: "harnesses" });
    expect(plan.manifests[0]?.removeSymlinks).toEqual([]);
    expect(plan.manifests[0]?.skipped).toMatchObject([
      {
        path: target,
        reason: "target symlink points to ../../external/frontend-design",
      },
    ]);

    const result = await uninstallSkillsKit(root, { scope: "harnesses" });
    expect(result.removedSymlinks).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await readlink(target)).toBe("../../external/frontend-design");
  });

  it("formats a summary-only uninstall preview", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    try {
      const preview = formatUninstallPlan(await planUninstall(root));
      expect(preview).toContain("Managed links:");
      expect(preview).toContain("1");
      expect(preview).not.toContain("frontend-design");
    } finally {
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }
  });
});

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-uninstall-"));
  await writeSkill(root, "frontend-design", "Use when building frontend UI.");
  await mkdir(path.join(root, ".codex/skills"), { recursive: true });
  await symlink(
    "../../.agents/skills/frontend-design",
    path.join(root, ".codex/skills/unmanaged-link"),
    "dir"
  );
  return root;
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
