# codex-imagegen-mcp

**OpenAI Codex's image generation, as an MCP server + Agent Skill for any coding tool.** Generate and edit images from opencode, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI, and other MCP clients, using your **ChatGPT subscription**. It is the same image service the Codex desktop app and CLI use for their built-in `image_gen` tool, so **no OpenAI API key and no pay-per-image billing** are involved.

```text
you › Make a transparent sticker of a cute cactus for this project, save it as assets/cactus-sticker.png

  ⚙ imagegen_generate_image  background=transparent  output_path=assets/cactus-sticker.png
  ✓ Generated 1 image in 43.6s — assets/cactus-sticker.png — 1254×1254 PNG, transparent background (alpha verified)
```

## Features

- **Five MCP tools:**
  - `generate_image`: text → image.
  - `edit_image`: edit an image, or generate from 1-5 references.
  - `remove_background`: local chroma-key cutout.
  - `auth_status`: sign-in state and quota.
  - `sign_in`: start a ChatGPT sign-in from inside the agent.
- **Signs in with ChatGPT** (browser PKCE or device code), the same OAuth flow as the Codex CLI. If you already use **Codex** or **opencode** with ChatGPT, it works immediately by *borrowing* that sign-in read-only.
- **Aspect ratios** (`16:9`, `9:16`, `1:1`, …), **real transparent PNGs**, **1-4 variants** in parallel, and JPEG output.
- **Project-aware saving.** Relative paths resolve to your workspace. Existing files are never overwritten; a `-2`, `-3` sibling is written instead.
- **Previews for the model.** A small JPEG preview (checkerboard for transparency) lets the agent check its work, while the full-resolution file stays on disk.
- **Long requests stay alive.** Progress notifications keep 15-60 s requests alive under client timeouts. Actionable errors cover sign-in, usage limits (with reset time), content policy and outages.
- **The Codex imagegen skill, adapted to these tools.** It covers prompt structure, a use-case taxonomy, edit invariants and a save-path policy. It is also exposed as MCP resources for clients without skill support.
- **One-command opencode install** that preserves comments and formatting in `opencode.json[c]`. Config snippets are included for 7 other clients.

## Requirements

- Node.js ≥ 20.
- A ChatGPT plan that includes Codex (Plus, Pro, Business, Enterprise, Edu, …). Codex image generation is **not available on the Free plan**.

## Quick start (opencode)

```bash
git clone <this repo> codex-imagegen-mcp && cd codex-imagegen-mcp
npm install && npm run build

node dist/src/cli.js install opencode   # adds the MCP server + skill to ~/.config/opencode
node dist/src/cli.js login              # sign in with ChatGPT (skip if Codex/opencode is already signed in)
node dist/src/cli.js doctor             # optional: verify everything
```

Restart opencode and check:

```bash
opencode mcp list        # → ✓ imagegen connected
```

Then just ask for images in any session. The tools show up as `imagegen_generate_image`, `imagegen_edit_image`, and so on.

> Run `npm link` once to get a global `codex-imagegen-mcp` command. The examples below use it; `node dist/src/cli.js` works the same way.

## Signing in

| You already have… | What happens |
|---|---|
| Codex CLI or the Codex app signed in with ChatGPT | Works out of the box: the server borrows `~/.codex/auth.json` **read-only**. |
| opencode signed in with *OpenAI → ChatGPT Plus/Pro* | Works out of the box: it borrows `~/.local/share/opencode/auth.json` read-only. |
| Neither, or you want an independent sign-in | Run `codex-imagegen-mcp login`, or ask the agent to call `sign_in`. |

```bash
codex-imagegen-mcp login            # opens the browser → sign in → "You're signed in"
codex-imagegen-mcp login --device   # headless/SSH: enter a code at auth.openai.com/codex/device
codex-imagegen-mcp status           # which account/plan/source is used + current usage windows
codex-imagegen-mcp logout           # remove (and revoke) this tool's own sign-in
```

**Security properties:**
- Tokens are stored `0600` in `~/.local/share/codex-imagegen-mcp/auth.json`.
- Refresh is serialized across processes, because OpenAI refresh tokens are single-use.
- Borrowed sign-ins are never refreshed or modified, so using this server can't sign you out of Codex or opencode.

All details are in [docs/AUTH.md](docs/AUTH.md).

## Tools

| Tool | Purpose | Key parameters |
|---|---|---|
| `generate_image` | New image from a prompt | `prompt`, `aspect_ratio`, `background`, `n`, `output_path`, `output_format` |
| `edit_image` | Edit or reference-guided generation | `images` (1-5 paths/URLs), `prompt` (+ same options) |
| `remove_background` | Local flat-background removal (no quota) | `input_path`, `key_color` (auto), `output_path` |
| `auth_status` | Sign-in, plan, credential source, usage windows | `check_usage` |
| `sign_in` | Start a ChatGPT sign-in and return a link/code for the user | `method` (`browser`/`device`) |

