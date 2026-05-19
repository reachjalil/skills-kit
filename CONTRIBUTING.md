# Contributing

Thanks for helping improve `@skills-kit/cli`.

This package is intentionally small. The core promise is simple: keep
`./.agents/skills` user-owned, store readable repo-local metadata, preview
symlink changes, and only manage symlinks that skills-kit owns.

## Local Setup

```bash
pnpm install
pnpm --filter @skills-kit/cli run check
pnpm --filter @skills-kit/cli run test
pnpm --filter @skills-kit/cli run build
pnpm --filter @skills-kit/cli run quality
```

For a release-shaped smoke test:

```bash
pnpm --filter @skills-kit/cli run smoke:pack
```

That packs the npm tarball, installs it into a temporary repo, creates a sample
`./.agents/skills` folder, and runs the installed `skills-kit` binary.

For dependency scanner confidence, use:

```bash
pnpm --filter @skills-kit/cli run audit:package
```

It audits the packed package in a temporary npm project instead of auditing the
entire monorepo lockfile.

## Product Boundaries

Good first changes usually improve one of these areas:

- clearer switchboard copy
- safer symlink planning
- clearer repo-local path validation
- better TOML validation and migration behavior
- tighter command output
- tests for state-aware navigation and managed manifests

Please be careful with changes that make skills-kit more magical. V1 should
not install skills, rewrite source skill folders, run a background service, or
depend on hosted state.

## Tests

Use the narrow package scripts before broader workspace checks:

```bash
pnpm --filter @skills-kit/cli run check
pnpm --filter @skills-kit/cli run test
pnpm --filter @skills-kit/cli run build
pnpm --filter @skills-kit/cli run audit:package
pnpm --filter @skills-kit/cli run pack:dry-run
```

Add focused tests when changing:

- menu option derivation
- graph or preferences parsing
- symlink plan generation
- manifest ownership rules
- command behavior

## Security

Do not open public issues for suspected security problems. Follow
[SECURITY.md](./SECURITY.md).

## Publishing

Publishing should happen from CI or a clean local checkout after the full package
check passes. Prefer npm provenance for public releases:

```bash
npm publish --provenance --access public
```

The package is Apache-2.0 and maintained by Jalil Laaraichi (@reachjalil).
