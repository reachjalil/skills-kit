import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseSkillFrontmatter } from "./frontmatter";
import { toRepoRelative } from "../utils/paths";
import type { SkillRecord, WorkspacePaths } from "../types";

export async function scanSkills(
  paths: WorkspacePaths,
  now = new Date()
): Promise<SkillRecord[]> {
  const sourceExists = await pathExists(paths.sourceSkillsDir);
  if (!sourceExists) {
    return [];
  }

  const entries = await readdir(paths.sourceSkillsDir, {
    withFileTypes: true,
  });
  const scannedAt = now.toISOString();
  const skills: SkillRecord[] = [];

  for (const entry of entries.toSorted((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const skillPath = path.join(paths.sourceSkillsDir, entry.name);
    const skillStat = await stat(skillPath).catch(() => undefined);
    if (!skillStat?.isDirectory()) {
      continue;
    }

    const skillMdPath = path.join(skillPath, "SKILL.md");
    const markdown = await readFile(skillMdPath, "utf8").catch(() => "");
    const metadata = markdown ? parseSkillFrontmatter(markdown) : {};
    const id = entry.name;
    const description = metadata.description ?? "";
    const status = !markdown
      ? "missing_skill_md"
      : description
        ? "valid"
        : "missing_description";
    const updatedAt = markdown
      ? (await stat(skillMdPath)).mtime.toISOString()
      : skillStat.mtime.toISOString();

    skills.push({
      id,
      name: metadata.name ?? id,
      description,
      path: toRepoRelative(paths.root, skillPath),
      kit_ids: [],
      tags: [],
      notes: "",
      status,
      checksum: markdown ? checksumText(markdown) : "",
      last_scanned_at: scannedAt,
      last_reviewed_at: "",
      last_updated_at: updatedAt,
      last_activated_at: "",
    });
  }

  return skills;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

function checksumText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
