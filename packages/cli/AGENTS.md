# AGENTS.md

Guidance for AI coding agents working on `@skills-kit/cli`.

## Product Contract

`@skills-kit/cli` is a repo-local skill switchboard for local agent skill libraries.

The core promise is:

- read `./.agents/skills` as the source library
- never move, rename, delete, or rewrite source skills
- store readable metadata under `./.agents/skills-kit`
- preview or dry-run managed symlink changes before risky operations
- create and remove only symlinks owned by skills-kit manifests
- keep the package small, local-first, and easy to audit

## Non-goals

Do not turn V1 into:

- a skills installer
- a hosted service
- a background daemon
- a cross-repo sync system
- a marketplace
- an agent runtime
- a package manager

## Important Paths

- `src/cli.ts` - direct command surface
- `src/tui.ts` - guided switchboard flow
- `src/core/` - graph, scanner, workspace readiness, and command operations
- `src/services/harnesses/` - symlink planning, harness health, legacy import, and legacy restore behavior
- `src/services/lifecycle/` - uninstall and cleanup behavior
- `src/services/package-json/` - opt-in package.json shortcut behavior
- `src/services/validation/` - skill validation and local source inventory diagnostics
- `src/config/` - harness and package shortcut preferences
- `src/ui/` - guided copy, branding, and state-aware menu options
- `src/utils/` - repo path and boundary helpers
- `src/__tests__/` - unit and regression tests

## Safety Rules For Changes

Use [`SAFETY_MODEL.md`](./SAFETY_MODEL.md) as the detailed file-change
contract.

- Treat `./.agents/skills` as read-only user-owned input.
- Reject target paths that resolve outside the repo.
- Treat real files, real directories, and unmanaged symlinks in harness targets as conflicts.
- Preserve unrelated user files and unmanaged harness content.
- Keep direct commands scriptable and predictable.
- Keep interactive copy plain and explicit about what will change.
- Add focused tests for every change that affects symlink ownership, target resolution, graph persistence, package.json writes, or menu state.

## Validation

Use the narrow package checks first:

```bash
pnpm --filter @skills-kit/cli run check
pnpm --filter @skills-kit/cli run test
pnpm --filter @skills-kit/cli run build
```

Before release-oriented changes, run:

```bash
pnpm --filter @skills-kit/cli run quality
pnpm --filter @skills-kit/cli run publish:dry-run
```

`quality` runs Biome, TypeScript, Vitest, the build, a packed tarball smoke test, and a tarball-only production dependency audit.

## AI Context

For a concise package map, read [`llms.txt`](./llms.txt).

For public site context, read:

- <https://skills-kit.sh/llms.txt>
- <https://skills-kit.sh/llms-full.txt>
