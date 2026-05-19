# @skills-kit/cli

[![CI](https://github.com/reachjalil/skills-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/reachjalil/skills-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@skills-kit/cli.svg)](https://www.npmjs.com/package/@skills-kit/cli)
[![npm downloads](https://img.shields.io/npm/dm/@skills-kit/cli.svg)](https://www.npmjs.com/package/@skills-kit/cli)
[![license](https://img.shields.io/npm/l/@skills-kit/cli.svg)](../../LICENSE)
[![node](https://img.shields.io/node/v/@skills-kit/cli.svg)](https://www.npmjs.com/package/@skills-kit/cli)

Website: [skills-kit.sh](https://skills-kit.sh)

AI-readable context: [llms.txt](./llms.txt) | [AGENTS.md](./AGENTS.md) |
[SAFETY_MODEL.md](./SAFETY_MODEL.md)

`@skills-kit/cli` is a repo-local skill switchboard for local agent skill libraries. It
helps you keep a broad source library in `./.agents/skills`, then apply only the
skills a task needs to Codex, Claude, Gemini CLI, Cursor, or another harness.

It does not install skills or rewrite your source folder. It stores lightweight
metadata under `./.agents/skills-kit`, previews symlink plans in the guided
switchboard, and manages only the harness links it owns.

skills-kit starts after skills are already in the repo. Copy, generate, or
otherwise populate `./.agents/skills` with your existing workflow; use
`@skills-kit/cli` to group, explain, preview, apply, and clear focused
repo-local skill sets.

## Design Principle

V1 is lightweight, low-risk, and intentionally simple:

- no daemon
- no account
- no hosted sync
- no database for core state
- no global config in V1
- no package-manager writes unless the user opts in
- no source-library rewrites

The core behavior is easy to audit: scan local folders, write TOML, support
dry-run symlink plans, and create/remove only managed symlinks.

## Status

V1 package. The source-library guardrail is the product contract:

```txt
./.agents/skills       user-owned source skills, never rewritten by skills-kit commands
./.agents/skills-kit   metadata, preferences, reports, manifests, temp state
./.codex/skills        optional harness target managed with symlinks
./.claude/skills       optional harness target managed with symlinks
./.gemini/skills       optional harness target managed with symlinks
./.cursor/skills       optional harness target managed with symlinks
```

## Requirements

- Node.js 22.12 or newer
- Bun 1.3 or newer for package development/build scripts
- pnpm 10 for this workspace

## Install

From a published package:

```bash
npx @skills-kit/cli
```

`npx @skills-kit/cli` and `npx @skills-kit/cli init` both open the guided
switchboard. If the repo does not have `./.agents/skills`, the CLI stops and
asks you to add local source skills first.

For local development in this repo:

```bash
pnpm install
pnpm --filter @skills-kit/cli run dev
```

Filtered pnpm scripts run inside `packages/cli`, so the CLI uses the
repo you launched from as the skills-kit root. To point it somewhere else:

```bash
SKILLS_KIT_ROOT=/path/to/repo pnpm --filter @skills-kit/cli run dev
```

## What It Does Today

- Scans `./.agents/skills`
- Creates `./.agents/skills-kit/skills-graph.toml`
- Creates `./.agents/skills-kit/skills-preferences.toml`
- Lets users create named skills-kits such as `ui`, `testing`, or `review`
- Allows one skill to belong to multiple skills-kits
- Stores lightweight kit assignment metadata: tags, notes, reason, timestamps,
  and activation history
- Checks saved harness views on startup and offers to reapply or clear stale
  state when managed links are missing
- Imports pre-existing target symlinks into temporary legacy kits such as
  `legacy-kit-claude-codex`, so the old active harness state remains
  manageable
- Warns about target entries that are copied folders, external symlinks, or
  non-skill files before skills-kit owns them
- Shows an apply plan in the guided switchboard before writing symlinks
- Applies a whole skills-kit, several skills-kits, or a checkbox selection
- Clears selected kit links or all managed symlinks
- Reverts configured targets back to imported legacy kits when you want the
  pre-skills-kit harness state again
- Adds/removes managed symlinks in a configured harness target
- Can optionally add `@skills-kit/cli` and a local package script to
  `package.json`
- Rejects harness targets and edited graph skill paths that resolve outside the
  repo
- Leaves `./.agents/skills` untouched

## Guided Switchboard

Run:

```bash
npx @skills-kit/cli
```

The start screen is intentionally small: a terminal logo, a repo snapshot, and a
state-aware switchboard menu that keeps the first decision focused.

The guided switchboard supports:

- first-run initialization when `./.agents/skills-kit` is missing
- harness setup for Codex, Claude, Gemini CLI, Cursor, or a custom target
- first-kit creation with name, description, and checkbox skill selection
- startup recovery when a saved harness view no longer matches the target folder
- editing kits by adding or removing skills
- applying one or more kits into a harness target
- clearing selected kit links or all managed symlinks
- one-off skill selection
- viewing the active harness state
- rescanning `./.agents/skills`
- adding or re-enabling a local package script from More options

The simplest apply flow looks like:

```txt
Apply to: ./.codex/skills

[x] frontend-design
[x] quality-testing-strategy
[ ] release-manager

Enter = apply symlink changes
```

Checked skills get symlinks in the target folder. Unchecked skills remove only
symlinks previously managed by `@skills-kit/cli`. Real folders and unmanaged
files are not overwritten.

## Safety Model

The detailed file-change contract lives in
[SAFETY_MODEL.md](./SAFETY_MODEL.md). In short:

The package is intentionally boring to audit:

- reads source skills from `./.agents/skills`
- writes metadata under `./.agents/skills-kit`
- creates repo-local harness targets such as `./.codex/skills`
- rejects target paths that resolve outside the repo
- rejects edited graph skill paths that resolve outside the repo
- removes only symlinks that appear in the managed manifest
- treats existing real files and directories as conflicts
- changes `package.json` only after the user opts in, and never overwrites an
  existing script with a different command

`@skills-kit/cli` does not run downloaded skill code, install skills, call hosted
APIs, or start a background process.

Startup diagnostics use an internal read-only scan of `./.agents/skills`.
skills-kit does not invoke `skills`, `npx`, npm, or any package manager during
startup validation.

On startup, skills-kit also looks for skills that were already present in
harness targets before skills-kit started managing them. Symlinks that already
point to `./.agents/skills` are imported into legacy kits by target membership,
for example `legacy-kit-codex-only` or `legacy-kit-claude-codex`. Copied target
folders and external target symlinks are normalized only when their contents
match the source skill exactly; normalization replaces the target entry with a
symlink to `./.agents/skills`. Source skills stay untouched. If a target entry
differs from the source, skills-kit reports the conflict and leaves it alone.

## CLI

```bash
npx @skills-kit/cli
npx @skills-kit/cli init
npx @skills-kit/cli scan
npx @skills-kit/cli status
npx @skills-kit/cli list
npx @skills-kit/cli kit create ui frontend-design ui-frontend-design --reason "Focus UI work"
npx @skills-kit/cli update --dry-run --kits ui
npx @skills-kit/cli update --kits ui
npx @skills-kit/cli update --all-skills
npx @skills-kit/cli add --kits ui --targets codex,gemini,cursor
npx @skills-kit/cli remove --kits ui --all-harnesses
npx @skills-kit/cli apply --mode add --target ./.codex/skills --skills frontend-design
npx @skills-kit/cli deactivate --kits ui
npx @skills-kit/cli deactivate --all
npx @skills-kit/cli restore-legacy --dry-run
npx @skills-kit/cli uninstall --restore-legacy --dry-run
npx @skills-kit/cli "activate only my ui skills"
```

The CLI is switchboard-first. Direct commands are meant for scripts, dry-runs,
docs, and repeatable operations. `update` is the default: it makes the selected
kits the active set for each chosen harness. `add` keeps what is already active
and includes the selected kits. `remove` turns selected kits off while preserving
other active kits. `--all-skills` is explicit on purpose: it enables every
source skill in the selected/default harnesses. Use `--dry-run` when a
script should print the create/remove/keep/conflict plan without writing links.

`restore-legacy` reverts configured targets to the imported `legacy-kit-*`
state. Use `--disconnect` when you want the restored links left as plain harness
links instead of managed skills-kit links. `uninstall --restore-legacy` performs
that same disconnecting restore before removing settings/package traces, so the
repo can leave skills-kit while preserving the legacy active skills.

## Package.json Script

When a repo has `package.json`, the guided switchboard can offer to add:

```json
{
  "scripts": {
    "skills": "skills-kit"
  },
  "devDependencies": {
    "@skills-kit/cli": "^1.0.0"
  }
}
```

The default script name is `skills`. skills-kit detects the package manager
from `packageManager` in `package.json` first, then lockfiles such as
`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, and Bun lockfiles. The
prompt shows the matching command, such as `pnpm skills`, `yarn skills`,
`npm run skills`, or `bun run skills`.

The guided switchboard also offers `skills:kit`, `skills-kit`, or a custom
script name. If you decline the startup offer, skills-kit saves that preference
and keeps package.json untouched. More options > Package.json script can
re-enable the offer or apply the script later.

## Data Files

`skills-graph.toml` records scanned skills, named skills-kits, kit assignment
metadata, timestamps, and applied selections.

`skills-preferences.toml` records supported harnesses and the default targets
used by direct commands:

```toml
version = 1

[harness]
name = "codex"
target_path = "./.codex/skills"
selection_mode = "symlink"
confirm_before_write = true
managed_symlinks = true

[[default_harnesses]]
name = "codex"
target_path = "./.codex/skills"

[[default_harnesses]]
name = "claude"
target_path = "./.claude/skills"

[[supported_harnesses]]
name = "codex"
target_path = "./.codex/skills"

[[supported_harnesses]]
name = "claude"
target_path = "./.claude/skills"

[[supported_harnesses]]
name = "gemini"
target_path = "./.gemini/skills"

[[supported_harnesses]]
name = "cursor"
target_path = "./.cursor/skills"

[package_json]
offer = "ask"
script_name = "skills"
script_command = "skills-kit"
dependency_spec = "^1.0.0"
```

Default harnesses are the targets used by direct commands such as
`npx @skills-kit/cli update --kits ui`. They keep everyday commands short when
you normally want Codex and Claude to receive the same focused kit set. Use
`--targets` for a specific subset or `--all-harnesses` for every supported
target.

Each harness target gets a manifest under `./.agents/skills-kit/manifests`.
For example, `./.codex/skills` uses
`./.agents/skills-kit/manifests/codex-skills.toml`. The manifest records the
symlinks `@skills-kit/cli` owns, the active kit IDs, and any explicitly active
skill IDs. Clear operations use this manifest so one kit can be removed while
another active kit is preserved.

The built-in harness paths follow the current native skill-directory pattern for
each tool:

- Codex: `./.codex/skills`
- Claude: `./.claude/skills`
- Gemini CLI: `./.gemini/skills`
- Cursor: `./.cursor/skills`

Gemini CLI and Cursor can also discover project skills from `./.agents/skills`,
but `@skills-kit/cli` writes focused selections to tool-specific folders so the
source library can stay broad while the active harness view stays small.

## Safety Rules

- `@skills-kit/cli` does not move, rename, delete, or rewrite `./.agents/skills`.
- Applying a selection only touches repo-local harness targets.
- `@skills-kit/cli` removes only symlinks listed in its managed manifest.
- Startup recovery compares saved manifests to disk before showing the main
  menu. If a managed harness view is missing, the user can reapply it,
  reconfigure harnesses, clear saved active state, or continue unchanged.
- If a target path contains a real folder/file, apply fails with a conflict.
- If a target symlink points somewhere unexpected, apply fails with a conflict.
- If a harness target looks like a full copied `./.agents/skills` library, apply
  fails with a clear error. Move that copy away before letting skills-kit manage
  the target.
- `--dry-run` prints the exact create/remove/keep/conflict plan before changes.

## Development

### Source Layout

`src/cli.ts`, `src/tui.ts`, and `src/index.ts` are the package entry points.
Reusable code lives in concern folders:

- `src/core/` - graph, scanning, workspace setup, and command-level operations
- `src/services/harnesses/` - target symlink planning, health, legacy import,
  and legacy restore flows
- `src/services/lifecycle/` - uninstall and cleanup flows
- `src/services/package-json/` - package script detection and mutation
- `src/services/validation/` - skill validation diagnostics
- `src/config/` - repo-local preferences
- `src/ui/` - prompt labels, menu construction, and branding helpers
- `src/utils/` - shared path and repo-boundary utilities

Keep new behavior in the narrowest folder that owns it. Avoid adding generic
top-level helpers unless multiple service areas already use them.

```bash
pnpm --filter @skills-kit/cli run check
pnpm --filter @skills-kit/cli run test
pnpm --filter @skills-kit/cli run build
pnpm --filter @skills-kit/cli run smoke:pack
pnpm --filter @skills-kit/cli run quality
```

This package uses:

- `@clack/prompts` for the guided switchboard
- `smol-toml` for repo-local config files
- Vitest for unit tests
- Bun for building the CLI bundle

Runtime dependencies are intentionally limited to the terminal prompt library
and TOML parser. See [SECURITY.md](./SECURITY.md) for the dependency policy and
reporting guidance.

## AI And Repository Discovery

This package includes small plain-text files for coding agents and repository
search systems:

- [llms.txt](./llms.txt) is a concise package map with commands, file pointers,
  and product boundaries.
- [AGENTS.md](./AGENTS.md) gives AI coding agents the safety rules and
  validation commands for modifying this package.

The public site also exposes:

- <https://skills-kit.sh/llms.txt>
- <https://skills-kit.sh/llms-full.txt>

Use `pnpm --filter @skills-kit/cli run smoke:pack` before publishing. It builds
the package, packs the real npm tarball, installs it into a temporary repo, and
executes the installed `skills-kit` binary against a sample local skill layout.

Use `pnpm --filter @skills-kit/cli run quality` for the full release gate. It
runs Biome, TypeScript, Vitest, the build, the tarball smoke test, and a
tarball-only production dependency audit. The audit installs the packed package
into a temporary npm project so unrelated workspace dependencies do not pollute
the result.

Public releases should use npm provenance:

```bash
npm publish --provenance --access public
```

## License

Apache-2.0. This project is maintained by Jalil Laaraichi (@reachjalil).

Commercial use, private use, modification, and redistribution are allowed under
the license. If this project helps your work, attribution in documentation,
talks, blog posts, project READMEs, or release notes is appreciated but not
required.

## Roadmap

V1 intentionally avoids global config, hosted sync, fork management, and
external registry imports. Those can layer on later after the repo-local
metadata standard is stable.
