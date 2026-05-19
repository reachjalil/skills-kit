# Changelog

All notable changes to `@skills-kit/cli` will be documented here.

This project follows semantic versioning. Patch releases should remain
compatible, minor releases may add behavior, and major releases may change the
repo-local metadata contract.

## 1.0.1 - 2026-05-19

- Added a clear harness target error when `.codex/skills`, `.claude/skills`,
  or another target directory is itself a symlink. skills-kit now asks users to
  replace the target symlink with a real directory instead of failing with a raw
  `EEXIST` mkdir error.

## 1.0.0 - 2026-05-19

Initial public V1.

- Added the repo-local switchboard for local agent skill libraries.
- Added guarded scanning of `./.agents/skills`.
- Added `./.agents/skills-kit/skills-graph.toml` and preferences metadata.
- Added named kits with overlapping skill membership.
- Added harness preferences for Codex, Claude, Gemini CLI, Cursor, and custom
  symlink targets.
- Added guided symlink plan previews and direct `--dry-run` planning.
- Added managed manifests so clear operations remove only links owned by
  skills-kit.
- Added startup harness recovery when saved managed links are missing or out of
  sync with disk.
- Added an opt-in `package.json` shortcut that can add `@skills-kit/cli` as a
  devDependency and create a local package script.
- Added direct commands for docs, scripts, and repeatable workflows.
- Added safety checks for real files, real folders, and unmanaged symlinks.
- Added safety regression coverage for the full apply/change/clear workflow and
  stale symlink plans.
