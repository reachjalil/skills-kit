import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applySelection,
  createOrUpdateKit,
  forgetActivationState,
  scanRepo,
} from "../core/commands";
import {
  canReapplyHarnessIssue,
  inspectHarnessHealth,
} from "../services/harnesses/health";

describe("harness health", () => {
  it("does not warn before a harness has active managed state", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);

    const report = await inspectHarnessHealth(state);

    expect(report.issues).toEqual([]);
  });

  it("detects an active harness target that was removed", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    const applied = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    await rm(path.join(root, ".codex/skills"), {
      recursive: true,
      force: true,
    });

    const report = await inspectHarnessHealth({
      ...state,
      graph: applied.graph,
    });
    const issue = report.issues[0];

    expect(report.issues).toHaveLength(1);
    expect(issue).toMatchObject({
      kind: "missing-active-target",
      targetExists: false,
    });
    expect(issue?.plan?.create).toHaveLength(1);
    expect(issue && canReapplyHarnessIssue(issue)).toBe(true);
  });

  it("detects missing managed links inside an existing active harness", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design", "release-manager"],
    });
    const applied = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );

    await rm(path.join(root, ".codex/skills/frontend-design"), {
      recursive: true,
      force: true,
    });

    const report = await inspectHarnessHealth({
      ...state,
      graph: applied.graph,
    });
    const issue = report.issues[0];

    expect(report.issues).toHaveLength(1);
    expect(issue).toMatchObject({
      kind: "drifted-active-target",
      targetExists: true,
    });
    expect(issue?.plan?.create.map((action) => action.skill_id)).toEqual([
      "frontend-design",
    ]);
  });

  it("can forget active state without recreating a missing harness target", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const graph = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
    });
    const applied = await applySelection(
      { ...state, graph },
      {
        kitIds: ["ui"],
        targetPath: "./.codex/skills",
      }
    );
    await rm(path.join(root, ".codex/skills"), {
      recursive: true,
      force: true,
    });

    await forgetActivationState(
      { ...state, graph: applied.graph },
      "./.codex/skills"
    );

    const report = await inspectHarnessHealth({
      ...state,
      graph: applied.graph,
    });

    expect(report.issues).toEqual([]);
    await expect(
      import("node:fs/promises").then(({ lstat }) =>
        lstat(path.join(root, ".codex/skills"))
      )
    ).rejects.toThrow();
  });
});

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-health-"));
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
