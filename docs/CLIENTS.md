# Installing in MCP clients

The server is a local **stdio** MCP server. Every client needs two things:

1. **The launch command.** Print the one for your setup with `codex-imagegen-mcp config <client>`. From a git checkout it is `node /path/to/codex-imagegen-mcp/dist/src/cli.js serve`; with a global install (`npm link` / `npm i -g`) it is `codex-imagegen-mcp serve`.
2. **Optionally, the Agent Skill** in `skill/imagegen/`. It teaches the agent the prompting and save-path workflow. Clients without skill support can read the same content from the server as `imagegen://skill/SKILL.md`, and the essentials are in the server's MCP instructions.

Then sign in once with `codex-imagegen-mcp login`, unless Codex or opencode is already signed in with ChatGPT; see [AUTH.md](AUTH.md).

## opencode (automated)

```bash
codex-imagegen-mcp install opencode              # global: ~/.config/opencode/opencode.json[c] + skills/imagegen
codex-imagegen-mcp install opencode --project    # this project: ./opencode.json + .opencode/skills/imagegen
codex-imagegen-mcp install opencode --dry-run    # show what would change
codex-imagegen-mcp uninstall opencode            # remove the entry and the skill it installed
```

**What the installer does:**
- Adds this entry, editing with `jsonc-parser` so comments, formatting and other servers are preserved:

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
  - opencode applies `timeout` to **every** MCP request, including tool calls, and resets it on progress notifications. 300 s is a safe ceiling.
  - It first backs up the file to `opencode.json.codex-imagegen-mcp.bak`.
  - It refuses to replace a different server that has the same name, unless you pass `--force` or pick another name with `--name`.
- Copies the skill to `~/.config/opencode/skills/imagegen`, with a marker so that uninstall only removes a copy it installed.
  - It warns if another skill named `imagegen` exists in any directory opencode scans (`~/.claude/skills`, `~/.agents/skills`, `~/.config/opencode/skill[s]`, `~/.opencode/skill[s]`, and the project equivalents). opencode resolves duplicate skill names unpredictably.

**Verify:**

```bash
opencode mcp list                    # ✓ imagegen connected
opencode run "Make a 16:9 hero image of a lighthouse at dusk and save it to assets/hero.png"
```

**Notes:**
- opencode starts the server in the project directory and reports it as an MCP root, so relative `output_path`s land in the project.
- Images returned by tools reach vision-capable models. For OpenAI models via ChatGPT they are sent inside the tool result; for GitHub Copilot and other providers, opencode attaches them as a follow-up message. Both were verified, with `openai/gpt-5.5` and `github-copilot/claude-sonnet-5`.
- Options: `--env KEY=VALUE` (repeatable) adds `environment` variables, for example `--env CODEX_IMAGEGEN_OUTPUT_DIR=~/Pictures/ai`. `--command "…"` overrides the launch command.

## Claude Code

```bash
claude mcp add --scope user imagegen -- node /path/to/codex-imagegen-mcp/dist/src/cli.js serve
mkdir -p ~/.claude/skills && cp -R /path/to/codex-imagegen-mcp/skill/imagegen ~/.claude/skills/
```

- Tools appear as `mcp__imagegen__generate_image` and so on.
- Image generation takes 15-60 s. If you hit tool timeouts, start Claude Code with `MCP_TOOL_TIMEOUT=300000`.
- opencode also reads `~/.claude/skills`. If you install the skill for both, keep only **one** copy, or keep them identical.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "imagegen": { "command": "/opt/homebrew/bin/node", "args": ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"] }
  }
}
```

- Use absolute paths: GUI apps don't inherit your shell `PATH`. `codex-imagegen-mcp config claude-desktop` prints the right ones.
- Claude Desktop starts servers with `/` as the working directory, so pass absolute `output_path`s. Without one, images go to the image library.

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

## OpenAI Codex CLI / IDE

When signed in with ChatGPT, Codex already has this capability built in (`image_gen`). This entry is only useful for API-key Codex setups. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.imagegen]
command = "node"
args = ["/path/to/codex-imagegen-mcp/dist/src/cli.js", "serve"]
tool_timeout_sec = 300
```

## Any other client

Any MCP client that can launch a stdio server works: run `codex-imagegen-mcp serve`. The client should:
- allow tool calls of at least about 90 s, or reset its timeout on progress notifications;
- ideally support image content blocks in tool results, so the model sees the preview. Without that, the model still gets the saved paths.

Skill directories by client:
- Claude Code: `~/.claude/skills/`
- opencode: see above
- clients following the Agent Skills convention: `~/.agents/skills/`
