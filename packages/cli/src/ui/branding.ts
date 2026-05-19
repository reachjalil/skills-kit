import { styleText } from "node:util";

import type { WorkspaceState } from "../core/workspace";

type AnsiColor =
  | "amber"
  | "cream"
  | "green"
  | "ink"
  | "muted"
  | "red"
  | "reset"
  | "yellow";

const ANSI: Record<AnsiColor, string> = {
  amber: "\x1b[38;5;220m",
  cream: "\x1b[38;5;230m",
  green: "\x1b[38;5;48m",
  ink: "\x1b[1;38;5;15m",
  muted: "\x1b[38;5;244m",
  red: "\x1b[38;5;203m",
  reset: "\x1b[0m",
  yellow: "\x1b[38;5;226m",
};
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function formatSplash(
  options: { color?: boolean; columns?: number } = {}
): string {
  const columns = options.columns ?? process.stdout.columns ?? 80;
  const color = options.color ?? shouldUseColor();
  return columns < 72 ? compactSplash(color) : fullSplash(color);
}

export function formatWorkspaceSnapshot(input: {
  state: WorkspaceState;
  activeLinks: number;
  targetDir: string;
  targetStatuses?: string[];
}): string {
  const groupedSkillIds = new Set(
    input.state.graph.kits.flatMap((kit) => kit.skill_ids)
  );
  const ungrouped = input.state.graph.skills.length - groupedSkillIds.size;

  const lines = [
    formatSnapshotField(
      "Source",
      `./.agents/skills (${formatCount(input.state.graph.skills.length, "skill")})`
    ),
    formatSnapshotField("Metadata", "./.agents/skills-kit"),
    formatSnapshotField(
      "Kits",
      `${input.state.graph.kits.length} saved (${formatCount(ungrouped, "ungrouped skill")})`
    ),
    formatSnapshotField(
      "Active",
      formatCount(input.activeLinks, "managed link")
    ),
  ];

  if (input.targetStatuses?.length) {
    lines.push(
      "",
      "Targets:",
      ...input.targetStatuses.map((status) => `- ${status}`)
    );
  }

  return lines.join("\n");
}

export function formatMenuTitle(input: {
  kitCount: number;
  skillCount: number;
  activeLinkCount: number;
}): string {
  return `Skill switchboard - ${formatCount(input.kitCount, "kit")}, ${formatCount(input.skillCount, "skill")}, ${input.activeLinkCount} active ${pluralize(input.activeLinkCount, "skill")}`;
}

function formatCount(count: number, singular: string): string {
  return `${count} ${pluralize(count, singular)}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function formatSnapshotField(label: string, value: string): string {
  return `${padVisible(formatSummaryLabel(label), 9)} ${value}`;
}

function formatSummaryLabel(label: string): string {
  const value = `${label}:`;
  return shouldUseColor() ? styleText(["bold", "underline"], value) : value;
}

function compactSplash(color: boolean): string {
  const logo = renderGraphMark(color);
  const wordmark = [
    paint("green", "skills-kit", color),
    paint("muted", "repo-local skill switchboard", color),
    paint("muted", "for local agent skill libraries", color),
  ];

  return zipColumns(logo, wordmark).join("\n");
}

function fullSplash(color: boolean): string {
  const logo = renderGraphMark(color);
  const wordmark = [
    paint("green", "skills-kit", color),
    paint("muted", "repo-local skill switchboard", color),
    paint("muted", "for local agent skill libraries", color),
  ];

  return zipColumns(logo, wordmark).join("\n");
}

function renderGraphMark(color: boolean): string[] {
  return [
    ` ${node("green", "o", color)}${line("-----", color)}${node("yellow", "o", color)}`,
    ` ${line("| \\ / |", color)}`,
    ` ${line("|  ", color)}${node("red", "o", color)}${line("  |", color)}`,
    ` ${line("| / \\ |", color)}`,
    ` ${node("cream", "o", color)}${line("-----", color)}${node("green", "o", color)}`,
  ];
}

function zipColumns(left: string[], right: string[]): string[] {
  const lineCount = Math.max(left.length, right.length);
  return Array.from({ length: lineCount }, (_, index) => {
    const leftText = left[index] ?? "";
    const lineText = right[index] ?? "";
    return `${padVisible(leftText, 12)}${lineText}`;
  });
}

function padVisible(value: string, width: number): string {
  const visibleLength = value.replace(ANSI_PATTERN, "").length;
  return `${value}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function shouldUseColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function line(value: string, color: boolean): string {
  return paint("muted", value, color);
}

function node(tone: AnsiColor, value: string, color: boolean): string {
  return paint(tone, value, color);
}

function paint(tone: AnsiColor, value: string, color: boolean): string {
  if (!color) {
    return value;
  }
  return `${ANSI[tone]}${value}${ANSI.reset}`;
}

function formatRepoLocalPath(root: string, targetPath: string): string {
  if (!targetPath.startsWith(root)) {
    return targetPath;
  }

  const relativePath = targetPath.slice(root.length).replace(/^\/+/, "");
  return relativePath ? `./${relativePath}` : ".";
}
