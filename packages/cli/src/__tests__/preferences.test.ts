import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveWorkspacePaths } from "../utils/paths";
import {
  createDefaultPackageJsonPreferences,
  createDefaultStartupReviewPreferences,
  defaultTargetPathForHarness,
  detectExistingHarnessTargets,
  loadPreferences,
} from "../config/preferences";

describe("harness preferences", () => {
  it("uses native project skill folders for built-in harnesses", () => {
    expect(defaultTargetPathForHarness("codex")).toBe("./.codex/skills");
    expect(defaultTargetPathForHarness("claude")).toBe("./.claude/skills");
    expect(defaultTargetPathForHarness("gemini")).toBe("./.gemini/skills");
    expect(defaultTargetPathForHarness("cursor")).toBe("./.cursor/skills");
  });

  it("detects existing built-in harness skill folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-prefs-"));
    await mkdir(path.join(root, ".gemini/skills"), { recursive: true });
    await mkdir(path.join(root, ".cursor/skills"), { recursive: true });

    await expect(detectExistingHarnessTargets(root)).resolves.toEqual([
      { name: "gemini", target_path: "./.gemini/skills" },
      { name: "cursor", target_path: "./.cursor/skills" },
    ]);
  });

  it("defaults package.json shortcut preferences to ask with the skills script", async () => {
    expect(createDefaultPackageJsonPreferences()).toEqual({
      offer: "ask",
      script_name: "skills",
      script_command: "skills-kit",
      dependency_spec: "^1.0.0",
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-prefs-"));
    const preferences = await loadPreferences(resolveWorkspacePaths(root));

    expect(preferences.package_json).toEqual({
      offer: "ask",
      script_name: "skills",
      script_command: "skills-kit",
      dependency_spec: "^1.0.0",
    });
    expect(createDefaultStartupReviewPreferences()).toEqual({
      offer: "ask",
    });
    expect(preferences.startup_review).toEqual({
      offer: "ask",
    });
  });
});
