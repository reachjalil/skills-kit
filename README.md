# skills-kit

[![CI](https://github.com/reachjalil/skills-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/reachjalil/skills-kit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@skills-kit/cli.svg)](https://www.npmjs.com/package/@skills-kit/cli)
[![npm downloads](https://img.shields.io/npm/dm/@skills-kit/cli.svg)](https://www.npmjs.com/package/@skills-kit/cli)
[![license](https://img.shields.io/npm/l/@skills-kit/cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@skills-kit/cli.svg)](https://www.npmjs.com/package/@skills-kit/cli)

Open-source monorepo for `@skills-kit/cli`, a repo-local skill switchboard for
local `./.agents/skills` libraries.

## Package

- [`packages/cli`](./packages/cli) - the published `@skills-kit/cli` package

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm quality
```

The package is local-first: it reads source skills from `./.agents/skills`,
writes metadata under `./.agents/skills-kit`, and manages only repo-local
harness symlinks it owns.

See [`packages/cli/SAFETY_MODEL.md`](./packages/cli/SAFETY_MODEL.md) for the
file-change contract.

## Release

CI runs on every pull request and every push to `main` or `dev`. Npm publishing
runs only from `v*.*.*` tags or a manual workflow dispatch.

For the first publish, set `NPM_TOKEN` because npm Trusted Publishing can only
be attached after `@skills-kit/cli` already exists on npm. After V1 is published,
configure npm Trusted Publishing for `reachjalil/skills-kit` and remove the
token; the same workflow will publish through OIDC.

```bash
git tag v1.0.0
git push origin v1.0.0
```

Recommended branch pattern:

- `main` is the protected release branch.
- `dev` is the protected integration branch for grouped work.
- feature branches open pull requests into `dev` or `main`.
- npm releases are immutable semver tags such as `v1.0.0` from `main`.
