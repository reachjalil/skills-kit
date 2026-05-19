export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  if (!markdown.startsWith("---")) {
    return {};
  }

  const end = markdown.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }

  const block = markdown.slice(3, end).trim();
  const result: SkillFrontmatter = {};

  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const value = stripScalarQuotes(match[2].trim());

    if (key === "name") {
      result.name = value;
    }
    if (key === "description") {
      result.description = value;
    }
  }

  return result;
}

function stripScalarQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
