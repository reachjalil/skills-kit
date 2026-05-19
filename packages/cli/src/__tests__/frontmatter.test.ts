import { describe, expect, it } from "vitest";

import { parseSkillFrontmatter } from "../core/frontmatter";

describe("parseSkillFrontmatter", () => {
  it("reads name and description from SKILL.md frontmatter", () => {
    expect(
      parseSkillFrontmatter(`---
name: frontend-design
description: "Use for polished React UI work."
---

# Frontend Design
`)
    ).toEqual({
      name: "frontend-design",
      description: "Use for polished React UI work.",
    });
  });

  it("returns an empty object when frontmatter is missing", () => {
    expect(parseSkillFrontmatter("# Plain Skill")).toEqual({});
  });
});