It also provides:
- **Resources:** `imagegen://history`, `imagegen://images/{id}` and `imagegen://skill/*`.
- **Prompts:** `generate` and `edit`.

The full reference is in [docs/TOOLS.md](docs/TOOLS.md).

**What the service decides.** The ChatGPT image backend ignores `model`, `size`, `quality`, `n` and `output_format`, and picks them itself. The canvas follows the prompt, which is why `aspect_ratio` is implemented as an explicit prompt line: `16:9` → 1672×941 and `9:16` → 941×1672. See [docs/BACKEND.md](docs/BACKEND.md) for the measurements, including tests of the newer `gpt-image-2.5-*` models.

## Command line

The same engine as the MCP tools, from your terminal:

```bash
codex-imagegen-mcp generate "a watercolor fox in a snowy forest" -a 16:9 -o art/fox.png
codex-imagegen-mcp generate "Image 1: add a tiny straw hat; keep everything else" -i assets/cactus.png -b transparent -o assets/cactus-hat.png
codex-imagegen-mcp remove-bg sprite-on-green.png -o sprite.png
codex-imagegen-mcp config claude-code        # print the setup for another client
```

## Other MCP clients

`codex-imagegen-mcp config <client>` prints a ready-to-paste config for `claude-code`, `claude-desktop`, `cursor`, `vscode`, `windsurf`, `codex` and `gemini`. The per-client guide, including where each client loads skills from, is in [docs/CLIENTS.md](docs/CLIENTS.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_IMAGEGEN_HOME` | `~/.local/share/codex-imagegen-mcp` | Credentials, history, logs, default image library |
| `CODEX_IMAGEGEN_OUTPUT_DIR` | `$CODEX_IMAGEGEN_HOME/images` | Where images go when no `output_path` is given |
| `CODEX_IMAGEGEN_CREDENTIALS` | `auto` | `auto` (own → Codex → opencode), or pin `own` / `codex` / `opencode` |
| `CODEX_IMAGEGEN_TIMEOUT_MS` | `300000` | Per-request timeout for the image service |
| `CODEX_IMAGEGEN_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` (log file: `$CODEX_IMAGEGEN_HOME/server.log`) |
| `CODEX_IMAGEGEN_NO_BROWSER` | unset | Never auto-open a browser |
| `CODEX_HOME` | `~/.codex` | Where to look for a Codex sign-in |
| `CODEX_IMAGEGEN_ORIGINATOR` | `codex-imagegen-mcp` | `originator` sent to OpenAI (identifies this client) |

These are intended for tests only: `CODEX_IMAGEGEN_BASE_URL`, `CODEX_IMAGEGEN_USAGE_URL`, `CODEX_IMAGEGEN_AUTH_ISSUER`, `CODEX_IMAGEGEN_CLIENT_ID`, `CODEX_IMAGEGEN_OPENCODE_AUTH_FILE`.

## Troubleshooting

Start with `codex-imagegen-mcp doctor`. It checks Node, the data directory, credentials, backend reachability and quota, the callback ports, the opencode entry and duplicate skills.

| Symptom | Fix |
|---|---|
| `Not signed in` | `codex-imagegen-mcp login` (or `--device`), or open Codex/opencode once so their sign-in refreshes |
| `usage limit … resets in …` | Wait for the reset; `status` shows the windows |
| `ports 1455 and 1457 are busy` | Another Codex/opencode login is running; finish it, or use `login --device` |
| `Device-code sign-in is not enabled` | ChatGPT → Settings → Security → enable device code authorization for Codex |
| Tool missing in opencode | `opencode mcp list`; re-run `install opencode`; restart opencode |
| Result is opaque despite `transparent` | Retry, or generate on a flat `#00ff00` backdrop and use `remove_background` |

## Documentation

- [docs/AUTH.md](docs/AUTH.md): how authentication works, flows, storage, security, troubleshooting
- [docs/TOOLS.md](docs/TOOLS.md): tools, outputs, resources, prompts, errors
- [docs/CLIENTS.md](docs/CLIENTS.md): setup for opencode and other MCP clients, plus skills
- [docs/BACKEND.md](docs/BACKEND.md): how Codex's image generation works, reverse-engineered and measured
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): code layout and design decisions
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): build, test, mock server, release checklist

## Disclaimer

This is an **unofficial** integration, not affiliated with or endorsed by OpenAI. It uses the same public OAuth client and internal ChatGPT backend endpoints as the Codex CLI (as opencode's ChatGPT sign-in does). Those endpoints are undocumented and may change without notice.

Usage counts against your ChatGPT plan's limits and is subject to OpenAI's Terms of Use and usage policies. Generated images carry OpenAI's C2PA provenance metadata.

## License

Apache-2.0. The bundled skill is adapted from the OpenAI Codex imagegen skill (Apache-2.0); see [NOTICE](NOTICE).
