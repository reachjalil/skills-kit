import { describe, expect, it } from "vitest";

import { formatMenuTitle, formatSplash } from "../ui/branding";

describe("terminal branding", () => {
  it("renders a wide skills-kit splash without ansi when color is disabled", () => {
    const splash = formatSplash({ color: false, columns: 100 });

    expect(splash).toContain("skills-kit");
    expect(splash).toContain("repo-local skill switchboard");
    expect(splash).toContain("for local agent skill libraries");
    expect(splash).not.toContain("\x1b[");
    expect(splash).toContain("\\");
    expect(splash).toContain("/");
    expect(splash.split("\n")).toHaveLength(5);
  });

  it("uses a compact splash in narrow terminals", () => {
    const splash = formatSplash({ color: false, columns: 60 });

    expect(splash).toContain("skills-kit");
    expect(splash).toContain("for local agent skill libraries");
    expect(splash.split("\n")).toHaveLength(5);
  });

  it("summarizes the switchboard state in the menu title", () => {
    expect(
      formatMenuTitle({
        kitCount: 2,
        skillCount: 12,
        activeLinkCount: 4,
      })
    ).toBe("Skill switchboard - 2 kits, 12 skills, 4 active skills");
  });

  it("uses singular labels in the switchboard state", () => {
    expect(
      formatMenuTitle({
        kitCount: 1,
        skillCount: 1,
        activeLinkCount: 1,
      })
    ).toBe("Skill switchboard - 1 kit, 1 skill, 1 active skill");
  });
});
