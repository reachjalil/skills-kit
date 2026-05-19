# skills-kit Safety Model

`@skills-kit/cli` is allowed to coordinate repo-local skills, but it must stay
conservative about file changes. This document is the contract for code paths
that write to disk.

## Ownership

- `./.agents/skills` is user-owned source input. Normal switchboard, apply,
  deactivate, restore, and uninstall commands must not edit, delete, rename, or
  move source skills.
- `./.agents/skills-kit` is skills-kit metadata. It can contain graph data,
  preferences, reports, target manifests, and temporary state.
- Harness target folders such as `./.codex/skills` and `./.claude/skills` can
  be changed only through managed symlinks.
- `package.json` can be changed only through the explicit package shortcut
  integration or uninstall cleanup.

Legacy migration is the only source-library write exception. It may copy a
valid target-only skill into `./.agents/skills` when the user chooses normalize.
It must not overwrite an existing source skill.

## Repo Boundaries

All file-changing operations must resolve paths through repo-local helpers.

- Reject harness targets outside the repo.
- Reject graph skill paths outside the repo.
- Reject harness targets that are inside, or resolve inside, `./.agents/skills`.
- Reject symlink actions whose target path escapes the selected harness target.

Tests must cover both lexical paths such as `../outside` and resolved symlink
paths where relevant.

## Harness Writes

The harness writer follows a plan/apply model:

1. Plan creates `create`, `keep`, `remove`, and `conflicts` lists.
2. Existing real files, real directories, and unmanaged symlinks are conflicts.
3. Apply refuses plans with conflicts.
4. Apply rechecks the target before writing because the filesystem may have
   changed after preview.
5. Removal deletes only symlinks that are still managed symlinks.
6. Creation writes only missing entries or entries that already point to the
   expected source.

If a target changes after preview, apply must fail before partial writes.

## Manifests

Managed ownership lives in target manifests under
`./.agents/skills-kit/manifests`.

- A manifest records managed skill ids, active kit ids, and active skill ids.
- Deactivation and uninstall trust the manifest only as a candidate list.
- Before removing any manifest entry, code must confirm the target is a symlink
  to `./.agents/skills/<skill-id>`.
- If the manifest points to a real file, real directory, missing entry, or
  changed symlink, code must skip or report it rather than deleting it.

## Legacy Import

Startup legacy import exists to preserve active harness state that predates
skills-kit.

Safe automatic import:

- A target symlink to `./.agents/skills/<skill-id>` becomes part of a
  `legacy-kit-*`.

Safe normalize with explicit user confirmation:

- A copied target skill may be replaced by a source symlink only if it still
  matches `./.agents/skills/<skill-id>` at write time.
- An external target symlink may be replaced only if it still points to the
  inspected external folder and that folder still matches the source at write
  time.
- A target-only skill may be copied into `./.agents/skills` only if the source
  id is still absent and the target still looks like a valid skill.

Unsafe entries are warnings, not mutations:

- Unknown non-skill files.
- Target folders that differ from matching source skills.
- External symlinks that differ from matching source skills.
- Source id collisions during migration.

## Legacy Restore And Uninstall

Legacy restore applies imported `legacy-kit-*` records to configured targets.
It uses the same harness plan/apply safety checks as normal activation.

Uninstall supports independent scopes:

- `settings` removes metadata and package shortcut traces only.
- `harnesses` disconnects managed harness links only.
- `all` combines both.

`uninstall --restore-legacy` must restore legacy links first, then clear
manifests so restored links are left as plain harness links.

## package.json Writes

Package shortcut integration is opt-in.

- Add only the configured script name with the exact `skills-kit` command.
- Never overwrite an existing script with a different command.
- Add `@skills-kit/cli` only as a plain semver dependency spec.
- Remove only exact managed scripts whose command is `skills-kit`.
- Preserve similar user scripts such as `npx skills-kit` or
  `skills-kit --help`.

## Test Requirements

Any change to these areas must include focused Vitest coverage:

- path boundary checks
- source-library immutability
- plan/apply stale target changes
- unmanaged harness conflicts
- manifest cleanup skip behavior
- legacy normalize and migration warnings
- package.json overwrite and exact-removal rules
- clear user-facing error messages for refused mutations

Prefer hermetic temporary repos under `os.tmpdir()`. Assert both the thrown
error and the filesystem state after failure.
