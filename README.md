# skills-kit

> **Open-source monorepo for `@skills-kit/cli` — the repo-local skill switchboard for AI agents.**

[![CI](https://github.com/reachjalil/skills-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/reachjalil/skills-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@skills-kit%2Fcli.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@skills-kit/cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=flat-square)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](./CONTRIBUTING.md)

---

This is the official repository for **Skills Kit**, a local-first developer tool for managing AI agent skills (MCP tools or abilities). 

## Monorepo Packages

- **[@skills-kit/cli](./packages/cli)** — The core CLI tool and interactive terminal switchboard.

---

## Local Development

Ensure you have [pnpm](https://pnpm.io) installed, then run:

```bash
pnpm install     # Install workspace dependencies
pnpm test        # Run all test suites
pnpm build       # Build all packages
pnpm quality     # Run full quality gate (lint, build, test, smoke test)
```

The package is local-first: it reads source skills from `./.agents/skills`, writes metadata under `./.agents/skills-kit`, and manages only repo-local harness symlinks it owns. See [packages/cli/SAFETY_MODEL.md](./packages/cli/SAFETY_MODEL.md) for the file-change contract.

---

## Release Process

CI runs on every pull request and every push to `main` or `dev`. Npm publishing runs only from `v*.*.*` tags or a manual workflow dispatch.

### Git Branching Model
- `main` is the protected release branch.
- `dev` is the protected integration branch for grouped work.
- Feature branches should target PRs to `dev` or `main`.
- Releases are triggered by publishing immutable semver tags (e.g. `v1.0.2`) from `main`.

```bash
git tag v1.0.2
git push origin v1.0.2
```

---

## License

Apache-2.0. Maintained by Jalil Laaraichi (@reachjalil).
