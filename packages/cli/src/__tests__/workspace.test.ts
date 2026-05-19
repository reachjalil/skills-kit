import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createOrUpdateKit, scanRepo } from "../core/commands";

describe("workspace scanning", () => {
  it("requires local source skills before creating skills-kit metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-empty-"));

    await expect(scanRepo(root)).rejects.toThrow(
      /requires \.\/\.agents\/skills/
    );
  });

  it("creates repo-local skills-kit metadata without editing source skills", async () => {
    const root = await createFixtureRepo();
    const skillPath = path.join(
      root,
      ".agents/skills/frontend-design/SKILL.md"
    );
    const before = await readFile(skillPath, "utf8");

    const state = await scanRepo(root);
    const graphPath = path.join(root, ".agents/skills-kit/skills-graph.toml");
    const preferencesPath = path.join(
      root,
      ".agents/skills-kit/skills-preferences.toml"
    );

    expect(state.graph.skills).toHaveLength(2);
    expect(await readFile(skillPath, "utf8")).toBe(before);
    expect(await readFile(graphPath, "utf8")).toContain("[[skills]]");
    expect(await readFile(preferencesPath, "utf8")).toContain("target_path");
    expect(await readFile(preferencesPath, "utf8")).toContain(
      "[[default_harnesses]]"
    );
  });

  it("stores flexible skills-kits without forcing exclusive membership", async () => {
    const root = await createFixtureRepo();
    const state = await scanRepo(root);
    const withUi = await createOrUpdateKit(state, {
      name: "ui",
      skillIds: ["frontend-design"],
      reason: "Focus interface work",
      tags: ["frontend"],
    });
    const withReview = await createOrUpdateKit(
      { ...state, graph: withUi },
      {
        name: "review",
        skillIds: ["frontend-design", "quality-testing-strategy"],
      }
    );

    const frontend = withReview.skills.find(
      (skill) => skill.id === "frontend-design"
    );

    expect(frontend?.kit_ids).toEqual(["review", "ui"]);
    expect(withReview.kits.find((kit) => kit.id === "ui")).toMatchObject({
      skill_assignments: [
        {
          skill_id: "frontend-design",
          reason: "Focus interface work",
          tags: ["frontend"],
        },
      ],
    });
  });
});

async function createFixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-workspace-"));
  await writeSkill(
    root,
    "frontend-design",
    "Use when building polished frontend UI."
  );
  await writeSkill(
    root,
    "quality-testing-strategy",
    "Use when adding focused Vitest coverage."
  );
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
