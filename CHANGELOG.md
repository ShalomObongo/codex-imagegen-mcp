# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **On npm:** `npm install --global codex-imagegen-mcp`. 0.1.2 was published from the attested GitHub-release tarball. From now on the release workflow publishes each version through npm trusted publishing (OIDC): no tokens, and npm attaches signed provenance automatically.

## [0.1.2] - 2026-09-23

The project is public on GitHub, with automated, verifiable releases.

### Added
- **One-command install** from the latest GitHub release: `npm install --global https://github.com/ShalomObongo/codex-imagegen-mcp/releases/latest/download/codex-imagegen-mcp.tgz`.
- **Continuous integration.** Tests run on Node 22, 24 and 26 on Linux, plus macOS and Windows, with a job that packs the tarball, installs it globally and runs it.
- **Release automation.** Pushing a `vX.Y.Z` tag tests the code, checks the tag against `package.json`, and packs versioned and stable-named tarballs with `SHA256SUMS`. It signs a build-provenance attestation (`gh attestation verify`) and publishes the release with notes from this changelog, plus an announcement discussion.
- **Community files:** contributing guide, security policy (private vulnerability reporting, with the security model spelled out), Contributor Covenant 2.1, support guide, issue forms, a pull-request template and CODEOWNERS.
- **Dependabot** for npm and GitHub Actions. Actions are pinned to commit SHAs.

### Changed
- **Node.js 22 or newer is required.** Node 20 reached end of life in April 2026, and 22, 24 and 26 are what CI tests.
- The build is cross-platform: no `rm -rf` or `chmod`, so it works in Windows `cmd.exe`.
- `config claude-desktop` and `config windsurf` print an absolute node and script path. A global install's launcher needs `node` on the PATH, which GUI apps often lack.
- `package.json` has repository, homepage and bugs links, and more keywords.
- `.gitattributes` normalizes line endings to LF on every platform and marks the vendored upstream skill for language statistics.

### Fixed
- A usage-limit test could fail at random, because a reset time 2 hours away sometimes rendered as "1h 59m".
- Tests assumed POSIX path separators and a POSIX environment in child processes.

## [0.1.1] - 2026-09-23

A documentation redesign, illustrated entirely with the tool itself.

### Added
- **Artwork generated with codex-imagegen-mcp**, following the bundled `imagegen` skill and a seeded art-direction procedure (a 1930s WPA silkscreen travel poster in palette C07). It comprises a logo, a README hero, seven page banners, six feature badges, a social preview and three showcase sheets: 15 generations plus one local `remove_background`.
- `scripts/compose-doc-art.py`, which builds the committed assets from raw generations:
  - snaps the service's 251–254 alpha to 255;
  - typesets every title locally in a slab serif, so no generated text is used;
  - slices the badge grid, builds the showcase sheets and writes the social preview.
- `docs/README.md`, a documentation hub with visual cards.
- `docs/assets/README.md`: the art-direction record, an inventory, and every prompt verbatim, extracted from `history.jsonl`.
- Twelve Mermaid diagrams in the brand palette, readable on GitHub light and dark: credential resolution, the browser and device-code sign-in flows, lock-serialized refresh, the module map, the request flow, choosing a tool, the test harness and more.

### Changed
- README, TOOLS, AUTH, CLIENTS, BACKEND, ARCHITECTURE and DEVELOPMENT rewritten with poster banners, GitHub alerts, feature and doc-card grids, collapsible FAQ, configuration and troubleshooting sections, "on this page" navigation and previous/next footers.
- BACKEND: new measurements.
  - `21:9` produces 1916×821 and `1:1` produces 1254×1254.
  - Style-referenced edits keep the reference's look while following the new prompt.
  - `background: "opaque"` is a hint: the service returned alpha for a prompt about keying out a backdrop.
  - The quota cost of generating the documentation's 15 images is recorded.
- Tool and skill descriptions now say `background: "opaque"` *asks for* a filled background rather than forcing one.
- CLIENTS: an accurate support matrix. Codex names MCP tools `mcp__<server>__<tool>`, confirmed in the binary.
- `package.json`: the description no longer mentions an API-key backend, `main` now points at the real server module, and the artwork is excluded from the npm package.

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
- Live sign-in:
  - A real browser sign-in: auth.openai.com accepts `originator=codex-imagegen-mcp` with the minimal scopes.
  - A forced real refresh: the refresh token rotated and was persisted, giving a new 10-day access token.
  - A generation using only this tool's own token.
  - A real device-code request (`XXXX-XXXXX` code, 5 s interval).
- opencode 1.18.32: `opencode mcp list` shows the server connected, and the skill loads. Ran end to end with `openai/gpt-5.5` (skill → generate, transparent) and `github-copilot/claude-sonnet-5` (auth_status → 16:9 generate + transparent edit).

[Unreleased]: https://github.com/ShalomObongo/codex-imagegen-mcp/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/ShalomObongo/codex-imagegen-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/ShalomObongo/codex-imagegen-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ShalomObongo/codex-imagegen-mcp/releases/tag/v0.1.0
