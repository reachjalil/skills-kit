# Security Policy

`@skills-kit/cli` is intentionally local-first. It reads `./.agents/skills`,
writes metadata under `./.agents/skills-kit`, and manages symlinks only in the
configured repo-local harness target. The optional `package.json` shortcut is
explicitly opt-in.

Startup diagnostics use an internal read-only scan of `./.agents/skills`.
skills-kit does not invoke `skills`, `npx`, npm, or any package manager during
startup validation.

## Supported Versions

Security fixes are expected to land on the latest published version while the
package is in V1 release hardening.

## Dependency Policy

Runtime dependencies are kept small and must have permissive open-source
licenses:

- `@clack/prompts` for the guided terminal switchboard
- `smol-toml` for reading and writing user-editable TOML files

Avoid adding runtime dependencies unless they clearly replace non-trivial,
security-sensitive behavior. Prefer package-local helpers for narrow formatting
or data-shaping tasks.

## Reporting

Open a private security advisory or contact the maintainers before disclosing
issues publicly. Include:

- affected version or commit
- reproduction steps
- expected impact
- any suggested mitigation

## Safety Guarantees

- Source skills in `./.agents/skills` are never moved, renamed, deleted, or
  rewritten by skills-kit commands.
- Harness targets must resolve inside the current repo. Paths outside the repo
  are rejected before any plan is applied.
- Skill paths loaded from the editable graph must also resolve inside the repo.
- Apply and clear operations only touch symlinks recorded in
  `./.agents/skills-kit/manifests`.
- Existing real files or directories in a harness target are treated as
  conflicts, not overwritten.
- `package.json` is changed only after confirmation. Existing scripts with a
  different command are not overwritten.
- Startup diagnostics do not use package-manager auto-install paths.

## Release Checks

Run the full package quality gate before publishing:

```bash
pnpm --filter @skills-kit/cli run quality
```

This includes a tarball-only production dependency audit:

```bash
pnpm --filter @skills-kit/cli run audit:package
```

The audit installs the packed package into a temporary npm project before
running `npm audit --omit=dev`, so unrelated workspace advisories do not mask the
publishable package result.
