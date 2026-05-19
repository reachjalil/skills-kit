import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("skills-kit cli", () => {
  it("prints standard root help for --help and -h", async () => {
    const root = await createFixtureRepo();

    const longHelp = await runCli(root, ["--help"]);
    const shortHelp = await runCli(root, ["-h"]);

    expect(longHelp.stdout).toContain("skills-kit");
    expect(longHelp.stdout).toContain("Usage:");
    expect(longHelp.stdout).toContain("skills-kit man");
    expect(longHelp.stdout).toContain("npx @skills-kit/cli doctor");
    expect(longHelp.stdout).toContain("--root <path>");
    expect(longHelp.stdout).toContain("--no-startup-review");
    expect(longHelp.stdout).toContain("Core rule:");
    expect(shortHelp.stdout).toBe(longHelp.stdout);
  });

  it("prints command help without running the command", async () => {
    const root = await createFixtureRepo();

    const updateHelp = await runCli(root, ["update", "--help"]);
    const applyHelp = await runCli(root, ["apply", "-h"]);
    const uninstallHelp = await runCli(root, ["uninstall", "help"]);
    const topicHelp = await runCli(root, ["help", "kit"]);
    const doctorHelp = await runCli(root, ["help", "doctor"]);

    expect(updateHelp.stdout).toContain("skills-kit update");
    expect(updateHelp.stdout).toContain("--dry-run, --plan");
    expect(applyHelp.stdout).toContain("skills-kit apply");
    expect(uninstallHelp.stdout).toContain('Type "delete" to confirm');
    expect(uninstallHelp.stdout).toContain("--scope <scope>");
    expect(topicHelp.stdout).toContain("skills-kit kit");
    expect(topicHelp.stdout).toContain("skills-kit kit list");
    expect(topicHelp.stdout).toContain("--description <text>");
    expect(doctorHelp.stdout).toContain("skills-kit doctor");
    expect(doctorHelp.stdout).toContain("active harness drift");
  });

  it("prints a detailed manual", async () => {
    const root = await createFixtureRepo();

    const result = await runCli(root, ["man"]);

    expect(result.stdout).toContain("skills-kit manual");
    expect(result.stdout).toContain("Mental model");
    expect(result.stdout).toContain("Normal workflow");
    expect(result.stdout).toContain("Safety model");
    expect(result.stdout).toContain("Uninstall behavior");
    expect(result.stdout).toContain("completion zsh");
  });

  it("prints zsh completion without requiring a skills repo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-empty-"));

    const result = await runCli(root, ["completion", "zsh"]);

    expect(result.stdout).toContain("#compdef skills-kit");
    expect(result.stdout).toContain("doctor:run a full repo health check");
    expect(result.stdout).toContain("--root");
    await expect(lstat(path.join(root, ".agents"))).rejects.toThrow();
  });

  it("lets --root override the environment root", async () => {
    const envRoot = await createFixtureRepo();
    const explicitRoot = await createFixtureRepo({
      skills: [
        { id: "frontend-design", description: "Frontend work." },
        { id: "webapp-testing", description: "Webapp testing." },
      ],
    });

    const result = await runCli(envRoot, ["--root", explicitRoot, "status"]);

    expect(result.stdout).toContain("Skills: 2");
  });

  it("prints JSON for read-only commands without creating metadata", async () => {
    const root = await createFixtureRepo();

    const status = await runCli(root, ["status", "--json"]);
    const list = await runCli(root, ["--json", "list"]);

    expect(JSON.parse(status.stdout)).toMatchObject({
      skills: 1,
      kits: 0,
      ungrouped: 1,
    });
    expect(JSON.parse(list.stdout)).toMatchObject({
      skills: [expect.objectContaining({ id: "frontend-design" })],
    });
    await expect(
      lstat(path.join(root, ".agents/skills-kit"))
    ).rejects.toThrow();
  });

  it("prints JSON dry-run plans for active-set commands", async () => {
    const root = await createFixtureRepo();

    const result = await runCli(root, [
      "update",
      "--skills",
      "frontend-design",
      "--dry-run",
      "--json",
    ]);
    const json = JSON.parse(result.stdout);

    expect(json).toMatchObject({
      mode: "update",
      plans: [
        {
          selected: 1,
          create: ["frontend-design"],
          remove: [],
          conflicts: [],
        },
      ],
    });
    await expect(
      lstat(path.join(root, ".codex/skills/frontend-design"))
    ).rejects.toThrow();
  });

  it("reports validation issues and supports strict mode", async () => {
    const warningRoot = await createFixtureRepo({
      skills: [{ id: "missing-description", description: "" }],
    });
    const invalidRoot = await createFixtureRepo({
      skills: [{ id: "broken-skill", skillMd: false }],
    });

    const warning = await runCli(warningRoot, ["validate", "--json"]);
    await expect(
      runCli(warningRoot, ["validate", "--strict"])
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("Warnings: 1"),
    });
    await expect(runCli(invalidRoot, ["validate"])).rejects.toMatchObject({
      stdout: expect.stringContaining("Errors:   1"),
    });

    expect(JSON.parse(warning.stdout)).toMatchObject({
      skills: 1,
      errors: 0,
      warnings: 1,
    });
  });

  it("prints doctor and targets summaries", async () => {
    const root = await createFixtureRepo();
    await runCli(root, ["update", "--skills", "frontend-design"]);

    const doctor = await runCli(root, ["doctor", "--json"]);
    const targets = await runCli(root, ["targets", "--json"]);

    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: { skills: 1 },
      validation: { errors: 0 },
      package_json: { hasPackageJson: false },
    });
    expect(JSON.parse(targets.stdout)).toMatchObject({
      targets: [
        expect.objectContaining({
          name: "codex",
          target_path: "./.codex/skills",
          managed_links: 1,
        }),
      ],
    });
  });

  it("keeps doctor and targets read-only before setup", async () => {
    const root = await createFixtureRepo();

    const doctor = await runCli(root, ["doctor", "--json"]);
    const targets = await runCli(root, ["targets"]);

    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: { skills: 1, kits: 0 },
      blocking: false,
    });
    expect(targets.stdout).toContain("Harnesses");
    await expect(
      lstat(path.join(root, ".agents/skills-kit"))
    ).rejects.toThrow();
  });

  it("lists, shows, renames, and deletes kit records safely", async () => {
    const root = await createFixtureRepo();
    await runCli(root, [
      "kit",
      "create",
      "ui",
      "frontend-design",
      "--description",
      "UI work",
    ]);

    const list = await runCli(root, ["kit", "list", "--json"]);
    const show = await runCli(root, ["kit", "show", "ui", "--json"]);
    const rename = await runCli(root, ["kit", "rename", "ui", "frontend-ui"]);

    await expect(
      runCli(root, ["kit", "delete", "frontend-ui"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Refusing to delete without confirmation"
      ),
    });
    const deleted = await runCli(root, [
      "kit",
      "delete",
      "frontend-ui",
      "--yes",
    ]);
    const afterDelete = await runCli(root, ["kit", "list"]);

    expect(JSON.parse(list.stdout)).toMatchObject({
      kits: [expect.objectContaining({ id: "ui", skill_count: 1 })],
    });
    expect(JSON.parse(show.stdout)).toMatchObject({
      kit: expect.objectContaining({ id: "ui", description: "UI work" }),
    });
    expect(rename.stdout).toContain("Renamed kit ui to frontend-ui.");
    expect(deleted.stdout).toContain("Deleted kit frontend-ui.");
    expect(afterDelete.stdout).toContain("No kits saved.");
  });

  it("refuses to rename or delete a kit while it is active", async () => {
    const root = await createFixtureRepo();
    await runCli(root, ["kit", "create", "ui", "frontend-design"]);
    await runCli(root, ["update", "--kits", "ui"]);

    await expect(
      runCli(root, ["kit", "rename", "ui", "frontend-ui"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Kit ui is active"),
    });
    await expect(
      runCli(root, ["kit", "delete", "ui", "--yes"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Kit ui is active"),
    });
  });

  it("previews deactivate --dry-run without changing managed links", async () => {
    const root = await createFixtureRepo();

    await runCli(root, ["update", "--skills", "frontend-design"]);
    const linkPath = path.join(root, ".codex/skills/frontend-design");
    const manifestPath = path.join(
      root,
      ".agents/skills-kit/manifests/codex-skills.toml"
    );
    const manifestBefore = await readFile(manifestPath, "utf8");

    const preview = await runCli(root, ["deactivate", "--all", "--dry-run"]);

    expect(preview.stdout).toContain("Current managed links");
    expect(preview.stdout).toContain("- frontend-design");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(manifestBefore);
  });

  it("prints status without creating skills-kit metadata", async () => {
    const root = await createFixtureRepo();

    const result = await runCli(root, ["status"]);

    expect(result.stdout).toContain("Skills: 1");
    await expect(
      lstat(path.join(root, ".agents/skills-kit"))
    ).rejects.toThrow();
  });

  it("rejects unknown options and missing option values", async () => {
    const root = await createFixtureRepo();

    await expect(runCli(root, ["update", "--bad"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown selection option: --bad"),
    });
    await expect(runCli(root, ["update", "--kits"])).rejects.toMatchObject({
      stderr: expect.stringContaining("--kits requires a value"),
    });
    await expect(runCli(root, ["update", "--kits", ","])).rejects.toMatchObject(
      {
        stderr: expect.stringContaining("--kits requires at least one value"),
      }
    );
    await expect(runCli(root, ["kit", "create", "ui"])).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Usage: skills-kit kit create <name> <skill...>"
      ),
    });
    await expect(
      runCli(root, ["uninstall", "--everything"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown uninstall option: --everything"),
    });
  });

  it("rejects contradictory selection flags", async () => {
    const root = await createFixtureRepo();

    await expect(
      runCli(root, ["update", "--all-skills", "--skills", "frontend-design"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--all-skills cannot be combined with --kits or --skills"
      ),
    });

    await expect(
      runCli(root, ["deactivate", "--all", "--skills", "frontend-design"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--all cannot be combined with --kits or --skills"
      ),
    });
  });

  it("rejects removing a skill that is still supplied by an active kit", async () => {
    const root = await createFixtureRepo();
    await runCli(root, ["kit", "create", "ui", "frontend-design"]);
    await runCli(root, ["update", "--kits", "ui"]);

    await expect(
      runCli(root, ["remove", "--skills", "frontend-design"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Cannot remove skill id(s) still included by active kit(s): frontend-design"
      ),
    });
  });

  it("prints a clean uninstall message when nothing was installed", async () => {
    const root = await createFixtureRepo();

    const result = await runCli(root, ["uninstall"], { input: "delete\n" });

    expect(result.stdout).toContain("skills-kit is already clean.");
    expect(result.stdout).toContain("Nothing was removed.");
  });

  it("updates direct-command default harnesses from targets", async () => {
    const root = await createFixtureRepo();

    const result = await runCli(root, [
      "targets",
      "--set-defaults",
      "codex,claude",
      "--json",
    ]);
    const json = JSON.parse(result.stdout);

    expect(json).toMatchObject({
      default_targets: ["./.codex/skills", "./.claude/skills"],
      updated_defaults: ["./.codex/skills", "./.claude/skills"],
    });
    expect(json.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "codex",
          is_default: true,
        }),
        expect.objectContaining({
          name: "claude",
          is_default: true,
        }),
      ])
    );
  });

  it("refuses to save a harness default when the target is a symlink", async () => {
    const root = await createFixtureRepo();
    await mkdir(path.join(root, ".codex"), { recursive: true });
    await symlink("../.agents/skills", path.join(root, ".codex/skills"), "dir");

    await expect(
      runCli(root, ["targets", "--set-defaults", "codex"])
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Harness target ./.codex/skills is a symlink"
      ),
    });
  });

  it("prints a structured uninstall summary after removing traces", async () => {
    const root = await createFixtureRepo();
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "example",
          scripts: {
            skills: "skills-kit",
          },
          devDependencies: {
            "@skills-kit/cli": "^1.0.0",
          },
        },
        null,
        2
      )}\n`
    );
    await runCli(root, ["update", "--skills", "frontend-design"]);

    const result = await runCli(root, ["uninstall"], { input: "delete\n" });

    expect(result.stdout).toContain("Uninstall skills-kit");
    expect(result.stdout).toContain("Managed links:");
    expect(result.stdout).toContain("Metadata:");
    expect(result.stdout).toContain("Scope:");
    expect(result.stdout).toContain(
      "- Source skills in ./.agents/skills stay untouched"
    );
    expect(result.stdout).toContain('Type "delete" to confirm.');
    expect(result.stdout).toContain("Uninstall complete.");
    expect(result.stdout).toContain("Package scripts");
    expect(result.stdout).toContain("Dependencies:");
  });

  it("restores legacy kits from the direct cli", async () => {
    const root = await createFixtureRepo({
      skills: [
        {
          id: "frontend-design",
          description: "Use when building frontend UI.",
        },
        {
          id: "release-manager",
          description: "Use when preparing releases.",
        },
      ],
    });
    await runCli(root, [
      "kit",
      "create",
      "legacy-kit-codex-only",
      "frontend-design",
    ]);
    await runCli(root, ["kit", "create", "current", "release-manager"]);
    await runCli(root, ["update", "--kits", "current"]);

    const result = await runCli(root, ["restore-legacy"]);

    expect(result.stdout).toContain("Legacy setup restored.");
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);
    await expect(
      lstat(path.join(root, ".codex/skills/release-manager"))
    ).rejects.toThrow();
  });

  it("can restore legacy links before uninstalling settings", async () => {
    const root = await createFixtureRepo({
      skills: [
        {
          id: "frontend-design",
          description: "Use when building frontend UI.",
        },
        {
          id: "release-manager",
          description: "Use when preparing releases.",
        },
      ],
    });
    await runCli(root, [
      "kit",
      "create",
      "legacy-kit-codex-only",
      "frontend-design",
    ]);
    await runCli(root, ["kit", "create", "current", "release-manager"]);
    await runCli(root, ["update", "--kits", "current"]);

    const result = await runCli(root, ["uninstall", "--restore-legacy"], {
      input: "delete\n",
    });

    expect(result.stdout).toContain("Restore legacy skill setup");
    expect(result.stdout).toContain("Legacy setup restored.");
    expect(result.stdout).toContain("Uninstall complete.");
    expect(
      (
        await lstat(path.join(root, ".codex/skills/frontend-design"))
      ).isSymbolicLink()
    ).toBe(true);
    await expect(
      lstat(path.join(root, ".codex/skills/release-manager"))
    ).rejects.toThrow();
    await expect(
      lstat(path.join(root, ".agents/skills-kit"))
    ).rejects.toThrow();
  });

  it("skips recorded links that no longer point to managed source skills", async () => {
    const root = await createFixtureRepo();
    await runCli(root, ["update", "--skills", "frontend-design"]);
    const linkPath = path.join(root, ".codex/skills/frontend-design");
    const otherTarget = path.join(root, ".agents/skills/other-target");
    await mkdir(otherTarget, { recursive: true });
    await rm(linkPath);
    await symlink(
      path.relative(path.dirname(linkPath), otherTarget),
      linkPath,
      "dir"
    );

    const result = await runCli(root, ["uninstall"], { input: "delete\n" });

    expect(result.stdout).toContain("Skipped unmanaged");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("cancels uninstall unless the confirmation phrase is typed", async () => {
    const root = await createFixtureRepo();
    await runCli(root, ["update", "--skills", "frontend-design"]);
    const linkPath = path.join(root, ".codex/skills/frontend-design");

    const result = await runCli(root, ["uninstall"], { input: "no\n" });

    expect(result.stdout).toContain("Managed links:");
    expect(result.stdout).toContain('Type "delete" to confirm.');
    expect(result.stdout).toContain(
      "Uninstall cancelled. Nothing was removed."
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });
});

async function runCli(
  root: string,
  args: string[],
  options: { input?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  if (options.input !== undefined) {
    return spawnCli(root, args, options.input);
  }

  return execFileAsync(
    path.join(process.cwd(), "node_modules/.bin/tsx"),
    [path.join(process.cwd(), "src/cli.ts"), ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SKILLS_KIT_ROOT: root,
      },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }
  );
}

function spawnCli(
  root: string,
  args: string[],
  input: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      [path.join(process.cwd(), "src/cli.ts"), ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SKILLS_KIT_ROOT: root,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out: ${args.join(" ")}`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        Object.assign(new Error(`Command failed: ${args.join(" ")}`), {
          stdout,
          stderr,
        })
      );
    });
    child.stdin.end(input);
  });
}

async function createFixtureRepo(
  options: {
    skills?: Array<{
      id: string;
      description?: string;
      skillMd?: boolean;
    }>;
  } = {}
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-kit-cli-"));
  const skills = options.skills ?? [
    {
      id: "frontend-design",
      description: "Use when building frontend UI.",
    },
  ];
  for (const skill of skills) {
    const dir = path.join(root, ".agents/skills", skill.id);
    await mkdir(dir, { recursive: true });
    if (skill.skillMd === false) {
      continue;
    }
    const description =
      skill.description === undefined
        ? 'description: "Use when building frontend UI."'
        : skill.description
          ? `description: "${skill.description}"`
          : "";
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---
name: ${skill.id}
${description}
---

# ${skill.id}
`,
      "utf8"
    );
  }
  return root;
}
