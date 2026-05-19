import {
  lstat,
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
  planSelection,
  scanRepo,
} from "../core/commands";
import { applySymlinkPlan } from "../services/harnesses/symlinks";

describe("managed symlink apply", () => {
  it("adds and removes only managed symlinks in the harness target", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    const result = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    const target = path.join(root, ".codex/skills/frontend-design");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    expect(await readlink(target)).toContain(".agents/skills/frontend-design");
    expect(result.created).toBe(1);

    const updatedGraph = await createOrUpdateKit(
      { ...state, graph: result.graph },
      {
        name: "ui",
        skillIds: [],
      }
    );
    const second = await applySelection(
      { ...state, graph: updatedGraph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    await expect(lstat(target)).rejects.toThrow();
    expect(second.removed).toBe(1);
  });

  it("can preview and deactivate one active kit while preserving another", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    }).then((uiGraph) =>
      createOrUpdateKit(
        { ...state, graph: uiGraph },
        {
          name: "release",
          skillIds: ["release-manager"],
        }
      )
    );

    const plan = await planSelection(
      { ...state, graph },
      {
        kitIds: ["ui", "release"],
        targetPath: "./.codex/skills",
      }
    );
    expect(plan.create.map((action) => action.skill_id).toSorted()).toEqual([
      "frontend-design",
      "release-manager",
    ]);

    const applied = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui", "release"],
        targetPath: "./.codex/skills",
      }
    );
    const deactivated = await deactivateSelection(
      { ...state, graph: applied.graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    await expect(
      lstat(path.join(root, ".codex/skills/frontend-design"))
    ).rejects.toThrow();
    expect(
      (
        await lstat(path.join(root, ".codex/skills/release-manager"))
      ).isSymbolicLink()
    ).toBe(true);
    expect(deactivated.removed).toBe(1);
    const manifest = await readFile(
      path.join(root, ".agents/skills-kit/manifests/codex-skills.toml"),
      "utf8"
    );
    expect(manifest).toContain("active_kit_ids");
    expect(manifest).toContain('"release"');
    await expect(
      lstat(path.join(root, ".codex/skills/.skills-kit-managed.toml"))
    ).rejects.toThrow();
  });

  it("supports update, add, and remove kit modes against the same harness", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    }).then((uiGraph) =>
      createOrUpdateKit(
        { ...state, graph: uiGraph },
        {
          name: "release",
          skillIds: ["release-manager"],
        }
      )
    );

    const updated = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
        mode: "update",
      }
    );
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);

    const added = await applySelection(
      { ...state, graph: updated.graph },
      {
        kitIds: ["release"],
        targetPath: "./.codex/skills",
        mode: "add",
      }
    );
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);
    expect(
      (
        await lstat(path.join(root, ".codex/skills/release-manager"))
      ).isSymbolicLink()
    ).toBe(true);

    const removed = await deactivateSelection(
      { ...state, graph: added.graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );
    await expect(
      lstat(path.join(root, ".codex/skills/frontend-design"))
    ).rejects.toThrow();
    expect(
      (
        await lstat(path.join(root, ".codex/skills/release-manager"))
      ).isSymbolicLink()
    ).toBe(true);
    expect(removed.removed).toBe(1);
  });

  it("does not overwrite an unmanaged real directory", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.join(root, ".codex/skills/frontend-design"), {
        recursive: true,
      })
    );

    await expect(
      applySelection(
        { ...state, graph },
        {
          kitIds: ["ui"],
          targetPath: "./.codex/skills",
        }
      )
    ).rejects.toThrow(/conflicts/i);
  });

  it("refuses targets that resolve into .agents/skills", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    await import("node:fs/promises").then(({ mkdir, symlink }) =>
      mkdir(path.join(root, ".codex"), { recursive: true }).then(() =>
        symlink("../.agents/skills", path.join(root, ".codex/skills"), "dir")
      )
    );

    await expect(
      applySelection(
        { ...state, graph },
        {
          kitIds: ["ui"],
          targetPath: "./.codex/skills",
        }
      )
    ).rejects.toThrow(/source skill library/i);
  });

  it("refuses harness targets outside the repo", async () => {
    const root = await createFixtureRepo();
    const outsideRoot = await mkdtemp(
      path.join(os.tmpdir(), "skills-kit-outside-")
    );
    const state = await scanRepo(root);

    await expect(
      applySelection(state, {
        skillIds: ["frontend-design"],
        targetPath: path.join(outsideRoot, "skills"),
      })
    ).rejects.toThrow(/inside the repo/i);
  });

  it("refuses graph skill paths outside the repo", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = {
      ...state.graph,
      skills: state.graph.skills.map((skill) =>
        skill.id === "frontend-design"
          ? { ...skill, path: "../../outside-skill" }
          : skill
      ),
    };

    await expect(
      planSelection(
        { ...state, graph },
        {
          skillIds: ["frontend-design"],
          targetPath: "./.codex/skills",
        }
      )
    ).rejects.toThrow(/Skill path must stay inside the repo/i);
  });

  it("refuses unknown skills and kits instead of saving stale activation state", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);

    await expect(
      applySelection(state, {
        skillIds: ["missing-skill"],
        targetPath: "./.codex/skills",
      })
    ).rejects.toThrow(/Unknown skill id/);

    await expect(
      applySelection(state, {
        kitIds: ["missing-kit"],
        targetPath: "./.codex/skills",
      })
    ).rejects.toThrow(/Unknown skills-kit id/);

    await expect(
      createOrUpdateKit(state, {
        name: "bad-kit",
        skillIds: ["missing-skill"],
      })
    ).rejects.toThrow(/Unknown skill id/);
  });

  it("refuses harness targets that contain a full copied skill library", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    await copySkill(root, "frontend-design", ".cursor/skills");
    await copySkill(root, "release-manager", ".cursor/skills");

    await expect(
      applySelection(state, {
        skillIds: ["frontend-design"],
        targetPath: "./.cursor/skills",
      })
    ).rejects.toThrow(/full copied skill library/i);
  });

  it("does not remove a managed target that changes after planning", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    }).then((uiGraph) =>
      createOrUpdateKit(
        { ...state, graph: uiGraph },
        {
          name: "release",
          skillIds: ["release-manager"],
        }
      )
    );
    const applied = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );
    const nextState = { ...state, graph: applied.graph };
    const plan = await planSelection(nextState, {
      kitIds: ["release"],
      targetPath: "./.codex/skills",
    });

    const changedTarget = path.join(root, ".codex/skills/frontend-design");
    await import("node:fs/promises").then(({ mkdir, rm }) =>
      rm(changedTarget, { force: true }).then(() =>
        mkdir(changedTarget, { recursive: true })
      )
    );

    await expect(
      applySymlinkPlan(
        {
          root: nextState.paths.root,
          graph: nextState.graph,
          preferences: nextState.preferences,
          skillIds: plan.selected_skill_ids,
          activeSkillIds: plan.active_skill_ids,
          kitIds: plan.active_kit_ids,
          targetPath: "./.codex/skills",
        },
        plan
      )
    ).rejects.toThrow(/changed after planning/i);

    expect((await lstat(changedTarget)).isDirectory()).toBe(true);
    await expect(
      lstat(path.join(root, ".codex/skills/release-manager"))
    ).rejects.toThrow();
  });
});

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-symlink-"));
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

async function copySkill(
  root: string,
  skillId: string,
  targetDir: string
): Promise<void> {
  const target = path.join(root, targetDir, skillId);
  await import("node:fs/promises").then(({ cp, mkdir }) =>
    mkdir(path.dirname(target), { recursive: true }).then(() =>
      cp(path.join(root, ".agents/skills", skillId), target, {
        recursive: true,
      })
    )
  );
}
