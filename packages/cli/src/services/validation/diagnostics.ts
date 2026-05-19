import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { SkillRecord } from "../../types";

export type SkillIssueSeverity = "error" | "warning";

export interface SkillValidationIssue {
  severity: SkillIssueSeverity;
  skillId?: string;
  message: string;
  detail?: string;
}

export interface SourceInventoryCheck {
  status: "ok" | "warning";
  command: string;
  message: string;
  skillCount?: number;
}

export interface SkillScanDiagnostics {
  skills: SkillRecord[];
  sourceInventory: SourceInventoryCheck;
  issues: SkillValidationIssue[];
}

const SOURCE_INVENTORY_COMMAND = "local ./.agents/skills scan";

export async function runSourceInventoryCheck(
  root: string
): Promise<SourceInventoryCheck> {
  const sourceSkillsDir = path.join(root, ".agents/skills");
  const sourceDir = await stat(sourceSkillsDir).catch(() => undefined);
  if (!sourceDir?.isDirectory()) {
    return {
      status: "warning",
      command: SOURCE_INVENTORY_COMMAND,
      message: "Local source library ./.agents/skills was not found.",
    };
  }

  const entries = await readdir(sourceSkillsDir, { withFileTypes: true });
  const skillCount = entries.filter(
    (entry) => !entry.name.startsWith(".") && entry.isDirectory()
  ).length;

  return {
    status: "ok",
    command: SOURCE_INVENTORY_COMMAND,
    message: `Local source library listed ${skillCount} skills.`,
    skillCount,
  };
}

export function collectSkillValidationIssues(
  skills: SkillRecord[],
  sourceInventory?: SourceInventoryCheck
): SkillValidationIssue[] {
  const issues: SkillValidationIssue[] = [];

  for (const skill of skills) {
    if (skill.status === "missing_skill_md") {
      issues.push({
        severity: "error",
        skillId: skill.id,
        message: "Missing SKILL.md",
        detail: skill.path,
      });
      continue;
    }

    if (skill.status === "missing_description") {
      issues.push({
        severity: "warning",
        skillId: skill.id,
        message: "Missing description in SKILL.md frontmatter",
      });
    }

    if (!/^[a-z0-9][a-z0-9._-]*$/.test(skill.id)) {
      issues.push({
        severity: "warning",
        skillId: skill.id,
        message: "Skill folder name is not a simple skill id",
      });
    }
  }

  for (const duplicate of findDuplicateNames(skills)) {
    issues.push({
      severity: "warning",
      message: "Duplicate skill display name",
      detail: duplicate.join(", "),
    });
  }

  if (
    sourceInventory?.status === "ok" &&
    sourceInventory.skillCount !== undefined &&
    sourceInventory.skillCount !== skills.length
  ) {
    issues.push({
      severity: "warning",
      message: "Source inventory count differs from local skill scan",
      detail: `inventory=${sourceInventory.skillCount}, local=${skills.length}`,
    });
  }

  return issues;
}

export function createSkillScanDiagnostics(input: {
  skills: SkillRecord[];
  sourceInventory: SourceInventoryCheck;
}): SkillScanDiagnostics {
  return {
    skills: input.skills,
    sourceInventory: input.sourceInventory,
    issues: collectSkillValidationIssues(input.skills, input.sourceInventory),
  };
}

export function formatSkillScanDiagnostics(
  diagnostics: SkillScanDiagnostics,
  options: {
    includeRules?: boolean;
    maxIssues?: number;
  } = {}
): string {
  const errorCount = countIssues(diagnostics.issues, "error");
  const warningCount = countIssues(diagnostics.issues, "warning");
  const lines: string[] = [];

  if (options.includeRules) {
    lines.push(
      "Rules:",
      "- read ./.agents/skills as the source library",
      "- write metadata under ./.agents/skills-kit",
      "- preview managed harness links before changing them",
      ""
    );
  }

  lines.push(
    `Source inventory: ${diagnostics.sourceInventory.message}`,
    `Validation: ${diagnostics.skills.length} skills, ${errorCount} errors, ${warningCount} warnings`
  );

  if (diagnostics.issues.length > 0) {
    const maxIssues = options.maxIssues ?? 6;
    lines.push("", ...diagnostics.issues.slice(0, maxIssues).map(formatIssue));

    if (diagnostics.issues.length > maxIssues) {
      lines.push(`... ${diagnostics.issues.length - maxIssues} more issues`);
    }
  }

  return lines.join("\n");
}

export function hasBlockingSkillIssues(
  diagnostics: SkillScanDiagnostics
): boolean {
  return diagnostics.issues.some((issue) => issue.severity === "error");
}

function countIssues(
  issues: SkillValidationIssue[],
  severity: SkillIssueSeverity
): number {
  return issues.filter((issue) => issue.severity === severity).length;
}

function formatIssue(issue: SkillValidationIssue): string {
  const marker = issue.severity === "error" ? "error" : "warn";
  const subject = issue.skillId ? `${issue.skillId}: ` : "";
  const detail = issue.detail ? ` (${issue.detail})` : "";
  return `${marker}: ${subject}${issue.message}${detail}`;
}

function findDuplicateNames(skills: SkillRecord[]): string[][] {
  const byName = new Map<string, SkillRecord[]>();

  for (const skill of skills) {
    const normalizedName = skill.name.trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }
    const matches = byName.get(normalizedName) ?? [];
    matches.push(skill);
    byName.set(normalizedName, matches);
  }

  return [...byName.values()]
    .filter((matches) => matches.length > 1)
    .map((matches) => matches.map((skill) => skill.id).toSorted());
}
