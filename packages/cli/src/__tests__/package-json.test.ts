import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyPackageJsonIntegration,
  detectPackageManager,
  formatPackageScriptCommand,
  getPackageJsonIntegrationStatus,
  removePackageJsonIntegration,
  SKILLS_KIT_PACKAGE_NAME,
} from "../services/package-json/package-json";
import { createDefaultPackageJsonPreferences } from "../config/preferences";

describe("package.json integration", () => {
  it("adds the package as a devDependency and creates the default script", async () => {
    const root = await createPackageJson({
      name: "example",
      scripts: {
        test: "vitest",
      },
    });

    const result = await applyPackageJsonIntegration(root);
    const packageJson = await readPackageJson(root);

    expect(result).toMatchObject({
      addedDependency: true,
      addedScript: true,
      scriptName: "skills",
      scriptCommand: "skills-kit",
      packageManager: "npm",
      runScriptCommand: "npm run skills",
    });
    expect(packageJson.devDependencies).toMatchObject({
      [SKILLS_KIT_PACKAGE_NAME]: "^1.0.0",
    });
    expect(packageJson.scripts).toMatchObject({
      test: "vitest",
      skills: "skills-kit",
    });
  });

  it("allows a customized script name without changing the command", async () => {
    const root = await createPackageJson({ name: "example" });

    await applyPackageJsonIntegration(root, {
      scriptName: "skills-kit",
    });

    await expect(readPackageJson(root)).resolves.toMatchObject({
      scripts: {
        "skills-kit": "skills-kit",
      },
    });
  });

  it("allows a colon script preset", async () => {
    const root = await createPackageJson({ name: "example" });

    await applyPackageJsonIntegration(root, {
      scriptName: "skills:kit",
    });

    await expect(readPackageJson(root)).resolves.toMatchObject({
      scripts: {
        "skills:kit": "skills-kit",
      },
    });
  });

  it("does not duplicate the dependency when it already exists", async () => {
    const root = await createPackageJson({
      name: "example",
      dependencies: {
        [SKILLS_KIT_PACKAGE_NAME]: "^1.0.0",
      },
    });

    const result = await applyPackageJsonIntegration(root);
    const packageJson = await readPackageJson(root);

    expect(result.addedDependency).toBe(false);
    expect(packageJson.devDependencies).toBeUndefined();
    expect(packageJson.dependencies).toMatchObject({
      [SKILLS_KIT_PACKAGE_NAME]: "^1.0.0",
    });
  });

  it("removes skills-kit scripts and dependency traces", async () => {
    const root = await createPackageJson({
      name: "example",
      scripts: {
        skills: "skills-kit",
        test: "vitest",
      },
      devDependencies: {
        [SKILLS_KIT_PACKAGE_NAME]: "^1.0.0",
        vitest: "^4.0.0",
      },
    });

    const result = await removePackageJsonIntegration(root);
    const packageJson = await readPackageJson(root);

    expect(result).toMatchObject({
      removedScripts: 1,
      removedDependencies: 1,
    });
    expect(packageJson.scripts).toEqual({ test: "vitest" });
    expect(packageJson.devDependencies).toEqual({ vitest: "^4.0.0" });
  });

  it("preserves similar package scripts that are not managed by skills-kit", async () => {
    const root = await createPackageJson({
      name: "example",
      scripts: {
        skills: "skills-kit",
        "skills:npx": "npx skills-kit",
        "skills:args": "skills-kit --help",
      },
      devDependencies: {
        [SKILLS_KIT_PACKAGE_NAME]: "^1.0.0",
      },
    });

    const result = await removePackageJsonIntegration(root);
    const packageJson = await readPackageJson(root);

    expect(result.removedScripts).toBe(1);
    expect(packageJson.scripts).toEqual({
      "skills:npx": "npx skills-kit",
      "skills:args": "skills-kit --help",
    });
  });

  it("refuses to overwrite an existing script with a different command", async () => {
    const root = await createPackageJson({
      name: "example",
      scripts: {
        skills: "echo existing",
      },
    });

    await expect(applyPackageJsonIntegration(root)).rejects.toThrow(
      'package.json already has a "skills" script'
    );

    await expect(readPackageJson(root)).resolves.toMatchObject({
      scripts: {
        skills: "echo existing",
      },
    });
  });

  it("rejects unsafe package script names", async () => {
    const root = await createPackageJson({ name: "example" });

    await expect(
      applyPackageJsonIntegration(root, { scriptName: "skills && publish" })
    ).rejects.toThrow("Package script name can use letters");
  });

  it("rejects non-registry dependency specs", async () => {
    const root = await createPackageJson({ name: "example" });

    await expect(
      applyPackageJsonIntegration(root, { dependencySpec: "file:../cli" })
    ).rejects.toThrow("Package dependency spec must be a plain semver range");
  });

  it("reports configured status from saved preferences", async () => {
    const root = await createPackageJson({
      name: "example",
      devDependencies: {
        [SKILLS_KIT_PACKAGE_NAME]: "^1.0.0",
      },
      scripts: {
        "skills-kit": "skills-kit",
      },
    });

    await expect(
      getPackageJsonIntegrationStatus(root, {
        ...createDefaultPackageJsonPreferences(),
        script_name: "skills-kit",
      })
    ).resolves.toMatchObject({
      hasPackageJson: true,
      hasDependency: true,
      hasScript: true,
      scriptName: "skills-kit",
      packageManager: "npm",
      runScriptCommand: "npm run skills-kit",
    });
  });

  it("detects package managers from packageManager and lockfiles", async () => {
    const pnpmRoot = await createPackageJson({
      name: "example",
      packageManager: "pnpm@10.0.0",
    });
    await expect(detectPackageManager(pnpmRoot)).resolves.toBe("pnpm");

    const yarnRoot = await createPackageJson({ name: "example" });
    await writeFile(path.join(yarnRoot, "yarn.lock"), "");
    await expect(detectPackageManager(yarnRoot)).resolves.toBe("yarn");

    const npmRoot = await createPackageJson({ name: "example" });
    await writeFile(path.join(npmRoot, "package-lock.json"), "{}\n");
    await expect(detectPackageManager(npmRoot)).resolves.toBe("npm");
  });

  it("formats script commands for common package managers", () => {
    expect(formatPackageScriptCommand("pnpm", "skills")).toBe("pnpm skills");
    expect(formatPackageScriptCommand("yarn", "skills")).toBe("yarn skills");
    expect(formatPackageScriptCommand("npm", "skills")).toBe("npm run skills");
    expect(formatPackageScriptCommand("bun", "skills")).toBe("bun run skills");
  });
});

async function createPackageJson(
  value: Record<string, unknown>
): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "skills-kit-package-json-")
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(value, null, 2)}\n`
  );
  return root;
}

async function readPackageJson(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8")
  ) as Record<string, unknown>;
}
