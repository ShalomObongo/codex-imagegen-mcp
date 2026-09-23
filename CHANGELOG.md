# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-23

First release.

### Added
- **MCP server** (stdio) with five tools:
  - `generate_image`, `edit_image`: the ChatGPT image service used by Codex's built-in `image_gen`.
  - `remove_background`: local chroma key.
  - `auth_status`: sign-in and quota.
  - `sign_in`: browser or device-code sign-in started from the agent.
- **Generation options:**
  - `aspect_ratio`, implemented as a prompt line; the service sizes the canvas from the prompt.
  - `background: transparent`, with alpha verification.
  - `n` 1-4 parallel variants.
  - JPEG output via local conversion.
  - Workspace-relative `output_path` that never overwrites.
  - Downscaled previews for the model.
- **Protocol features:**
  - Progress heartbeats, cancellation and partial-success handling.
  - Resources: `imagegen://history`, `imagegen://images/{id}`, `imagegen://skill/*`.
  - Prompts: `generate`, `edit`.
  - Concise server instructions.
- **Authentication:**
  - Sign-in: ChatGPT OAuth, browser (PKCE, loopback 1455/1457) and device code, using the Codex public client.
  - Tokens: a 0600 atomic store, and lock-serialized refresh of the rotating refresh tokens.
  - Sign-out revokes the refresh token.
  - Existing Codex and opencode ChatGPT sign-ins are borrowed read-only.
- **CLI:** `serve`, `login`, `logout`, `status`, `generate`, `remove-bg`, `install`/`uninstall` (opencode), `config` (8 clients), `doctor`.
- **opencode installer:** JSONC-preserving config edits with backup, skill installation with an ownership marker, and duplicate-skill detection.
- **`imagegen` Agent Skill** adapted from Codex's system skill (Apache-2.0) for the MCP tools, plus a tools reference.
- **Documentation:** README, AUTH, TOOLS, CLIENTS, BACKEND (measured behavior, including gpt-image-2.5 tests), ARCHITECTURE, DEVELOPMENT.
- **Test suite** (74 tests) against a mock of OpenAI's OAuth server and the ChatGPT backend.

### Verified
- Live: generations (including 16:9 and 9:16), transparent generations and edits, usage endpoint, 4 concurrent requests.
- opencode 1.18.32: `opencode mcp list` shows the server connected, and the skill loads. Ran end to end with `openai/gpt-5.5` (skill → generate, transparent) and `github-copilot/claude-sonnet-5` (auth_status → 16:9 generate + transparent edit).
