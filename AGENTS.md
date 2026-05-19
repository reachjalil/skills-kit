# Repository Guidelines

This repository contains the standalone `skills-kit` open-source workspace.

## Structure

- `packages/cli/` contains the published `@skills-kit/cli` package.
- Root config files exist only to support package development, validation, and
  release checks.

## Safety

- Treat `./.agents/skills` as user-owned source input.
- Keep skills-kit local-first: no hosted service, daemon, installer, or
  marketplace behavior in the CLI.
- File-change rules live in
  [`packages/cli/SAFETY_MODEL.md`](./packages/cli/SAFETY_MODEL.md).

## Validation

Use the package quality gate before publishing:

```bash
pnpm quality
```

For focused work:

```bash
pnpm check
pnpm test
pnpm build
```
