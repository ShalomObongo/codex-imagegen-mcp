<p align="center">
  <img src="assets/banner-clients.jpg" width="100%" alt="Clients — a travel-poster illustration of a desert railway junction where several tracks converge on one small station with a water tower">
</p>

# Clients

The server is a local **stdio** MCP server, so any MCP client can run it: many tracks, one station. opencode installs with one command, and every other client takes a short snippet that `codex-imagegen-mcp config <client>` prints for you.

**On this page:** [Support matrix](#support-matrix) · [opencode](#opencode-automated) · [Claude Code](#claude-code) · [OpenAI Codex](#openai-codex-cli-and-ide) · [Claude Desktop](#claude-desktop) · [Cursor](#cursor) · [VS Code](#vs-code-github-copilot-agent-mode) · [Windsurf](#windsurf) · [Gemini CLI](#gemini-cli) · [Any other client](#any-other-client)

## Support matrix

| Client | Setup | Tools appear as |
|---|---|---|
| **opencode** | `install opencode`: writes `opencode.json[c]` and the skill (automated) | `imagegen_generate_image` |
| **Claude Code** | `claude mcp add …`, skill in `~/.claude/skills/` | `mcp__imagegen__generate_image` |
| **OpenAI Codex** | `config codex` → `~/.codex/config.toml` | `mcp__imagegen__generate_image` |
| **Claude Desktop** | `config claude-desktop` → `claude_desktop_config.json` | listed under `imagegen` |
| **Cursor** | `config cursor` → `~/.cursor/mcp.json` | listed under `imagegen` |
| **VS Code** (Copilot agent mode) | `config vscode` → `.vscode/mcp.json` | listed under `imagegen` |
| **Windsurf** | `config windsurf` → `~/.codeium/windsurf/mcp_config.json` | listed under `imagegen` |
| **Gemini CLI** | `config gemini` → `~/.gemini/settings.json` | listed under `imagegen` |

Every client needs two things:

1. **The launch command.** After the [one-line install](../README.md#quick-start) (or `npm link` from a checkout) it's `codex-imagegen-mcp serve`; straight from a checkout it's `node /path/to/codex-imagegen-mcp/dist/src/cli.js serve`. `codex-imagegen-mcp config <client>` prints the exact snippet for your machine, with absolute paths where a GUI app needs them.
2. **Optionally, the Agent Skill** in `skill/imagegen-mcp/`. It teaches the agent the prompting and save-path workflow. Clients without skill support can read the same content from the server as `imagegen://skill/SKILL.md`, and the essentials are also in the server's MCP instructions.

Then sign in once with `codex-imagegen-mcp login`, unless Codex or opencode is already signed in with ChatGPT. See [Authentication](AUTH.md).

## opencode (automated)

```bash
codex-imagegen-mcp install opencode              # global: ~/.config/opencode/opencode.json[c] + skills/imagegen
codex-imagegen-mcp install opencode --project    # this project only: ./opencode.json + .opencode/skills/imagegen
codex-imagegen-mcp install opencode --dry-run    # show what would change
codex-imagegen-mcp uninstall opencode            # remove the entry and the skill it installed
```

The installer adds this entry, editing with `jsonc-parser` so comments, formatting and your other servers stay exactly as they were:

```jsonc
"mcp": {
  "imagegen": {
    "type": "local",
    "command": ["node", "/…/dist/src/cli.js", "serve"],
    "enabled": true,
    "timeout": 300000
  }
}
```

> [!NOTE]
> opencode applies `timeout` to **every** MCP request, tool calls included, and resets it on each progress notification. 300 s is a safe ceiling.

What the installer does, and what it refuses to do:

- **Backs up first.** The previous config is saved to `opencode.json.codex-imagegen-mcp.bak`.
- **Won't clobber a stranger.** If another server already uses the name, it refuses unless you pass `--force`; `--name` picks a different name.
- **Owns only what it installed.** The skill is copied to `~/.config/opencode/skills/imagegen` with a marker file, so `uninstall` removes only a copy it created.
- **Warns about duplicates.** opencode resolves duplicate skill names unpredictably, so the installer warns if another `imagegen` skill exists anywhere opencode looks: `~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skill[s]`, `~/.opencode/skill[s]` and the project equivalents.

```bash
opencode mcp list                    # ✓ imagegen connected
opencode run "Make a 16:9 hero image of a lighthouse at dusk and save it to assets/hero.png"
```

- **Where files land:** opencode starts the server in the project directory and reports it as an MCP root, so relative `output_path`s land in the project.
- **Previews reach vision models on every provider.** With OpenAI models over ChatGPT, previews travel inside the tool result. GitHub Copilot and other providers receive them as a follow-up attachment. Both paths are verified with `openai/gpt-5.5` and `github-copilot/claude-sonnet-5`.
- **Options:** `--env KEY=VALUE` (repeatable) sets environment variables, for example `--env CODEX_IMAGEGEN_OUTPUT_DIR=~/Pictures/ai`. `--command "…"` overrides the launch command.

## Claude Code

```bash
claude mcp add --scope user imagegen -- node /path/to/codex-imagegen-mcp/dist/src/cli.js serve
mkdir -p ~/.claude/skills && cp -R /path/to/codex-imagegen-mcp/skill/imagegen ~/.claude/skills/
```

- Tools appear as `mcp__imagegen__generate_image`, and so on.
- Generation takes 15–60 s. If you hit tool timeouts, start Claude Code with `MCP_TOOL_TIMEOUT=300000`.

> [!WARNING]
> opencode also reads `~/.claude/skills`. If you install the skill for both, keep only **one** copy, or keep the copies identical.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "imagegen": { "command": "/opt/homebrew/bin/node", "args": ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"] }
  }
}
```

- **Use absolute paths.** GUI apps don't inherit your shell `PATH`; `codex-imagegen-mcp config claude-desktop` prints the right ones.
- **Pass absolute `output_path`s.** Claude Desktop starts servers with `/` as the working directory. Without an `output_path`, images go to the image library.

## Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{ "mcpServers": { "imagegen": { "command": "node", "args": ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"] } } }
```

## VS Code (GitHub Copilot agent mode)

Add to `.vscode/mcp.json`, or run **MCP: Open User Configuration**:

```json
{ "servers": { "imagegen": { "type": "stdio", "command": "node", "args": ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"] } } }
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{ "mcpServers": { "imagegen": { "command": "/opt/homebrew/bin/node", "args": ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"] } } }
```

## Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{ "mcpServers": { "imagegen": { "command": "node", "args": ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"], "timeout": 300000 } } }
```

## OpenAI Codex (CLI and IDE)

When Codex is signed in with ChatGPT, it already has this capability built in (`image_gen`), so this entry is mainly useful for API-key Codex setups. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.imagegen]
command = "node"
args = ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"]
tool_timeout_sec = 300
```

## Any other client

Any MCP client that can launch a stdio server works: point it at `codex-imagegen-mcp serve`. For the best experience the client should:

- allow tool calls of at least about 90 s, or reset its timeout on progress notifications;
- support image content in tool results, so the model sees the preview. Without it, the model still gets the saved paths and metadata.

Skills: Claude Code reads `~/.claude/skills/`; clients that follow the Agent Skills convention read `~/.agents/skills/`; opencode reads the directories listed above.

---

<p align="center"><a href="AUTH.md">← Authentication</a> &nbsp;·&nbsp; <a href="README.md">Docs home</a> &nbsp;·&nbsp; <a href="BACKEND.md">Backend →</a></p>
