# @skills-kit/cli

> **A local-first, auditable switchboard for managing AI agent skills.**

[![NPM Version](https://img.shields.io/npm/v/@skills-kit/cli.svg?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@skills-kit/cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=flat-square)](../../LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](../../CONTRIBUTING.md)

---

`@skills-kit/cli` is a developer tool and interactive terminal wizard designed to optimize how AI coding agents (such as Codex, Claude Code, Gemini CLI, and Cursor) discover and use repository-local skills (MCP tools or abilities).

Instead of sending every tool to an agent—which wastes context, inflates token costs, and increases the chance of model confusion—this CLI allows you to organize skills into focused "kits" (e.g., `testing`, `ui`) and dynamically symlink only what you need.

---

## Key Features

- **Local-first & offline:** Works completely offline. No accounts, no daemons, no hosted sync, and no database.
- **Context optimization:** Group skills into semantic kits and activate only the tools needed for your current task.
- **Safety guarantees:** The CLI never modifies your source skills in `./.agents/skills/`. It operates via auditable symlinks and rejects paths resolving outside your repository boundary.
- **Interactive TUI:** A simple, guided terminal wizard powered by `@clack/prompts` to easily create kits and toggle configurations.

---

## Installation & Usage

### Quick Start
To initialize or open the interactive switchboard:

```bash
npx @skills-kit/cli
```

*Note: If your repository does not yet contain a `./.agents/skills/` directory, the CLI will prompt you to set up your local source skills first.*

### Direct CLI Commands
You can also run commands directly or script them:

```bash
npx @skills-kit/cli init                 # Setup skills-kit configuration
npx @skills-kit/cli status               # View active harness states & links
npx @skills-kit/cli list                 # List all configured kits
npx @skills-kit/cli kit create <name> <skills...> # Create a named kit
npx @skills-kit/cli update --kits <names> # Reapply specified kits (overwriting current mapping)
npx @skills-kit/cli deactivate --all      # Clear all managed symlinks
```

*(Append `--dry-run` to any update or deactivation command to inspect the symlink plan before it writes changes to disk).*

---

## Directory Structure

| Path | Owner | Description |
|---|---|---|
| `./.agents/skills/` | User / Developer | Source library of all available skills. |
| `./.agents/skills-kit/` | Skills Kit | Auto-generated metadata, preferences, and manifests. |
| `./.[harness]/skills/` | Harness | Target folder for active symlinks (e.g. `./.codex/skills`, `./.claude/skills`). |

---

## Contributing

We welcome contributions of all kinds! Please read our **[Contributing Guide](../../CONTRIBUTING.md)** for local setup, testing workflows, and product design boundaries.

### Local Development Setup
1. Clone the repository and install dependencies at the monorepo root:
   ```bash
   pnpm install
   ```
2. Start the CLI in development mode:
   ```bash
   pnpm --filter @skills-kit/cli run dev
   ```
3. Run checks and quality gates from the monorepo root:
   - `pnpm test` — Run unit tests (Vitest)
   - `pnpm lint` — Format and lint (Biome)
   - `pnpm build` — Compile and bundle (Bun)

---

## Security

Security is key for local AI tooling. Please review our **[Security Policy](../../SECURITY.md)** to learn about dependency requirements, security guarantees, and how to report issues.

---

## License

Apache-2.0. Maintained by Jalil Laaraichi (@reachjalil).
