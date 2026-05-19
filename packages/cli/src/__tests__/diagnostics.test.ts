import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectSkillValidationIssues,
  formatSkillScanDiagnostics,
  runSourceInventoryCheck,
  type SourceInventoryCheck,
} from "../services/validation/diagnostics";
import type { SkillRecord } from "../types";

describe("skill diagnostics", () => {
  it("reports missing skill files and missing descriptions", () => {
    const issues = collectSkillValidationIssues(
      [
        makeSkill({ id: "good-skill", status: "valid" }),
        makeSkill({ id: "missing-file", status: "missing_skill_md" }),
        makeSkill({ id: "missing-description", status: "missing_description" }),
      ],
      okSourceInventory(3)
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          skillId: "missing-file",
          message: "Missing SKILL.md",
        }),
        expect.objectContaining({
          severity: "warning",
          skillId: "missing-description",
          message: "Missing description in SKILL.md frontmatter",
        }),
      ])
    );
  });

  it("formats a compact scan report with rules", () => {
    const skills = [makeSkill({ id: "frontend-design", status: "valid" })];
    const report = formatSkillScanDiagnostics(
      {
        skills,
        sourceInventory: okSourceInventory(1),
        issues: [],
      },
      { includeRules: true }
    );

    expect(report).toContain("Rules:");
    expect(report).toContain("Local source library listed 1 skills");
    expect(report).toContain("Validation: 1 skills, 0 errors, 0 warnings");
  });

  it("does not count source inventory notices as skill validation warnings", () => {
    const issues = collectSkillValidationIssues(
      [makeSkill({ id: "frontend-design", status: "valid" })],
      {
        status: "warning",
        command: "local ./.agents/skills scan",
        message: "Local source library ./.agents/skills was not found.",
      }
    );

    expect(issues).toEqual([]);
  });

  it("counts local source skill folders without invoking an external skills CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-diag-"));
    await writeSkill(root, "frontend-design");
    await writeSkill(root, "release-manager");

    await expect(runSourceInventoryCheck(root)).resolves.toMatchObject({
      status: "ok",
      command: "local ./.agents/skills scan",
      message: "Local source library listed 2 skills.",
      skillCount: 2,
    });
  });
});

function okSourceInventory(skillCount: number): SourceInventoryCheck {
  return {
    status: "ok",
    command: "local ./.agents/skills scan",
    message: `Local source library listed ${skillCount} skills.`,
    skillCount,
  };
}

async function writeSkill(root: string, id: string): Promise<void> {
  const dir = path.join(root, ".agents/skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `# ${id}\n`, "utf8");
}

function makeSkill(input: Pick<SkillRecord, "id" | "status">): SkillRecord {
  return {
    id: input.id,
    name: input.id,
    description: input.status === "missing_description" ? "" : "Description",
    path: `./.agents/skills/${input.id}`,
    kit_ids: [],
    tags: [],
    notes: "",
    status: input.status,
    checksum: "",
    last_scanned_at: "",
    last_reviewed_at: "",
    last_updated_at: "",
    last_activated_at: "",
  };
}
