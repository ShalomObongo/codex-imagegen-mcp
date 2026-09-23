# Multi-client installer: design notes

Maintainer notes for `src/install/`. User-facing documentation lives in [CLIENTS.md](CLIENTS.md).

## Contract

- A declarative registry (`clients.ts`) describes each client: config files per scope and OS,
  entry schema (including timeout field and unit), the skill folders it reads, detection hints and
  restart instructions. Detection is advisory; any client can be selected.
- Everything is planned before anything is written (`plan.ts`). Planning is read-only, so the
  preview and `--dry-run` never touch disk.
- Edits are surgical: JSONC via jsonc-parser `modify` (comments, order and indentation survive),
  Codex TOML by replacing only the `[mcp_servers.<name>]` table and its subtables, Goose YAML via
  the yaml Document API. Every edit is re-parsed and must change only our key.
- Broken files are reported and skipped. An existing entry is replaced only if it launches this
  package, or with `--force`.
- Apply re-reads each file first, writes a `<file>.codex-imagegen-mcp.bak` backup, preserves the
  file mode, follows symlinked dotfiles and writes atomically (temp file + rename).
- Claude Code's user config goes through `claude mcp add-json`/`remove` when a runnable `claude`
  is on PATH (Claude Code rewrites `~/.claude.json` constantly), with a direct edit as fallback.
- Uninstall removes only entries that launch this package, and only skill copies carrying our
  marker that no remaining configured client reads.

## Launch command

`auto` resolves to an absolute node + `dist/src/cli.js` for global installs (no PATH, shim or
network needed at spawn) and to `npx -y codex-imagegen-mcp@<range> serve` for project files or
when running from the npx cache. Windows wraps npx/shims as `cmd /c`; GUI apps get absolute
paths plus a PATH containing node. Global entries pin `CODEX_HOME`, `XDG_DATA_HOME` and the
`CODEX_IMAGEGEN_*` location variables when they are set, because several clients pass only an
allow-listed environment.

## Skills

The skill is named `imagegen-mcp` (Codex ships a system skill called `imagegen`). The planner
picks the fewest skill folders that every selected client reads: existing copies we own are kept
and refreshed, then folders are added greedily by coverage, preferring the shared
`~/.agents/skills` (or `.agents/skills`). Folders holding someone else's skill of the same name are
never used without `--force`. Marker-owned copies from earlier releases (folder `imagegen`) are
removed once the new copy is in place. Claude Desktop gets a zip to upload in the app.

## Not automated

Continue (frozen, and it drops image results), Crush (new crushrc syntax unverified), Kimi CLI
(conflicting docs), Trae (global config path unknown) and Warp (schema unknown). JetBrains AI
Assistant is UI-only: the installer prints the JSON to paste.
